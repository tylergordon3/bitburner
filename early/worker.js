// early/worker.js
/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const target = String(ns.args[0] ?? "n00dles");

  while (true) {
    const money = ns.getServerMoneyAvailable(target);
    const maxMoney = ns.getServerMaxMoney(target);
    const sec = ns.getServerSecurityLevel(target);
    const minSec = ns.getServerMinSecurityLevel(target);

    if (sec > minSec + 5) {
      await ns.weaken(target);
    } else if (money < maxMoney * 0.75) {
      await ns.grow(target);
    } else {
      await ns.hack(target);
    }
  }
}