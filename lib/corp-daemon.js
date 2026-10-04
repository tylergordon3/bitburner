// lib/corp-daemon.js
//
// Shared corporation orchestration for every per-BitNode daemon. Split out of
// bn3/daemon.js so the corp machinery is one implementation that all nodes reuse
// now that we have corp API access everywhere. Two entry points:
//
//   - maybeSetupCorp(ns): while there's no corp, keep the one-shot creator
//     (lib/corp-create.js) running off-home; it creates the corp and exits.
//     Returns a status event on the 0->1 transition (surfaced on the dashboard),
//     else null.
//
//   - ensureCorpManagers(ns, reserved): keep the two always-on scripts running -
//     the operator (lib/corp-steady.js) on the reserved cloud-corp host and the
//     small employee-upkeep loop (lib/corp-upkeep.js) wherever it fits - and run
//     the four bounded build phases (lib/corp-expand/office/market/invest.js) in
//     ROTATION, one per daemon tick, on borrowed off-home RAM. Adds the corp host
//     to the caller's `reserved` Set and publishes it, so it cooperates with each
//     daemon's own reservation bookkeeping (see the callers).
//
// The rotation is the low-RAM story: each phase is a one-shot that exits after a
// pass, so the manager's peak footprint is ONE phase (~120-200GB) instead of the
// old 490GB monolith - and the phases are ordered so that on a small network the
// most important work still lands first. On a host-starved early game the ladder
// degrades gracefully: upkeep (~62GB) usually places even when nothing else does,
// and it's the highest-value piece of the whole manager.
//
// Both self-gate on forNode(node).corp.enabled, so a node that opts out of the
// corp never touches any of it, and on the HUD's CORP toggle (corpAutoEnabled),
// which is the player saying "hands off, I'm running the corporation myself".
// All Netscript-heavy calls (createCorporation, getInvestmentOffer, ...) live in
// the exec'd helper scripts, not here - this module only launches/keeps them
// alive, so it stays cheap on the daemon's RAM.

import { CONFIG, forNode } from "./config.js";
import { allServers } from "./net.js";
import { ensureHelper, placeManager } from "./daemon-lib.js";
import { toggleEnabled } from "./toggles.js";
import { emitEvent } from "./events.js";

// Every script this module can launch, i.e. exactly what the CORP toggle turns
// off. Order doesn't matter - it's a kill list, not a rotation.
const CORP_SCRIPTS = [
  "corpCreate", "corpSteady", "corpUpkeep",
  "corpExpand", "corpOffice", "corpMarket", "corpInvest",
];

/**
 * The AUTO-CORP preference: true (the default) means the daemon runs the
 * corporation, false means it deploys nothing corp-related and kills whatever is
 * already running, leaving the whole corp to the player.
 *
 * Persisted (lib/toggles.js) for the same reason the other two are: an aug install
 * or a page reload wipes globalThis, and a manager quietly restarting itself hours
 * into a hand-run corp would undo exactly the thing this switch exists to allow.
 * @param {NS} ns
 */
export function corpAutoEnabled(ns) {
  return toggleEnabled(ns, { key: "gordCorpAuto", file: CONFIG.paths.autoCorpFile });
}

/**
 * Stop every corp script network-wide. Needed because the toggle can be flipped
 * long after the managers were placed, and they're loops on borrowed off-home RAM -
 * not launching them again would leave the running copies buying, hiring and
 * accepting investment offers under the player's hands. Killing is also what frees
 * the reserved cloud-corp host back to the botnet.
 *
 * Runs every tick while the toggle is off (cheap: scriptRunning is the only call
 * made per host) so a copy that somehow outlives the first sweep - a phase exec'd
 * by an older daemon, a helper restored by a reload - gets caught on the next one.
 * Only announces when it actually killed something.
 * @param {NS} ns
 */
function stopCorpScripts(ns, cfg) {
  let killed = 0;
  for (const host of allServers(ns)) {
    if (!ns.hasRootAccess(host)) continue;
    for (const key of CORP_SCRIPTS) {
      const script = cfg.paths[key];
      if (!ns.scriptRunning(script, host)) continue;
      ns.scriptKill(script, host);
      ns.print(`CORP toggle off - stopped ${script} on ${host}.`);
      killed++;
    }
  }
  if (killed) emitEvent(`[!] CORP toggle off - stopped ${killed} corp script(s)`, "sys");
}

/**
 * Ensure the corporation gets created, without carrying corporation.create-
 * Corporation (20GB) on home: while we have no corp, keep a one-shot creator
 * running off-home. Returns a status object the first time a corp appears
 * (surfaced on the dashboard), else null. hasCorporation() is free (0GB), so
 * this stays cheap. No-op when corp is disabled for this node.
 * @param {NS} ns
 */
export function maybeSetupCorp(ns) {
  const node = ns.getResetInfo().currentNode;
  const cfg = forNode(node);
  const CO = cfg.corp;
  if (!CO.enabled) return null;
  // The toggle is read (and so reconciled with disk) here, once per tick, before
  // ensureCorpManagers acts on it - the two entry points share the one flag.
  if (!corpAutoEnabled(ns)) return null;

  if (!ns.corporation.hasCorporation()) {
    ensureHelper(ns, cfg.paths.corpCreate, { optional: true, args: [node] });
    globalThis.gordHadCorp = false;
    return null;
  }

  // Only surface the event on a genuine 0->1 transition we watched this process
  // lifetime (gordHadCorp === false). After a soft reset the corp persists but
  // globalThis is wiped (undefined), so we must NOT report a spurious creation.
  const surface = globalThis.gordHadCorp === false;
  globalThis.gordHadCorp = true;
  return surface ? { action: "Corp Created", detail: CO.name } : null;
}

