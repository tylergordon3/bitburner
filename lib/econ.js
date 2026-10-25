// lib/econ.js
//
// Shared economy helper for every BitNode daemon: home RAM and home CORE
// upgrades (Singularity - 9GB that would otherwise sit on scarce HOME RAM in the
// daemon). Runs off-home like the other helpers; the daemon scp's + exec's it
// and keeps it alive via ensureHelper.
//
// Home comes LAST. A purchased server's RAM costs $55k/GB (bitburner-src
// ServerPurchases.ts, BaseCostFor1GBOfRamServer) where home's next doubling
// costs 32,000 x RAM x 1.58^log2(RAM) (PlayerObjectServerMethods.ts) - at 16TB,
// $317b for 16TB, ~350 times the price a GB. A core is 1e9 x 7.5^cores and adds
// 1/16 to grow, weaken, share and Stanek charges run on home only. Both survive
// an aug install (only a new BitNode resets them, Prestige.ts) where the fleet
// does not - but at those prices the fleet comes first anyway. So nothing is
// spent here until the purchased-server fleet is FULL: every slot taken and
// every server at the node's RAM cap (fleetFull). In a node that sells no
// servers at all (BN9: CloudServerLimit 0) home is the only RAM there is, and
// it is bought as before. Getting the daemon onto home in the first place is
// early/driver.js's job: it buys home RAM until the daemon fits. A node can opt
// out of the gate (econ.homeBeforeFleet - BN8, where the fleet never fills and
// every install deletes it): home is then bought from the first dollar the
// money floor leaves visible.
//
// The early-game hacknet NODE buyer used to live here too. It is its own script
// now (lib/hacknet-nodes.js): its ns.hacknet.* calls are another 5GB, wanted
// for the first few minutes of a run at most and in half the nodes not at all,
// and this script runs for the whole node.
//
// Args (forwarded by the launching daemon):
//   [0] homeRamReserve - money to keep free before spending on home. Defaults
//                        to the node's econ.homeRamReserve (BN2 sets its gang-join
//                        money so the gang bootstrap is never starved by a
//                        home-RAM buy; bn3/bn4 leave it 0).
//   [1] node           - BitNode number, for forNode().
//
// Imports only lib/config.js and lib/ns-utils.js' money readers, so this stays
// as cheap as it was when it was fully self-contained.
//
// RAM: 12.3GB = 1.6 base + 3 upgradeHomeRam + 1.5 getUpgradeHomeRamCost
//   + 3 upgradeHomeCores + 1.5 getUpgradeHomeCoresCost + 0.5 getPlayer
//   + 1.05 cloud.getServerNames + 0.05 x3 cloud.getServerLimit / getRamLimit / getServerMaxRam
// (Singularity at 1x - SF4.3, or inside BN4).

import { CONFIG, forNode } from "./config.js";
import { playerMoney, moneyFloor, reservedHosts } from "./ns-utils.js";

// The per-node values arrive as exec args from the launching daemon (the reserve
// directly, the node number for forNode), so this file never pays getResetInfo.
let E = CONFIG.econ;

/**
 * Is the purchased-server fleet as big as it can get - every slot taken, every
 * server (but the daemon's dedicated hosts, which are sized for their manager
 * and never upgraded for the botnet) at the RAM cap? True in a node that sells
 * none. Pure.
 * @param {{limit: number, maxRam: number, rams: number[]}} fleet rams: the
 *        botnet's servers' sizes (dedicated hosts left out)
 * @param {number} slotsTaken every purchased server, dedicated ones included
 */
export function fleetFull(fleet, slotsTaken) {
  if (!(fleet.limit > 0)) return true;
  if (slotsTaken < fleet.limit) return false;
  return fleet.rams.every(ram => ram >= fleet.maxRam);
}

/**
 * Whether one home upgrade costing `cost` is to be bought now: the fleet is
 * full, the cost is real, it leaves `reserve` (the caller's and the money
 * floor's) untouched, and it is at most `maxFraction` of cash. Pure.
 * @param {{full: boolean, cost: number, money: number, reserve: number, maxFraction: number}} p
 */
export function homeUpgradeWanted(p) {
  if (!p.full) return false;
  if (!(p.cost > 0) || !isFinite(p.cost)) return false;
  if (p.money - p.cost < p.reserve) return false;
  return p.cost <= p.money * p.maxFraction;
}

/** @param {NS} ns */
function readFleetFull(ns) {
  const limit = ns.cloud.getServerLimit();
  if (!(limit > 0)) return true;
  const names = ns.cloud.getServerNames();
  const reserved = reservedHosts();
  return fleetFull({
    limit,
    maxRam: ns.cloud.getRamLimit(),
    rams: names.filter(h => !reserved.has(h)).map(h => ns.getServerMaxRam(h)),
  }, names.length);
}

/**
 * Home RAM, then a home core, when the fleet is full and either is comfortably
 * affordable. Keeps `moneyReserve` untouched (e.g. BN2's gang-join money during
 * bootstrap) and any active money-hoard floor.
 *
 * econ.homeBeforeFleet skips the fleet gate (BN8: the fleet can never fill
 * there, an install wipes it, and home is the only compute that survives). The
 * money floor still applies - in BN8 that is the treasury's fence, so home is
 * bought out of the allowance and never out of the trader's capital.
 * @param {NS} ns @param {number} moneyReserve
 */
function maybeUpgradeHome(ns, moneyReserve) {
  const full = E.homeBeforeFleet === true || readFleetFull(ns);
  if (!full) return;
  const s = ns.singularity;
  const reserve = Math.max(moneyReserve, moneyFloor());
  const want = cost => homeUpgradeWanted({ full, cost, money: playerMoney(ns), reserve, maxFraction: E.homeRamMaxCostFraction });
  if (want(s.getUpgradeHomeRamCost())) s.upgradeHomeRam();
  // (Refused by the game at 8 cores, and in BN1's challenge run - restrictHomePCUpgrade.)
  if (E.homeCores && want(s.getUpgradeHomeCoresCost())) s.upgradeHomeCores();
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  E = forNode(Number(ns.args[1] ?? 0)).econ;
  const homeRamReserve = Number(ns.args[0] ?? E.homeRamReserve);

  while (true) {
    try {
      maybeUpgradeHome(ns, homeRamReserve);
    } catch (e) {
      ns.print(`econ tick error: ${String(e)}`);
    }
    await ns.sleep(E.tickMs);
  }
}
