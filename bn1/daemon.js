// bn1/daemon.js
//
// BN1 ("Source Genesis") orchestrator, and the daemon of every CHALLENGE run whose
// node's own daemon is built around the thing the challenge forbids (see
// CHALLENGE in lib/config.js): the plain loop of lib/plain-daemon.js, played with
// the config of whichever node - and whichever kind of run - this turns out to be.
//
// That is why the config is resolved here, from the reset info, and not from a
// literal node number like the other bnN/daemon.js files: forReset() returns
// BITNODE[n] for the node in hand with the challenge overlay on top when the run
// was entered as one.

import { forReset } from "../lib/config.js";
import { runPlainDaemon } from "../lib/plain-daemon.js";

/** @param {NS} ns */
export async function main(ns) {
  await runPlainDaemon(ns, forReset(ns.getResetInfo()));
}
