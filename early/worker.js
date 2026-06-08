// early/worker.js

/** @param {NS} ns */
export async function main(ns) {
  const target = String(ns.args[0] ?? "joesguns");

  while (true) {

    // Lower security first
    if (
      ns.getServerSecurityLevel(target) >
      ns.getServerMinSecurityLevel(target) + 5
    ) {
      await ns.weaken(target);
    }

    // Grow money next
    else if (
      ns.getServerMoneyAvailable(target) <
      ns.getServerMaxMoney(target) * 0.75
    ) {
      await ns.grow(target);
    }

    // Otherwise hack
    else {
      await ns.hack(target);
    }
  }
}