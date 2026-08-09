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
// corp never touches any of it. All Netscript-heavy calls (createCorporation,
// getInvestmentOffer, ...) live in the exec'd helper scripts, not here - this
// module only launches/keeps them alive, so it stays cheap on the daemon's RAM.

import { forNode } from "./config.js";
import { allServers } from "./net.js";
import { ensureHelper, placeManager } from "./daemon-lib.js";

/**
 * Ensure the corporation gets created, without carrying corporation.create-
 * Corporation (20GB) on home: while we have no corp, keep a one-shot creator
 * running off-home. Returns a status object the first time a corp appears
 * (surfaced on the dashboard), else null. hasCorporation() is free (0GB), so
 * this stays cheap. No-op when corp is disabled for this node.
 * @param {NS} ns
 */
export function maybeSetupCorp(ns) {
  const cfg = forNode(ns.getResetInfo().currentNode);
  const CO = cfg.corp;
  if (!CO.enabled) return null;

  if (!ns.corporation.hasCorporation()) {
    ensureHelper(ns, cfg.paths.corpCreate, { optional: true });
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
const BUILD_PHASES = ["corpExpand", "corpOffice", "corpMarket", "corpInvest"];

// Rotation cursor. Module-level is safe: this module lives inside the daemon,
// which is a single long-lived process; a daemon restart just restarts the cycle.
let _phase = 0;

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
  ensureHelper(ns, cfg.paths[key], { optional: true });
}
