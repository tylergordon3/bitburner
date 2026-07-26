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
//   - ensureCorpManagers(ns, reserved): keep the always-on operator
//     (lib/corp-steady.js) running on the reserved cloud-corp host, and run the
//     bounded structural buildout (lib/corp-build.js) as a periodic one-shot on
//     borrowed off-home RAM. Adds the corp host to the caller's `reserved` Set
//     and publishes it, so it cooperates with each daemon's own reservation
//     bookkeeping (see the callers).
//
// Both self-gate on forNode(node).corp.enabled, so a node that opts out of the
// corp never touches any of it. All Netscript-heavy calls (createCorporation,
// getInvestmentOffer, ...) live in the exec'd helper scripts, not here - this
// module only launches/keeps them alive, so it stays cheap on the daemon's RAM.

import { forNode } from "./config.js";
import { allServers } from "./net.js";
import { ensureHelper, placeManager } from "./daemon-lib.js";

/** The resolved corp config for the current BitNode (0GB: getResetInfo is free). */
function corpCfg(ns) {
  return forNode(ns.getResetInfo().currentNode).corp;
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

/**
 * Keep the always-on corp operator on the reserved cloud-corp host and run the
 * structural buildout one-shot. Adds the corp host to the caller-owned `reserved`
 * Set (via placeManager) and republishes globalThis.gordReservedHosts, so the
 * corp-build one-shot below - and the botnet - avoid the corp host. Callers rebuild
 * `reserved` fresh each tick, so stale reservations self-heal. No-op (clears
 * gordCorpPending) when corp is disabled or not yet created.
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
  // Publish the reservation BEFORE placing the build one-shot, so ensureHelper
  // (which honours gordReservedHosts) never lands corp-build on the corp host.
  globalThis.gordReservedHosts = reserved;
  globalThis.gordCorpPending =
    !allServers(ns).some(h => ns.hasRootAccess(h) && ns.scriptRunning(cfg.paths.corpSteady, h));

  // Periodic structural buildout as a one-shot on borrowed off-home RAM (never a
  // reserved host). It exits after each pass; ensureHelper relaunches it next tick
  // until buildout converges, then each pass is a quick no-op. optional: it waits
  // quietly when no off-home host is roomy enough (early game).
  ensureHelper(ns, cfg.paths.corpBuild, { optional: true });
}
