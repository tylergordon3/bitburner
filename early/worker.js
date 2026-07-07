// early/worker.js

/** @param {NS} ns */
export async function main(ns) {
  // Default to n00dles: always rootable and hackable at hacking level 1, so a
  // cold-start spray of this worker never crashes on an out-of-reach target.
  const target = String(ns.args[0] ?? "n00dles");

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