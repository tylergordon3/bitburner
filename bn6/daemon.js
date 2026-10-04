// bn6/daemon.js
//
// BN6 ("Bladeburners") orchestrator. The strategy lives in the shared
// lib/blade-daemon.js (BN7 runs the same engine with harsher tuning); what this
// node owns is BITNODE[6] in lib/config.js.
//
// BN6 cuts hacking hard (HackingLevelMultiplier 0.35, reduced hack exp and
// server money) and doubles the world daemon's hacking requirement, so the
// usual finish is a very long way off. What it hands you instead is the
// BLADEBURNER division: contracts pay money, rank pays Bladeburners faction
// reputation and skill points, and the last black op - Operation Daedalus -
// ends the BitNode without going near w0r1d_d43m0n.
//
// Finishing: the next node is the shared plan (a daemon arg such as
// `run bn6/daemon.js 7`, else `campaign.order` in lib/config.js). When the plan
// has nothing left it is the halt sentinel: every black op but Daedalus runs and
// the loop announces it's ready. With a next node and the HUD's FINISH on,
// Daedalus runs and lib/finish-bn.js enters it.

import { forNode } from "../lib/config.js";
import { runBladeDaemon } from "../lib/blade-daemon.js";

/** @param {NS} ns */
export async function main(ns) {
  await runBladeDaemon(ns, forNode(6));
}
