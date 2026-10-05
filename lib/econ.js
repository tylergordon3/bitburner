// lib/econ.js
//
// Shared economy helper for every BitNode daemon: home RAM upgrades
// (singularity.upgradeHomeRam + getUpgradeHomeRamCost - 4.5GB that would
// otherwise sit on scarce HOME RAM in the daemon). Runs off-home like the other
// helpers; the daemon scp's + exec's it and keeps it alive via ensureHelper.
//
// The early-game hacknet NODE buyer used to live here too. It is its own script
// now (lib/hacknet-nodes.js): its ns.hacknet.* calls are another 4.5GB, wanted
// for the first few minutes of a run at most and in half the nodes not at all,
// and this script runs for the whole node.
//
// Args (forwarded by the launching daemon):
//   [0] homeRamReserve - money to keep free before spending on home RAM. Defaults
//                        to the node's econ.homeRamReserve (BN2 sets its gang-join
//                        money so the gang bootstrap is never starved by a
//                        home-RAM buy; bn3/bn4 leave it 0).
//   [1] node           - BitNode number, for forNode().
//
// Imports only lib/config.js and lib/ns-utils.js' money readers, so this stays
// as cheap as it was when it was fully self-contained.
//
// RAM: 6.6GB = 1.6 base + 3 upgradeHomeRam + 1.5 getUpgradeHomeRamCost + 0.5 getPlayer
// (Singularity at 1x - SF4.3, or inside BN4).

import { CONFIG, forNode } from "./config.js";
import { playerMoney, moneyFloor } from "./ns-utils.js";

// The per-node values arrive as exec args from the launching daemon (the reserve
// directly, the node number for forNode), so this file never pays getResetInfo.
let E = CONFIG.econ;

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
  // Respect both the caller's reserve and any active money-hoard floor.
  const reserve = Math.max(moneyReserve, moneyFloor());
  if (cost <= 0 || !isFinite(cost)) return;
  if (money - cost < reserve) return;
  if (cost <= money * E.homeRamMaxCostFraction) s.upgradeHomeRam();
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  E = forNode(Number(ns.args[1] ?? 0)).econ;
  const homeRamReserve = Number(ns.args[0] ?? E.homeRamReserve);

  while (true) {
    try {
      maybeUpgradeHomeRam(ns, homeRamReserve);
    } catch (e) {
      ns.print(`econ tick error: ${String(e)}`);
    }
    await ns.sleep(E.tickMs);
  }
}
