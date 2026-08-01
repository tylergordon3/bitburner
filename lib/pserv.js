// lib/pserv.js
//
// Purchased ("cloud") server fleet management - how the botnet grows its RAM.
// managePurchasedServers spends a bounded budget (a reserveMoney floor, then
// spendFraction of the remainder, capped by an optional hardSpendCap): it buys the
// largest power-of-two RAM tier it can afford - starting at CONFIG.pserv.minRam so
// early game buys cheap servers rather than waiting for a big one - filling empty
// server slots first, then upgrading the weakest existing servers in place, all in
// one pass as the remaining budget shrinks. Daemon-reserved hosts
// (globalThis.gordReservedHosts, e.g. the dedicated gang/corp cloud server) are
// left untouched. Returns a { action, detail } status, or null when nothing was
// bought. The bnX daemons call it through maybeBuyInfra with budgets keyed to what
// they're currently saving for.

import { CONFIG } from "./config.js";
import { emitEvent } from "./events.js";

const PS = CONFIG.pserv;

/**
 * Hosts the node daemon has reserved (published on the shared globalThis) and
 * the botnet must not touch - e.g. a cloud server dedicated to /lib/gang.js.
 */
function reservedHosts() {
  const r = globalThis.gordReservedHosts;
  return r instanceof Set ? r : new Set(r ?? []);
}

/**
 * @param {NS} ns
 * @param {number} reserveMoney  - Hard floor: never let balance drop below this.
 * @param {number} spendFraction - Max fraction of spendable money to use per call.
 * @param {number} hardSpendCap  - Optional absolute ceiling on what we'll spend this call.
 */
export async function managePurchasedServers(
  ns,
  reserveMoney = PS.reserveMoney,
  spendFraction = PS.spendFraction,
  hardSpendCap = PS.hardSpendCap,
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
  // Start at the minimum purchasable tier so early-game buys cheap servers
  // rather than waiting until we can afford 8GB+.
  let targetRam = PS.minRam;
  while (
    targetRam * 2 <= maxRam &&
    ns.cloud.getServerCost(targetRam * 2) <= spendable
  ) {
    targetRam *= 2;
  }

  const cost = ns.cloud.getServerCost(targetRam);
  if (cost > spendable) return null;

  const actions = [];

  // Spend the full budget in one pass — buy new slots then upgrade existing ones.
  let moneyLeft = spendable;

  while (true) {
    // Recalculate live server list and targetRam each iteration as money shrinks
    const currentServers = ns.cloud.getServerNames();
    const currentMoney = ns.getPlayer().money;
    const currentSpendable = Math.min((currentMoney - reserveMoney) * spendFraction, hardSpendCap);
    moneyLeft = Math.min(moneyLeft, currentSpendable);

    // Recalculate best affordable RAM tier with remaining budget
    let ram = PS.minRam;
    while (ram * 2 <= maxRam && ns.cloud.getServerCost(ram * 2) <= moneyLeft) ram *= 2;
    if (ns.cloud.getServerCost(ram) > moneyLeft) break;

    let acted = false;

    // Buy a new slot first
    if (currentServers.length < limit) {
      const name = `${PS.namePrefix}${currentServers.length}`;
      const bought = ns.cloud.purchaseServer(name, ram);
      if (bought) {
        moneyLeft -= ns.cloud.getServerCost(ram);
        actions.push(`Bought ${bought} (${ns.format.ram(ram)})`);
        emitEvent(`[+] Bought server ${bought} (${ns.format.ram(ram)})`, "buy");
        acted = true;
        continue;
      }
    }

    // Upgrade cheapest under-spec'd server
    let upgraded = false;
    for (const server of currentServers) {
      // Leave daemon-reserved hosts (e.g. the dedicated gang server) alone -
      // the botnet can't use them, so upgrading them for workers is wasted money.
      if (reservedHosts().has(server)) continue;
      const serverRam = ns.getServerMaxRam(server);
      if (serverRam >= ram) continue;
      const upgradeCost = ns.cloud.getServerUpgradeCost(server, ram);
      if (upgradeCost < 0 || upgradeCost > moneyLeft) continue;
      if (ns.cloud.upgradeServer(server, ram)) {
        moneyLeft -= upgradeCost;
        actions.push(`Upgraded ${server} -> ${ns.format.ram(ram)}`);
        emitEvent(`[+] Upgraded server ${server} -> ${ns.format.ram(ram)}`, "buy");
        upgraded = true;
        acted = true;
        break;
      }
    }

    if (!acted) break;
  }

  if (actions.length === 0) return null;
  return {
    action: actions.length === 1 ? "Bought/Upgraded Server" : `Server upgrades x${actions.length}`,
    detail: actions.join(", "),
  };
}