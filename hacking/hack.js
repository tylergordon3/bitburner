// hacking/hack.js
//
// Trivial timed HGW worker: hack the target once, after an optional delay.
// hacking/manager.js scp's this to every rooted host and runs N threads with args
// [target, delayMs] so the hack leg LANDS at its scheduled moment - the delay
// staggers it behind the batch's weaken/grow legs (see launchBatch). No imports,
// so it copies anywhere. Per-thread RAM: 1.6 (base) + 0.1 (ns.hack) = 1.7GB.

/** @param {NS} ns */
export async function main(ns) {
  const target = String(ns.args[0]);
  const delay = Number(ns.args[1] ?? 0);

  if (delay > 0) await ns.sleep(delay);
  await ns.hack(target);
}