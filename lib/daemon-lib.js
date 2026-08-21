// lib/daemon-lib.js
//
// Shared core for the per-BitNode daemons (bn2/bn3/bn4/bn5/bn10). Everything in
// here was, at some point, copy-pasted into every daemon; hoisting it means a fix
// lands in all five at once instead of in whichever one you remembered.
//
// What lives here is the machinery that is genuinely identical everywhere: rooting
// and darkweb purchases, accepting invites, placing off-home helpers, the gang
// manager's placement, faction work, buying augs, the install policy, and the
// purchased-server budget. What each daemon still owns is the part that actually
// differs - decideNextPriority (the node's strategy), maybeSetupGang (BN2's -9
// shortcut vs BN5's active karma grind vs everyone else's passive snap-up),
// plannedNextBN, and main()'s wiring.
//
// Where a node used to differ only by an ACCIDENT of when the code was copied, the
// merged version takes the most capable variant - so every node now records its
// faction work for the sleeve manager, skips its gang's faction when banking
// secondary rep, and reserves home RAM for the gang manager.
//
// RAM note: importing these instead of inlining them does NOT change a daemon's
// RAM cost (Bitburner sums Netscript calls across the whole import closure either
// way). The RAM savings come from the off-home helper scripts (lib/backdoor.js,
// lib/econ.js, lib/sleeves.js, ...) that each daemon exec's, not from this file.

import { allServers, root } from "./net.js";
import { shouldJoinCityFaction } from "./aug-targets.js";
import { managePurchasedServers } from "./pserv.js";
import { shouldFocus, focusFlag, recordFactionWork } from "./player-actions.js";
import { CONFIG } from "./config.js";
import { emitEvent } from "./events.js";
import { toggleEnabled } from "./toggles.js";

const HOME = CONFIG.paths.home;
// CONFIG (not forNode) is correct for all three: no BITNODE entry overrides augs,
// infra or player, so every node resolves them to the same values. If one ever does,
// these have to become forNode(ns.getResetInfo().currentNode) lookups - see the
// "Adding a BitNode override" note in lib/config.js.
const AUGS = CONFIG.augs;
const INFRA = CONFIG.infra;

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
 * The AUTO-FINISH preference: true (the default) means the daemon may destroy
 * w0r1d_d43m0n once everything's backdoored, false means it does everything else
 * exactly as normal but leaves the world daemon standing.
 *
 * Persisted (lib/toggles.js) more carefully than most settings would warrant,
 * because the thing it holds back is irreversible and unattended: an aug install
 * wipes globalThis, and a toggle that quietly reverted to ON could beat the node
 * hours later while the player is away.
 * @param {NS} ns
 */
export function autoFinishEnabled(ns) {
  return toggleEnabled(ns, { key: "gordAutoFinish", file: CONFIG.paths.autoFinishFile });
}

/**
 * Stop the finisher if it's running. Needed because the toggle can be flipped AFTER
 * lib/finish-bn.js was launched, and that script loops waiting for its moment - so
 * leaving it alive would beat the node anyway, several ticks after the player told
 * us not to.
 * @param {NS} ns
 */
function stopFinisher(ns) {
  for (const host of allServers(ns)) {
    if (!ns.hasRootAccess(host)) continue;
    if (!ns.scriptRunning(CONFIG.paths.finishBn, host)) continue;
    ns.scriptKill(CONFIG.paths.finishBn, host);
    ns.print(`Auto-finish held - stopped ${CONFIG.paths.finishBn} on ${host}.`);
  }
}

/**
 * Launch the backdoor helper, and - only once it reports the world daemon
 * backdoored, and only if we're actually allowed to finish - the BitNode finisher.
 *
 * These are two scripts rather than one because of RAM: the finisher's
 * destroyW0r1dD43m0n is 32GB, and while they shared a file that whole cost had to
 * be free somewhere before ANY backdoor could be installed. Since backdoors are
 * what unlock CyberSec/NiteSec/The Black Hand/BitRunners, that starvation quietly
 * cost a run its hacking factions. Call this BEFORE the botnet manager in a
 * daemon's tick so the (now small) backdoor loop claims RAM ahead of workers.
 *
 * Two independent things can hold the finish back, and both leave everything else
 * running normally: the NODE'S OWN PLAN (nextBN <= 0 - e.g. BN10, where the point is
 * to stay and finish the sleeve roster) and the HUD's FINISH toggle, which is the
 * player saying "not yet" about any node. In BOTH cases lib/backdoor.js normally goes
 * on to backdoor w0r1d_d43m0n, which makes the finish a one-click decision later - but
 * note that is not a free step: on the world daemon a backdoor IS the finish. A node
 * that must not end by itself therefore also sets backdoor.skipFinalHost (BN10), which
 * takes the final host off the backdoor list and makes finalReady permanently false,
 * so this function never gets as far as launching anything.
 *
 * @param {NS} ns
 * @param {number} nextBN   BitNode to enter when the world daemon falls; <= 0 is
 *                          the halt sentinel ("backdoor everything, finish by hand").
 * @param {string} [cbScript] script to run in the next node (defaults to the driver).
 */
