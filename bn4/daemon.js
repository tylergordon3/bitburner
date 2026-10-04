// bn4/daemon.js
//
// BN4 ("The Singularity") orchestrator - and the REFERENCE node: no node-specific
// mechanic to chase, so it is the plain loop the others add to (a gang in BN2/BN5,
// the corp in BN3, sleeves + grafting in BN10). That loop is lib/plain-daemon.js,
// shared with bn1/daemon.js; BN4's own multipliers (script hacking pays a fifth,
// w0r1d_d43m0n wants three times the level) are BITNODE[4]'s business.

import { forNode } from "../lib/config.js";
import { runPlainDaemon } from "../lib/plain-daemon.js";

/** @param {NS} ns */
export async function main(ns) {
  await runPlainDaemon(ns, forNode(4));
}
