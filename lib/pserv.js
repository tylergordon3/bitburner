/** @param {NS} ns @param {number} reserveMoney @param {number} spendFraction */
export async function managePurchasedServers(ns, reserveMoney = 5e6, spendFraction = 0.25) {
  const limit = ns.cloud.getServerLimit();
  if (limit <= 0) return false;

  const maxRam = ns.cloud.getRamLimit();
  const servers = ns.cloud.getServerNames();

  const money = ns.getPlayer().money;
  const spendable = money - reserveMoney;
  if (spendable <= 0) return null;

  let targetRam = 8;

  while (
    targetRam * 2 <= maxRam &&
    ns.cloud.getServerCost(targetRam * 2) < spendable * spendFraction
  ) {
    targetRam *= 2;
  }

  const cost = ns.cloud.getServerCost(targetRam);
  if (cost > spendable * spendFraction) return null;

  if (servers.length < limit) {
    const name = `cloud-${servers.length}`;
    const bought = ns.cloud.purchaseServer(name, targetRam);

    if (bought) {
      return {
        action: "Bought Server",
        detail: `${bought} (${ns.format.ram(targetRam)})`,
      };
    }
  }

  for (const server of servers) {
    const ram = ns.getServerMaxRam(server);
    if (ram >= targetRam) continue;

    const upgradeCost = ns.cloud.getServerUpgradeCost(server, targetRam);
    if (upgradeCost < 0) continue;
    if (upgradeCost > spendable * spendFraction) continue;
    
    const ok = ns.cloud.upgradeServer(server, targetRam);

    if (ok) {
      return {
        action: "Upgraded Server",
        detail: `${server} -> ${ns.format.ram(targetRam)}`,
      };
    }
  }

  return null;
}