export function ensureBackdoorHelpers(ns, nextBN, cbScript) {
  ensureHelper(ns, CONFIG.paths.backdoor);

  const autoFinish = autoFinishEnabled(ns);

  // Kill any finisher FIRST, before the gordBackdoorState gate below. That gate
  // exists to decide whether to LAUNCH one, but it guarded the STOP as well, so a
  // finisher already waiting on hacking level went untouched whenever lib/backdoor.js
  // wasn't alive to publish state (RAM starvation, a purchased server churned out
  // from under it, a reload that restored the finisher but not the publisher). The
  // toggle being off is reason enough to stop, always - and lib/finish-bn.js now
  // also refuses to fire on its own if it somehow outlives us.
  if (!autoFinish) stopFinisher(ns);

  const state = globalThis.gordBackdoorState;
  if (!state?.finalReady) return;

  const holdReason = !autoFinish ? "the HUD's FINISH toggle is off"
    : nextBN <= 0 ? "this node's plan is manual BitNode selection"
    : null;

  if (holdReason) {
    stopFinisher(ns);
    // Announce once PER REASON, so flipping the toggle off after the node was
    // already going to auto-continue still says so, instead of staying silent
    // because some earlier hold had claimed the latch.
    if (globalThis.gordAwaitingManualBN !== holdReason) {
      globalThis.gordAwaitingManualBN = holdReason;
      ns.tprint(`${state.finalHost} is backdoored and ready, but the finish is on hold: ${holdReason}. Destroy w0r1d_d43m0n yourself, or turn FINISH back on in the HUD.`);
      emitEvent(`[!] ${state.finalHost} backdoored - holding (${holdReason})`, "sys");
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

/**
 * Keep lib/gang.js (~36GB) running once we're in a gang, and publish the botnet
 * reservation for wherever it lives so hacking/manager.js and lib/pserv.js leave that
 * host alone. Adds the dedicated host to `reserved` when the manager sits on it.
 *
 * The home-RAM reservation is the part that matters. By mid-run the botnet has filled
 * every host including home, so without carving space out first a 36GB manager can
 * wait forever for a gap - which is exactly how a hand-created gang ends up with
 * nothing managing it. globalThis.gordReservedRam makes the botnet vacate that space
 * within a batch or two; it's cleared again the moment the manager is up, so the
 * botnet gets it straight back.
 *
 * Call BEFORE ensureCorpManagers so the gang host is reserved before the corp goes
 * looking for off-home RAM.
 * @param {NS} ns @param {Set<string>} reserved
 */
export function ensureGangManager(ns, reserved) {
  const script = CONFIG.paths.gang;

  if (!inGangSafe(ns)) {
    globalThis.gordReservedRam = {};
    globalThis.gordGangPending = false;
    return;
  }

  const running = allServers(ns).some(h => ns.hasRootAccess(h) && ns.scriptRunning(script, h));
  globalThis.gordReservedRam = running
    ? {}
    : { home: ns.getScriptRam(script, HOME) + CONFIG.gang.homeReserveSlack };

  placeManager(ns, script, CONFIG.gang.host, reserved);

  // Dashboard shows a "starting" card during the short wait before it lands.
  globalThis.gordGangPending = !allServers(ns).some(
    h => ns.hasRootAccess(h) && ns.scriptRunning(script, h)
  );
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

// ── Gang identity ─────────────────────────────────────────────────────────────

/** @param {NS} ns - true if we're in a gang; false (not just missing API) otherwise. */
export function inGangSafe(ns) {
  try {
    return ns.gang.inGang();
  } catch {
    return false;
  }
}

/**
 * The faction our gang belongs to, or null when we have no gang. Read from the state
 * lib/gang.js publishes, so it costs nothing beyond the inGang check and is simply
 * empty until the manager is up - callers treat that as "no gang" for a tick or two.
 *
 * Worth knowing because a gang faction's reputation accrues PASSIVELY from respect
 * and workForFaction isn't even offered for it, so every "should I work this faction?"
 * decision has to skip it.
 * @param {NS} ns
 */
export function gangFactionName(ns) {
  return inGangSafe(ns) ? globalThis.gordGangState?.faction ?? null : null;
}

// ── Faction work ──────────────────────────────────────────────────────────────

/**
 * Start the best available faction work, and publish which faction we're grinding
 * (recordFactionWork) so off-home helpers can line up behind it - lib/sleeves.js puts
 * any sleeve too weak to crime onto FIELD WORK for the same faction.
 * @param {NS} ns @param {string} faction @returns {string|null} the work type that took
 */
export function startBestFactionWork(ns, faction) {
  for (const type of CONFIG.player.factionWorkTypes) {
    const ok = ns.singularity.workForFaction(
      /** @type {any} */ (faction),
      /** @type {any} */ (type),
      focusFlag(ns)
    );
    if (ok) {
      recordFactionWork(faction, type);
      return type;
    }
  }
  return null;
}

/**
 * When our primary goal doesn't need the player's focus, bank reputation with a
 * SECONDARY faction that still has augs we'll want later - free progress out of a
 * work slot that would otherwise idle. Returns a one-line description, or null.
 *
 * Skips the gang's own faction (its rep is passive - see gangFactionName) and any
 * faction whose remaining augs we either own, can't afford the prerequisites for, or
 * already have the reputation for.
 * @param {NS} ns @param {string} primaryFaction - skip this one; we're already on it
 */
export function maybeDoSecondaryFactionWork(ns, primaryFaction) {
  if (shouldFocus(ns)) return null; // can't background work

  const s = ns.singularity;
  const owned = new Set(s.getOwnedAugmentations(true));
  const joined = ns.getPlayer().factions ?? [];
  const ourGangFaction = gangFactionName(ns);

  for (const factionName of joined) {
    if (factionName === primaryFaction) continue;
    if (factionName === ourGangFaction) continue; // gang rep is passive (from respect)

    const augs = s.getAugmentationsFromFaction(/** @type {any} */ (factionName));
    const currentRep = s.getFactionRep(/** @type {any} */ (factionName));

    const hasUsefulWork = augs.some(aug => {
      if (aug === AUGS.neuroFlux) return false;
      if (owned.has(aug)) return false;
      const prereqs = s.getAugmentationPrereq(aug);
      if (!prereqs.every(a => owned.has(a))) return false;
      return s.getAugmentationRepReq(aug) > currentRep;
    });

    if (!hasUsefulWork) continue;

    const workType = startBestFactionWork(ns, factionName);
    if (workType) return `Secondary: ${factionName} (${workType})`;
  }

  return null;
}

// ── Augmentations: buy, and decide when to install ────────────────────────────

/**
 * Buy every augmentation we can currently afford across our joined factions,
 * cheapest-first, with NeuroFlux Governor always last (its price and rep req climb
 * with each purchase, so spending on it early starves the real augs).
 *
 * Respects globalThis.gordMoneyFloor - the daemon raises it while hoarding cash for
 * a money-gated faction invite (Daedalus / The Covenant / Illuminati), where spending
 * below the line would cancel the very invite we're waiting on. Zero on nodes that
 * never hoard, so this is a no-op there.
 * @param {NS} ns @returns {string[]} human-readable descriptions of what we bought
 */
export function buyAugs(ns) {
  const s = ns.singularity;
  const owned = new Set(s.getOwnedAugmentations(true));
  const joined = ns.getPlayer().factions ?? [];
  const floor = globalThis.gordMoneyFloor ?? 0;

  const candidates = [];
  const purchases = [];

  for (const faction of joined) {
    for (const aug of s.getAugmentationsFromFaction(/** @type {any} */ (faction))) {
      if (canBuyAug(ns, faction, aug, owned)) {
        candidates.push({
          faction,
          aug,
          price: s.getAugmentationPrice(aug),
          rep: s.getAugmentationRepReq(aug),
        });
      }
    }
  }

  candidates.sort((a, b) => {
    const aNFG = a.aug === AUGS.neuroFlux ? 1 : 0;
    const bNFG = b.aug === AUGS.neuroFlux ? 1 : 0;
    if (aNFG !== bNFG) return aNFG - bNFG;
    return a.price - b.price;
  });

  for (const c of candidates) {
    // Re-checked per purchase: each buy spends money and raises the price multiplier
    // for everything still on the list.
    if (canBuyAug(ns, c.faction, c.aug, owned) && playerMoney(ns) - c.price >= floor) {
      if (s.purchaseAugmentation(/** @type {any} */ (c.faction), c.aug)) {
        purchases.push(`${c.aug} from ${c.faction}`);
        owned.add(c.aug);
      }
    }
  }

  return purchases;
}

/**
 * Install queued augmentations - a soft reset - when it's worth the lost progress.
 * Any ONE of these triggers it:
 *   - The Red Pill is queued (always; it's the BitNode key)
 *   - queuedThreshold augs are waiting
 *   - priorityQueuedThreshold are waiting AND one is an early-game priority aug
 *   - AGGRESSIVE: every priority aug is already installed and anything at all is
 *     queued. Past that point the reset's price-multiplier reset is worth more than
 *     the run time it costs
 *   - the run has lasted timeTriggerMs with something queued
 *
 * Never installs while hoarding for a money-gated invite: the reset drops our skills
 * below gates we've just met, and the pre-install NeuroFlux dump would spend the very
 * cash we're holding.
 * @param {NS} ns @param {string} selfScript - this daemon's path, relaunched after the reset
 */
export function maybeInstall(ns, selfScript) {
  if ((globalThis.gordMoneyFloor ?? 0) > 0) return;

  const s = ns.singularity;
  const ownedWithPurchased = s.getOwnedAugmentations(true);
  const ownedInstalled = s.getOwnedAugmentations(false);
  const queued = ownedWithPurchased.length - ownedInstalled.length;

  const priority = AUGS.installPriority;
  const hasRedPill = ownedWithPurchased.includes(AUGS.redPill);
  const hasPriorityAug = priority.some(
    a => ownedWithPurchased.includes(a) && !ownedInstalled.includes(a)
  );

  const allPriorityDone = priority.every(a => ownedInstalled.includes(a));
  const aggressiveInstall = allPriorityDone && queued >= AUGS.install.minQueued;

  const lastReset = readLastResetTime(ns);
  const elapsed = Date.now() - lastReset;
  const timeTriggered = queued >= AUGS.install.minQueued && elapsed >= AUGS.install.timeTriggerMs;

  const go = hasRedPill
    || queued >= AUGS.install.queuedThreshold
    || (queued >= AUGS.install.priorityQueuedThreshold && hasPriorityAug)
    || aggressiveInstall
    || timeTriggered;
  if (!go) return;

  if (timeTriggered) {
    ns.tprint(`Time-triggered install after ${(elapsed / 3_600_000).toFixed(1)}h with ${queued} aug(s) queued.`);
  }
  if (aggressiveInstall) {
    ns.tprint(`Aggressive install: all priority augs done, resetting with ${queued} queued.`);
  }

  // Dump remaining cash into NeuroFlux Governor right before resetting - money
  // doesn't survive the reset, and NFG levels do.
  const nfgFaction = (ns.getPlayer().factions ?? []).find(f =>
    s.getFactionRep(/** @type {any} */ (f)) >= s.getAugmentationRepReq(AUGS.neuroFlux)
  ) ?? null;
  if (nfgFaction) {
    let bought = true;
    while (bought) {
      if (playerMoney(ns) < s.getAugmentationPrice(AUGS.neuroFlux)) break;
      bought = s.purchaseAugmentation(/** @type {any} */ (nfgFaction), AUGS.neuroFlux);
    }
  }

  // Record what this reset installs + how long the run lasted, for the next boot's
  // journal. AFTER the NeuroFlux buys (so late NFG is counted) and BEFORE
  // writeResetTime (which overwrites the timestamp we need for the duration).
  // Guarded: a summary failure must never block the install.
  try {
    const installedSet = new Set(s.getOwnedAugmentations(false));
    const installing = s.getOwnedAugmentations(true).filter(a => !installedSet.has(a));
    recordResetSummary(ns, installing, Date.now() - readLastResetTime(ns));
  } catch (e) {
    ns.print(`reset summary failed: ${String(e)}`);
  }

  writeResetTime(ns);
  s.installAugmentations(selfScript);
}

/**
 * Grow the purchased-server fleet with whatever spending the current aug goal leaves
 * spare. Server RAM only multiplies hacking income, while cash buys augs outright, so
 * the budget scales down the closer we are to affording something:
 *   hoarding for an invite -> spend nothing
 *   no aug target          -> a modest slice of a free treasury
 *   blocked on REP         -> money's piling up anyway, so spend some surplus
 *   blocked on MONEY       -> only nibble at the shortfall, or report that we're saving
 * @param {NS} ns @param {any} target - the current aug target from getNextAugTarget
 */
export async function maybeBuyInfra(ns, target) {
  if ((globalThis.gordMoneyFloor ?? 0) > 0) {
    return { action: "Holding Cash", detail: "servers paused - saving for a faction invite" };
  }

  const money = playerMoney(ns);

  if (!target) {
    return await managePurchasedServers(ns, INFRA.noTarget.reserveMoney, INFRA.noTarget.spendFraction);
  }

  const { price, moneyMissing = 0, repMissing = 0 } = target;

  if (repMissing > 0) {
    const hardCap = money > price ? money - price : money * INFRA.repPending.fallbackCapFraction;
    return await managePurchasedServers(ns, INFRA.repPending.reserveMoney, INFRA.repPending.spendFraction, hardCap);
  }

  const tinyBudget = moneyMissing * INFRA.savingBudgetFraction;
  if (tinyBudget < INFRA.minBudget) {
    return {
      action: "Saving for Aug",
      detail: `${target.aug}: need $${ns.format.number(moneyMissing)}`,
    };
  }
  return await managePurchasedServers(ns, price, INFRA.savingSpendFraction, tinyBudget);
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
