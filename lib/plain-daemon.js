// lib/plain-daemon.js
//
// The plain run: no node-specific mechanic to chase, just the loop every other
// daemon adds to - join factions, earn reputation and money, buy augmentations,
// install, repeat until The Red Pill is in and w0r1d_d43m0n can be hacked. The
// loop itself (invites, rooting, the off-home helpers, aug buying, the install
// policy) is lib/daemon-core.js runDaemon; the shared aug flow (train -> rep ->
// money -> buy) is decideAugFlow there too. What this file owns is the ORDER of
// the strategy prefix: travel for a ready faction, the early bootstrap, program
// creation, then the aug target.
//
// Three users, one engine:
//   bn1/daemon.js - BN1, which has nothing to work around.
//   bn4/daemon.js - BN4, the same loop under BN4's multipliers.
//   challenge runs - a node entered with its own mechanic switched off (no gang
//     in BN2, no corporation in BN3, no Bladeburner in BN6/7, no hacknet in BN9):
//     CHALLENGE in lib/config.js points those runs at bn1/daemon.js, which hands
//     this the config of the node it finds itself in. Whatever the player's
//     Source-Files still allow there (sleeves, a gang, a corporation, IPvGO) is
//     started by the core as in any other node.

import {
  doEarlyBootstrapIfNeeded,
  maybeCreatePrograms,
  maybeAutoTravelForReadyFaction,
} from "./player-actions.js";
import { getNextAugTarget } from "./aug-targets.js";
import { maybeBuyInfra } from "./daemon-lib.js";
import { runDaemon, decidePrelude, decideNoTarget, decideAugFlow } from "./daemon-core.js";

/**
 * @param {NS} ns
 * @param {ReturnType<typeof import("./config.js").forNode>} cfg - the run's config
 */
export async function runPlainDaemon(ns, cfg) {
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
    return decideAugFlow(ns, { cfg, target, infra, opportunities, incomeLabel: "Hacking" });
  }

  await runDaemon(ns, {
    cfg,
    self: cfg.paths.daemon,   // this daemon's path (post-reset callback)
    decide: decideNextPriority,
  });
}
