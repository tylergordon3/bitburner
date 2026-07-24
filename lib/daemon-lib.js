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

const HOME = CONFIG.paths.home;

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
    ns.print(`WARN: no host has ${ns.format.ram(ram)} free for ${script} (home ${ns.format.ram(freeRam(ns, HOME))} free)`);
  }
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
 * Accept all pending faction invites, except city factions we should defer
 * (see shouldJoinCityFaction) - joining one permanently bans its enemy city
 * factions for the rest of the run, so we don't want to burn that on a city
 * whose augs we already have while other city factions still have augs to give.
 * @param {NS} ns
 */
export async function acceptInvites(ns) {
  for (const faction of ns.singularity.checkFactionInvitations()) {
    if (!shouldJoinCityFaction(ns, faction)) continue;
    ns.singularity.joinFaction(/** @type {any} */ (faction));
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
