/** @param {NS} ns */
export async function managePurchasedServers(ns, reserveMoney = 5e6) {
  const limit = ns.cloud.getServerLimit();
  if (limit <= 0) return false;

  const maxRam = ns.cloud.getRamLimit();
  const servers = ns.cloud.getServerNames();

  let targetRam = 8;

  while (
    targetRam * 2 <= maxRam &&
    ns.cloud.getServerCost(targetRam * 2) < ns.getPlayer().money / 4
  ) {
    targetRam *= 2;
  }

  const cost = ns.cloud.getServerCost(targetRam);
  if (ns.getPlayer().money - cost < reserveMoney) return false;

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
    if (ns.getPlayer().money - upgradeCost < reserveMoney) continue;

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