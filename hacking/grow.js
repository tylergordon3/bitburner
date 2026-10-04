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

  // The delay goes to the game as additionalMsec rather than an ns.sleep here:
  // an action's duration is fixed when it STARTS, at the target's security at
  // that moment. Sleeping first meant starting later - possibly inside another
  // batch's hack->weaken window, where the security bump stretches the action
  // and it lands out of order. This way the duration locks at launch, when the
  // manager computed the delay from that same current duration.
  // Stock manipulation: a grow with { stock: true } nudges the forecast of the
  // stock tied to this server up. The trader (lib/stocks.js) publishes which
  // servers it wants pushed which way - `up` are the ones whose stock it is
  // long - and a list older than two minutes is nobody's wish any more. Free:
  // globalThis costs no RAM and the flag changes nothing else about the action.
  const wishes = globalThis.gordStockWishes;
  const stock = !!wishes && Date.now() - wishes.updatedAt < 120_000 && (wishes.up ?? []).includes(target);
  await ns.grow(target, { additionalMsec: delay, stock });
}