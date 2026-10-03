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
import { reservedHosts } from "./ns-utils.js";

const PS = CONFIG.pserv;

/**
 * The option with the most RAM gained per dollar; among options within 0.1% of
 * the best rate, the one that gains the most (so flat pricing still takes the
 * biggest step, in one purchase instead of ten). Pure - exported for the tests.
 * @template {{cost: number, gain: number}} T
 * @param {T[]} options
 * @returns {T | null}
 */
export function bestRamPerDollar(options) {
  const rated = options.filter(o => o.cost > 0 && o.gain > 0);
  if (!rated.length) return null;
  const best = Math.max(...rated.map(o => o.gain / o.cost));
  return rated
    .filter(o => o.gain / o.cost >= best * 0.999)
    .sort((a, b) => b.gain - a.gain)[0];
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

  if (ns.cloud.getServerCost(PS.minRam) > spendable) return null;

  const actions = [];

  // Spend the budget one purchase at a time, each the best RAM PER DOLLAR on
  // offer: a new server at any affordable tier, or the weakest server raised
  // to any affordable tier. Where cloud RAM is priced flat every option ties
  // and the tie goes to the biggest step - the old "largest tier we can
  // afford". But several BitNodes price it on a softcap curve (BN7's
  // CloudServerSoftcap 2: $/GB DOUBLES with each doubling past 64GB, so 1TB
  // costs $901M where sixteen 64GB servers cost $56M), and there the largest
  // affordable tier is the worst buy on the menu: $1b bought ~1.7TB that way
  // and buys ~5TB spread level.
  let moneyLeft = spendable;

  for (let guard = 0; guard < PS.maxBuysPerCall; guard++) {
    const currentServers = ns.cloud.getServerNames();
    const currentMoney = ns.getPlayer().money;
    const currentSpendable = Math.min((currentMoney - reserveMoney) * spendFraction, hardSpendCap);
    moneyLeft = Math.min(moneyLeft, currentSpendable);

    /** @type {{kind: string, server?: string, ram: number, cost: number, gain: number}[]} */
    const options = [];
    if (currentServers.length < limit) {
      for (let ram = PS.minRam; ram <= maxRam; ram *= 2) {
        const cost = ns.cloud.getServerCost(ram);
        if (!(cost > 0) || cost > moneyLeft) break;
        options.push({ kind: "buy", ram, cost, gain: ram });
      }
    }
    // Upgrades go to the WEAKEST server, so the fleet levels up evenly. Daemon-
    // reserved hosts (the dedicated gang/corp servers) are left alone - the
    // botnet can't use them, so upgrading them for workers is wasted money.
    const weakest = currentServers
      .filter(h => !reservedHosts().has(h) && ns.getServerMaxRam(h) < maxRam)
      .sort((a, b) => ns.getServerMaxRam(a) - ns.getServerMaxRam(b))[0];
    if (weakest) {
      const have = ns.getServerMaxRam(weakest);
      for (let ram = have * 2; ram <= maxRam; ram *= 2) {
        const cost = ns.cloud.getServerUpgradeCost(weakest, ram);
        if (!(cost > 0) || cost > moneyLeft) break;
        options.push({ kind: "upgrade", server: weakest, ram, cost, gain: ram - have });
      }
    }

    const pick = bestRamPerDollar(options);
    if (!pick) break;

    if (pick.kind === "buy") {
      const bought = ns.cloud.purchaseServer(`${PS.namePrefix}${currentServers.length}`, pick.ram);
      if (!bought) break;
      actions.push(`Bought ${bought} (${ns.format.ram(pick.ram)})`);
      emitEvent(`[+] Bought server ${bought} (${ns.format.ram(pick.ram)})`, "buy");
    } else {
      if (!ns.cloud.upgradeServer(/** @type {string} */ (pick.server), pick.ram)) break;
      actions.push(`Upgraded ${pick.server} -> ${ns.format.ram(pick.ram)}`);
      emitEvent(`[+] Upgraded server ${pick.server} -> ${ns.format.ram(pick.ram)}`, "buy");
    }
    moneyLeft -= pick.cost;
  }

  if (actions.length === 0) return null;
  return {
    action: actions.length === 1 ? "Bought/Upgraded Server" : `Server upgrades x${actions.length}`,
    detail: actions.join(", "),
  };
}