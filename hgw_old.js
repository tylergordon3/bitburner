/** @param {NS} ns */
export async function main(ns) {
  const target = ns.args[0];
  const money_threshold = Math.floor(ns.getServerMaxMoney(target) * 0.75);
  const security_threshold = ns.getServerMinSecurityLevel(target) + 5;

  for (;;) {
        const money = ns.getServerMoneyAvailable(target);
        if (ns.getServerSecurityLevel(target) > security_threshold) {
            await ns.weaken(target);
        } else if (money < money_threshold) {
            await ns.grow(target);
        } else {
            await ns.hack(target);
        }
    }
}