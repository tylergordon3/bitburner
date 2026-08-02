// lib/daemon-lib.js
//
// Shared core for the per-BitNode daemons (bn2/bn3/bn4). These helpers were
// byte-for-byte identical across all three daemons; hoisting them here removes
// that duplication so a fix lands everywhere at once. Each daemon still owns its
// BN-specific logic (decideNextPriority, maybeInstall, maybeBuyInfra, the corp/
// gang setup, main) - only the truly-shared plumbing lives here.
//
// RAM note: importing these instead of inlining them does NOT change a daemon's
// RAM cost (Bitburner sums Netscript calls across the whole import closure either
// way). The RAM savings come from the off-home helper scripts (lib/backdoor.js,
// lib/econ.js) that each daemon exec's, not from this file.

import { allServers, root } from "./net.js";
import { shouldJoinCityFaction } from "./aug-targets.js";
import { CONFIG } from "./config.js";
import { emitEvent } from "./events.js";

const HOME = CONFIG.paths.home;

/** Last time ensureHelper warned about each script it couldn't place. */
const _helperWarnedAt = new Map();

export function playerMoney(ns) {
  return ns.getPlayer().money ?? 0;
}

export function hackingLevel(ns) {
  return ns.getPlayer().skills?.hacking ?? ns.getHackingLevel();
}

/** @param {NS} ns @param {string} host */
export function freeRam(ns, host) {
  return ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
}

/**
 * Ensure a persistent helper is running SOMEWHERE with enough RAM - not just on
 * home. globalThis is shared across every host in Bitburner, so these helpers
 * work fine on any rooted server; running them off-home keeps scarce home RAM
 * for the daemon. We prefer the roomiest off-home host and only fall back to
 * home as a last resort. Warns (doesn't fail silently) when nothing has room,
 * unless { optional: true } is passed (luxury scripts wait quietly for RAM).
 * Extra exec args can be forwarded via { args } (e.g. the next BitNode +
 * callback script for lib/backdoor.js).
 * @param {NS} ns @param {string} script @param {{optional?: boolean, args?: any[]}} [opts]
 */
export function ensureHelper(ns, script, opts = {}) {
  // Already running anywhere (home included)? Leave it be.
  if (allServers(ns).some(h => ns.hasRootAccess(h) && ns.scriptRunning(script, h))) return;

  const ram = ns.getScriptRam(script, HOME);
  const reserved = globalThis.gordReservedHosts instanceof Set ? globalThis.gordReservedHosts : new Set();
  const args = opts.args ?? [];

  // Roomiest rooted non-home host first; home last (keep it for the daemon).
  const offHome = allServers(ns)
    .filter(s => s !== HOME && ns.hasRootAccess(s) && ns.getServerMaxRam(s) > 0 && !reserved.has(s))
    .sort((a, b) => freeRam(ns, b) - freeRam(ns, a));

  for (const host of [...offHome, HOME]) {
    // Leave room for the daemon's own work when falling back to home.
    const headroom = host === HOME ? CONFIG.helpers.homeHeadroom : 0;
    if (freeRam(ns, host) - headroom < ram) continue;
    // Copy every source file, not just the entry script: Bitburner resolves a
    // script's imports from the host it runs on, so the whole module closure has
    // to be present. Files cost no RAM, so shipping them all is simplest/safest.
    if (host !== HOME) ns.scp(ns.ls(HOME, ".js"), host, HOME);
    if (ns.exec(script, host, 1, ...args)) {
      ns.print(`Started ${script} on ${host}`);
      return;
    }
  }

  if (!opts.optional) {
    // Surface it. A required helper that can't find RAM used to fail into a
    // per-tick ns.print nobody reads - which is exactly how lib/backdoor.js went
    // an entire run without installing a single backdoor. Throttled so the
    // journal gets one line every helperWarnMs, not one every tick.
    const msg = `no host has ${ns.format.ram(ram)} free for ${script} (home ${ns.format.ram(freeRam(ns, HOME))} free)`;
    ns.print(`WARN: ${msg}`);
    const last = _helperWarnedAt.get(script) ?? 0;
    if (Date.now() - last >= CONFIG.helpers.warnMs) {
      _helperWarnedAt.set(script, Date.now());
      emitEvent(`[!] ${msg}`, "sys");
    }
  }
}

