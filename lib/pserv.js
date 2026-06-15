/**
 * @param {NS} ns
 * @param {number} reserveMoney  - Hard floor: never let balance drop below this.
 * @param {number} spendFraction - Max fraction of spendable money to use per call.
 * @param {number} hardSpendCap  - Optional absolute ceiling on what we'll spend this call.
 */
export async function managePurchasedServers(
  ns,
  reserveMoney = 5e6,
  spendFraction = 0.25,
  hardSpendCap = Infinity,
) {
  const limit = ns.cloud.getServerLimit();
  if (limit <= 0) return null;

  const maxRam = ns.cloud.getRamLimit();
  const servers = ns.cloud.getServerNames();

  const money = ns.getPlayer().money;
  const spendable = Math.min(
    (money - reserveMoney) * spendFraction,
    hardSpendCap,
  );
  if (spendable <= 0) return null;

  // Find the largest RAM tier we can afford within budget.
  let targetRam = 8;
  while (
    targetRam * 2 <= maxRam &&
    ns.cloud.getServerCost(targetRam * 2) <= spendable
  ) {
    targetRam *= 2;
  }

  const cost = ns.cloud.getServerCost(targetRam);
  if (cost > spendable) return null;

  // Buy a new slot before upgrading existing ones.
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
    if (upgradeCost < 0 || upgradeCost > spendable) continue;

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