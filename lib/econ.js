// lib/econ.js
//
// Shared economy helper for every BitNode daemon (bn2/bn3/bn4). Owns two spending
// routines whose Netscript calls were needlessly sitting on scarce HOME RAM:
//   - hacknet node buying/upgrading (ns.hacknet.* - ~4.5GB), early game only, and
//   - home RAM upgrades (singularity.upgradeHomeRam + getUpgradeHomeRamCost - 4.5GB).
// Together ~9GB moved off each daemon. Runs off-home like the other helpers; the
// daemon scp's + exec's it and keeps it alive via ensureHelper.
//
// Args (forwarded by the launching daemon):
//   [0] homeRamReserve - money to keep free before spending on home RAM (default 0).
//                        BN2 passes its gang-join money so the gang bootstrap is
//                        never starved by a home-RAM buy; bn3/bn4 leave it 0.
//
// Self-contained (no imports) so it can land on any rooted host.

const TICK_MS = 15_000;

function playerMoney(ns) {
  return ns.getPlayer().money ?? 0;
}

function hackingLevel(ns) {
  return ns.getPlayer().skills?.hacking ?? ns.getHackingLevel();
}

/** @param {NS} ns */
function maybeSpendOnHacknet(ns) {
  if (hackingLevel(ns) > 200) return;

  const hn = ns.hacknet;
  const totalBudget = playerMoney(ns) * 0.20;
  if (totalBudget < 1_000) return;

  let spent = 0;
  while (true) {
    const remaining = totalBudget - spent;
    if (remaining < 1_000) break;

    const nodeCount = hn.numNodes();
    let bestCost = Infinity;
    let bestAction = null;

    if (nodeCount < 8) {
      const cost = hn.getPurchaseNodeCost();
      if (cost > 0 && cost < bestCost && cost <= remaining) {
        bestCost = cost;
        bestAction = () => { hn.purchaseNode(); return cost; };
      }
    }

    for (let i = 0; i < nodeCount; i++) {
      const lvlCost  = hn.getLevelUpgradeCost(i, 1);
      const ramCost  = hn.getRamUpgradeCost(i, 1);
      const coreCost = hn.getCoreUpgradeCost(i, 1);

      if (lvlCost  > 0 && lvlCost  < bestCost && lvlCost  <= remaining) { bestCost = lvlCost;  bestAction = () => { hn.upgradeLevel(i, 1); return lvlCost; }; }
      if (ramCost  > 0 && ramCost  < bestCost && ramCost  <= remaining) { bestCost = ramCost;  bestAction = () => { hn.upgradeRam(i, 1);   return ramCost; }; }
      if (coreCost > 0 && coreCost < bestCost && coreCost <= remaining) { bestCost = coreCost; bestAction = () => { hn.upgradeCore(i, 1);  return coreCost; }; }
    }

    if (!bestAction) break;
    spent += bestAction();
  }
}

/**
 * Upgrade home RAM when comfortably affordable. Keeps the botnet growing and
 * gives cloud managers a home to fall back to if cloud servers are tight. Keeps
 * `moneyReserve` untouched (e.g. BN2's gang-join money during bootstrap).
 * @param {NS} ns @param {number} moneyReserve
 */
function maybeUpgradeHomeRam(ns, moneyReserve) {
  const s = ns.singularity;
  const cost = s.getUpgradeHomeRamCost();
  const money = playerMoney(ns);
  if (cost <= 0 || !isFinite(cost)) return;
  if (money - cost < moneyReserve) return;
  if (cost <= money * 0.4) s.upgradeHomeRam();
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  const homeRamReserve = Number(ns.args[0] ?? 0);

  while (true) {
    try {
      maybeSpendOnHacknet(ns);
      maybeUpgradeHomeRam(ns, homeRamReserve);
    } catch (e) {
      ns.print(`econ tick error: ${String(e)}`);
    }
    await ns.sleep(TICK_MS);
  }
}