/**
 * Launch the backdoor helper, and - only once it reports the world daemon
 * backdoored - the BitNode finisher.
 *
 * These are two scripts rather than one because of RAM: the finisher's
 * destroyW0r1dD43m0n is 32GB, and while they shared a file that whole cost had to
 * be free somewhere before ANY backdoor could be installed. Since backdoors are
 * what unlock CyberSec/NiteSec/The Black Hand/BitRunners, that starvation quietly
 * cost a run its hacking factions. Call this BEFORE the botnet manager in a
 * daemon's tick so the (now small) backdoor loop claims RAM ahead of workers.
 *
 * @param {NS} ns
 * @param {number} nextBN   BitNode to enter when the world daemon falls; <= 0 is
 *                          the halt sentinel ("backdoor everything, finish by hand").
 * @param {string} [cbScript] script to run in the next node (defaults to the driver).
 */
export function ensureBackdoorHelpers(ns, nextBN, cbScript) {
  ensureHelper(ns, CONFIG.paths.backdoor);

  const state = globalThis.gordBackdoorState;
  if (!state?.finalReady) return;

  if (nextBN <= 0) {
    // Everything's backdoored, but this node's plan is manual BitNode selection
    // (e.g. BN10, where the whole point is to stay and finish the sleeve roster).
    // Announce once and leave w0r1d_d43m0n standing.
    if (!globalThis.gordAwaitingManualBN) {
      globalThis.gordAwaitingManualBN = true;
      ns.tprint(`${state.finalHost} is backdoored and ready. Auto-finish is off (manual BitNode selection) - destroy w0r1d_d43m0n yourself to pick the next node.`);
      emitEvent(`[!] ${state.finalHost} backdoored - destroy it yourself to pick the next BitNode`, "sys");
    }
    return;
  }

  globalThis.gordAwaitingManualBN = false;
  const args = cbScript ? [nextBN, cbScript] : [nextBN];
  ensureHelper(ns, CONFIG.paths.finishBn, { args });
}

/**
 * Buy/upgrade a dedicated cloud server to at least `needRam` (rounded up to the
 * next power of two, since purchased servers only come in those sizes). Spends
 * conservatively - at most CONFIG.cloudHost.spendFraction of cash - so it never
 * starves aug/program buys. Returns true once the host exists at sufficient size.
 * Shared by the corp/gang cloud-manager placement (see placeManager).
 * @param {NS} ns
 */
export function provisionCloudHost(ns, name, needRam) {
  const cloud = ns.cloud;
  if (cloud.getServerLimit() <= 0) return false;

  const maxRam = cloud.getRamLimit();
  let size = CONFIG.cloudHost.minRam;
  while (size < needRam && size < maxRam) size *= 2;
  if (size < needRam) return false; // even the largest tier can't hold it

  const exists = ns.serverExists(name);
  if (exists && ns.getServerMaxRam(name) >= needRam) return true;

  const budget = playerMoney(ns) * CONFIG.cloudHost.spendFraction;

  if (!exists) {
    if (cloud.getServerNames().length >= cloud.getServerLimit()) return false;
    if (cloud.getServerCost(size) > budget) return false;
    if (cloud.purchaseServer(name, size)) {
      ns.tprint(`Provisioned ${name} (${ns.format.ram(size)}).`);
      return true;
    }
    return false;
  }

  const cost = cloud.getServerUpgradeCost(name, size);
  if (cost < 0 || cost > budget) return false;
  if (cloud.upgradeServer(name, size)) {
    ns.tprint(`Upgraded ${name} -> ${ns.format.ram(size)}.`);
    return true;
  }
  return false;
}

/**
 * Place one big, persistent manager (corp or gang). If it's already running
 * anywhere, just note whether it's on its dedicated host (so we can reserve it
 * from the botnet). Otherwise provision the dedicated cloud host and launch it
 * there, falling back to the roomiest off-home host, then home. Adds the
 * dedicated host to `reserved` whenever the manager lives on it.
 * @param {NS} ns @param {Set<string>} reserved
 */
export function placeManager(ns, script, dedicatedHost, reserved) {
  const ram = ns.getScriptRam(script, HOME);

  const running = allServers(ns).find(h => ns.hasRootAccess(h) && ns.scriptRunning(script, h));
  if (running) {
    if (running === dedicatedHost) reserved.add(dedicatedHost);
    return;
  }

  provisionCloudHost(ns, dedicatedHost, ram);

  const offHome = allServers(ns)
    .filter(s => s !== HOME && s !== dedicatedHost && ns.hasRootAccess(s) && ns.getServerMaxRam(s) > 0 && !reserved.has(s))
    .sort((a, b) => freeRam(ns, b) - freeRam(ns, a));

  const candidates = [];
  if (ns.serverExists(dedicatedHost)) candidates.push(dedicatedHost);
  candidates.push(...offHome, HOME);

  for (const host of candidates) {
    const headroom = host === HOME ? CONFIG.helpers.homeHeadroom : 0;
    if (freeRam(ns, host) - headroom < ram) continue;
    if (host !== HOME) ns.scp(ns.ls(HOME, ".js"), host, HOME);
    if (ns.exec(script, host, 1)) {
      if (host === dedicatedHost) reserved.add(dedicatedHost);
      ns.print(`Started ${script} on ${host}`);
      return;
    }
  }

  ns.print(`WARN: waiting for ${ns.format.ram(ram)} to place ${script}`);
}