// The build phases, in rotation order. corp-invest goes LAST in each cycle of the
// rotation on purpose: it consumes the readiness flags the earlier phases publish
// (gordCorpExpandDone, gordCorpOfficeDone, gordCorpCheapestStep), so within one
// rotation the flags an acceptance decision reads are at most a cycle stale.
// corpInvest FIRST: it publishes gordCorpRound, which the other three read and
// default to round 1 without - so after a daemon restart they used to run a
// whole rotation against round-1 targets (re-ordering boosts, re-splitting jobs)
// before the publisher got its turn.
const BUILD_PHASES = ["corpInvest", "corpExpand", "corpOffice", "corpMarket"];

// Rotation cursor. Module-level is safe: this module lives inside the daemon,
// which is a single long-lived process; a daemon restart just restarts the cycle.
let _phase = 0;

// Consecutive rotation slots each build phase has failed to be placed in.
// Module-level for the same reason as the cursor.
/** @type {Record<string, number>} */
let _misses = {};

/**
 * Book-keep one rotation slot for a build phase and say whether to warn. Warns
 * on the warnAfter-th consecutive miss and every warnAfter-th after that, so a
 * starved phase is reported promptly and then periodically, not every tick; a
 * successful placement resets the count. Pure - exported for the tests.
 * @param {Record<string, number>} misses @param {string} key
 * @param {boolean} placed @param {number} warnAfter
 * @returns {{misses: Record<string, number>, warn: boolean}}
 */
export function notePhaseSlot(misses, key, placed, warnAfter) {
  const n = placed ? 0 : (misses[key] ?? 0) + 1;
  return {
    misses: { ...misses, [key]: n },
    warn: !placed && warnAfter > 0 && n >= warnAfter && n % warnAfter === 0,
  };
}

/**
 * Keep the always-on corp scripts running and advance the build-phase rotation by
 * one slot. Adds the corp host to the caller-owned `reserved` Set (via
 * placeManager) and republishes globalThis.gordReservedHosts, so the one-shots -
 * and the botnet - avoid the corp host. Callers rebuild `reserved` fresh each
 * tick, so stale reservations self-heal. No-op (clears gordCorpPending) when corp
 * is disabled or not yet created.
 * @param {NS} ns @param {Set<string>} reserved
 */
export function ensureCorpManagers(ns, reserved) {
  const cfg = forNode(ns.getResetInfo().currentNode);
  const CO = cfg.corp;

  if (!CO.enabled || !ns.corporation.hasCorporation()) {
    globalThis.gordCorpPending = false;
    return;
  }

  // Hands off: kill anything still running and place nothing. Note we deliberately
  // do NOT add CO.host to `reserved`, so cloud-corp goes back to the botnet while
  // the corp is hand-run.
  if (!corpAutoEnabled(ns)) {
    globalThis.gordCorpPending = false;
    stopCorpScripts(ns, cfg);
    return;
  }

  // Always-on operator on the reserved cloud-corp host.
  placeManager(ns, cfg.paths.corpSteady, CO.host, reserved);
  // Publish the reservation BEFORE placing anything else, so ensureHelper (which
  // honours gordReservedHosts) never lands a one-shot on the corp host.
  globalThis.gordReservedHosts = reserved;
  globalThis.gordCorpPending =
    !allServers(ns).some(h => ns.hasRootAccess(h) && ns.scriptRunning(cfg.paths.corpSteady, h));

  // Employee upkeep: always-on, tiny (~62GB), and the highest-value piece of the
  // manager - it keeps every office at max energy/morale even when nothing else
  // here can be placed, and keeps doing it while the player manages the corp by
  // hand. Before the phases so it wins any race for scarce RAM.
  ensureHelper(ns, cfg.paths.corpUpkeep, { optional: true });

  // One build phase per daemon tick, in rotation, on borrowed off-home RAM (never
  // a reserved host). Each is a one-shot that exits after a pass, so the manager's
  // peak footprint is one phase; a full rotation completes every 4 ticks (~60s),
  // which is what CONFIG.corp.materialBuySeconds is sized against. optional: a
  // phase that doesn't fit this tick just waits for its next slot.
  const key = BUILD_PHASES[_phase % BUILD_PHASES.length];
  _phase++;
  const script = cfg.paths[key];
  ensureHelper(ns, script, { optional: true });

  // Did it actually start? ensureHelper is silent for an optional helper, and a
  // phase that never finds RAM fails the same way every rotation: nothing is
  // built, the handshakes it publishes go stale, and the corp just stops - with
  // no line anywhere saying why. An exec'd script is still "running" at this
  // point (its main() doesn't start until this tick yields), so scriptRunning is
  // a reliable did-it-launch test even for a one-shot.
  const placed = allServers(ns).some(h => ns.hasRootAccess(h) && ns.scriptRunning(script, h));
  const slot = notePhaseSlot(_misses, key, placed, CO.phaseMissWarnRotations);
  _misses = slot.misses;
  if (slot.warn) {
    emitEvent(
      `[!] corp: ${script} has had no free RAM for ${_misses[key]} rotations ` +
      `(needs ${ns.format.ram(ns.getScriptRam(script, "home"))} off-home) - the buildout is stalled on it`,
      "sys",
    );
  }
}
