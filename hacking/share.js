// hacking/share.js
//
// Trivial share worker. Each thread loops ns.share(), which for ~10s donates the
// thread's RAM to your factions and multiplies faction-WORK reputation gain by
//   1 + ln(effectiveShareThreads) / 25
// summed across every sharing thread on the network (Bitburner's own formula,
// src/NetworkShare/Share.ts). hacking/manager.js decides how many threads to run
// and on which servers (see CONFIG.share) - this file just keeps sharing.
//
// No imports, so the manager can scp this single file anywhere. Per-thread RAM is
// 1.6 (base) + 2.4 (ns.share) = 4.0GB.

/** @param {NS} ns */
export async function main(ns) {
  while (true) {
    await ns.share();
  }
}
