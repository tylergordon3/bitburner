// hacking/grow.js
//
// Trivial timed HGW worker: grow the target's money once, after an optional delay.
// hacking/manager.js scp's this to every rooted host and runs N threads with args
// [target, delayMs] so the grow leg LANDS at its scheduled moment within a batch
// (see launchBatch). No imports, so it copies anywhere. Per-thread RAM: 1.6 (base)
// + 0.15 (ns.grow) = 1.75GB.

/** @param {NS} ns */
export async function main(ns) {
  const target = String(ns.args[0]);
  const delay = Number(ns.args[1] ?? 0);

  if (delay > 0) await ns.sleep(delay);
  await ns.grow(target);
}