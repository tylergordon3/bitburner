// bn4/daemon.js
//
// BN4 ("The Singularity") orchestrator - and the REFERENCE node: no punishing
// multiplier overrides and no node-specific mechanic to chase, so it is the plain
// loop the others add to (a gang in BN2/BN5, the corp in BN3, sleeves + grafting
// in BN10). The loop itself - invites, rooting, the off-home helpers, aug buying,
// the install policy - is lib/daemon-core.js runDaemon; the shared aug flow
// (train -> rep -> money -> buy) is decideAugFlow there too. What this file owns
// is the ORDER of BN4's strategy prefix: travel for a ready faction, the early
// bootstrap, program creation, then the aug target.

import {
  doEarlyBootstrapIfNeeded,
  maybeCreatePrograms,
  maybeAutoTravelForReadyFaction,
} from "../lib/player-actions.js";
import { getNextAugTarget } from "../lib/aug-targets.js";
import { forNode } from "../lib/config.js";
import { maybeBuyInfra } from "../lib/daemon-lib.js";
import { runDaemon, decidePrelude, decideNoTarget, decideAugFlow } from "../lib/daemon-core.js";

// Every tunable value comes from lib/config.js, resolved for this BitNode.
const CFG = forNode(4);
const SELF = CFG.paths.daemon;                // this daemon's path (post-reset callback)

/** @param {NS} ns */
async function decideNextPriority(ns) {
  const opportunities = decidePrelude(ns);

  // Auto-hop to a city and back for any faction that's fully ready to join.
  // Cheap, instant, and takes priority over everything else this tick.
  const autoTravel = await maybeAutoTravelForReadyFaction(ns, opportunities);
  if (autoTravel) return { ...autoTravel, target: null, infra: null };

  // Early bootstrap (study to hack 50, mug for TOR/BruteSSH money).
  const bootstrap = await doEarlyBootstrapIfNeeded(ns);
  if (bootstrap) return { ...bootstrap, target: null, infra: null };

  // Program creation: more port openers = more rootable servers = more worker RAM.
  const programWork = await maybeCreatePrograms(ns);
  if (programWork) return { ...programWork, target: getNextAugTarget(ns), infra: null };

  const target = getNextAugTarget(ns);
  const infra = await maybeBuyInfra(ns, target);

  if (!target) return decideNoTarget(ns, { opportunities, infra });
  return decideAugFlow(ns, { cfg: CFG, target, infra, opportunities, incomeLabel: "Hacking" });
}

/** @param {NS} ns */
export async function main(ns) {
  await runDaemon(ns, {
    cfg: CFG,
    self: SELF,
    finishCallback: SELF,
    decide: decideNextPriority,
  });
}