/** @param {NS} ns */
export async function buyDarkweb(ns) {
  const s = ns.singularity;

  if (!ns.hasTorRouter()) {
    if (playerMoney(ns) >= CONFIG.programs.torCost) s.purchaseTor();
    return;
  }

  for (const p of CONFIG.programs.portOpeners) {
    if (!ns.fileExists(p, HOME)) {
      const cost = s.getDarkwebProgramCost(/** @type {any} */ (p));
      if (cost > 0 && playerMoney(ns) >= cost) s.purchaseProgram(/** @type {any} */ (p));
    }
  }
}

/** @param {NS} ns */
export function rootEverything(ns) {
  for (const server of allServers(ns)) {
    if (server !== HOME) {
      try { root(ns, server); } catch {}
    }
  }
}

/**
 * Accept every pending faction invite. The only ones we ever decline are city
 * factions that would be a mistake right now - joining one permanently bans its
 * enemy cities, so shouldJoinCityFaction skips a city faction with nothing left to
 * offer, or one whose enemy is ALSO inviting us and offers more. Everything else,
 * including every hacking faction, is joined the moment the invite appears.
 *
 * The whole pending list is passed down so that comparison is made against
 * invites we can actually take today, not against every faction that might
 * theoretically invite us later (which used to decline all of them forever).
 * @param {NS} ns
 */
export async function acceptInvites(ns) {
  const pending = /** @type {string[]} */ (ns.singularity.checkFactionInvitations());

  for (const faction of pending) {
    if (!shouldJoinCityFaction(ns, faction, pending)) continue;
    if (ns.singularity.joinFaction(/** @type {any} */ (faction))) {
      ns.tprint(`Joined ${faction}.`);
      emitEvent(`[join] Joined ${faction}`, "faction", { factions: [String(faction)] });
    }
  }
}

/** @param {NS} ns */
export function canBuyAug(ns, faction, aug, owned) {
  const s = ns.singularity;
  if (owned.has(aug)) return false;

  const prereqs = s.getAugmentationPrereq(aug);
  if (!prereqs.every(a => owned.has(a))) return false;

  return (
    s.getFactionRep(/** @type {any} */ (faction)) >= s.getAugmentationRepReq(aug) &&
    playerMoney(ns) >= s.getAugmentationPrice(aug)
  );
}

/** @param {NS} ns */
export function readLastResetTime(ns) {
  try {
    const raw = ns.read(CONFIG.paths.resetFile);
    const t = Number(raw);
    return isNaN(t) ? 0 : t;
  } catch {
    return 0;
  }
}

/** @param {NS} ns */
export function writeResetTime(ns) {
  ns.write(CONFIG.paths.resetFile, String(Date.now()), "w");
}

/**
 * Persist a one-shot summary of the reset we're about to perform, so the next
 * boot's journal can report "installed N augmentations after this run". Written
 * just before installAugmentations() (which wipes globalThis), then consumed once
 * on the following boot. Guarded by the caller so a summary failure can never
 * block the install itself.
 * @param {NS} ns
 * @param {string[]} augs   the augmentations being installed this reset
 * @param {number} sinceMs  duration of the run that just ended, in ms
 */
export function recordResetSummary(ns, augs, sinceMs) {
  const record = { at: Date.now(), augs: augs ?? [], sinceMs: sinceMs ?? 0 };
  ns.write(CONFIG.paths.resetSummaryFile, JSON.stringify(record), "w");
}

/**
 * Read and clear the reset summary written by the previous run's install (if
 * any). Returns { at, augs, sinceMs } once, then blanks the file so the same
 * reset is never reported twice. Returns null when there's nothing pending.
 * @param {NS} ns
 */
export function consumeResetSummary(ns) {
  try {
    const raw = ns.read(CONFIG.paths.resetSummaryFile);
    if (!raw) return null;
    const record = JSON.parse(raw);
    ns.write(CONFIG.paths.resetSummaryFile, "", "w"); // consume: report at most once
    return record && Array.isArray(record.augs) ? record : null;
  } catch {
    return null;
  }
}
