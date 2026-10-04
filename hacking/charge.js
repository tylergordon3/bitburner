// hacking/charge.js
//
// Trivial Stanek's Gift charge worker: charge one fragment after another, for
// ever. lib/stanek.js scp's this to the hosts it holds and runs ONE process per
// host with as many threads as fit, because a charge counts for its thread
// count (times the host's core bonus, 1 + (cores - 1) / 16) and a fragment's
// bonus is ln() of the BIGGEST single charge it has ever had - see
// lib/stanek-logic.js. A charge takes one second (200ms while the game has
// bonus time stored) and the RAM is simply held between charges, which is the
// point: hacking/manager.js plans the botnet around whatever is left.
//
// No imports, so it copies anywhere. Per-thread RAM: 1.6 (base) + 0.4
// (ns.stanek.chargeFragment) = 2.0GB. Everything else here is free.
//
// Args: fragment ROOTS as a flat list - x0 y0 x1 y1 ... - walked in order and
// repeated. A root is the (x, y) the game addresses a placed fragment by.
// `run hacking/charge.js -t 100 0 0` charges the fragment at 0,0 by hand. An odd
// trailing argument is ignored: the manager appends a serial number there, only
// to make each process's argument list unique.
//
// While lib/stanek.js is alive it publishes the list it currently wants on
// globalThis.gordStanekRotation (same flat shape, with a timestamp), and that
// takes precedence over the arguments - so the manager can re-order the charging
// as fragments fill up without restarting a single worker. Once that stamp is a
// minute old the manager is taken for dead and the arguments are used again.

/** @param {NS} ns */
export async function main(ns) {
  for (let i = 0; ; i += 2) {
    const live = globalThis.gordStanekRotation;
    const followed = live && Array.isArray(live.list) && live.list.length >= 2 && Date.now() - live.at < 60_000;
    const list = followed ? live.list : ns.args;
    const pairs = Math.floor(list.length / 2);
    if (i >= pairs * 2) i = 0;
    try {
      if (pairs === 0) throw new Error("no fragment to charge");
      await ns.stanek.chargeFragment(Number(list[i]), Number(list[i + 1]));
    } catch {
      // chargeFragment THROWS when there is no fragment at that root (the gift
      // is being re-laid) or the root is a booster. Wait a beat and carry on
      // with the next entry instead of dying and handing the RAM back.
      await ns.sleep(1_000);
    }
  }
}
