// lib/hacknet-nodes.js
//
// The cheap early-game hacknet NODE buyer: a handful of nodes and their first
// upgrades, out of a slice of spare cash, while the hacking level is still too
// low for the botnet to earn. (Hacknet SERVERS - BN9's economy - are a different
// thing with a different manager: lib/hacknet.js.)
//
// Its own script because of RAM. These nine ns.hacknet.* calls cost 4.5GB, and
// they used to live in lib/econ.js, which runs for the whole node - so every
// run carried them for hours past the hacking level (econ.hacknetMaxHackingLevel)
// after which this routine does nothing, and every node that turns the buyer off
// carried them for nothing at all. Now the daemon launches this only while it is
// wanted (lib/daemon-core.js, on hacknetNodesWanted below), and it exits by
// itself the moment it no longer is.
//
// `econ.hacknetNodes: false` is an absolute off switch, twice over:
//   - the daemon never launches this where the RUN's config has it off - and the
//     daemon's config is the run's, challenge overlay included (BN9's challenge
//     run is zero hacknet spending);
//   - started anyway - by hand, or by a stale daemon - it checks its node's
//     config (forNode of the node it is told) before the first purchase and
//     exits; told no node at all, it exits too rather than assume the defaults.
// It is told the node rather than asking (forReset needs getResetInfo, 1GB, a
// seventh of this script again), which is why the first of those is the one
// that carries the challenge run.
//
// Args: [0] node - BitNode number, for forNode().
//
// RAM: 6.65GB = 1.6 base + 4.5 ns.hacknet.* + 0.5 getPlayer + 0.05 getHackingLevel.

import { CONFIG, forNode } from "./config.js";
import { playerMoney, hackingLevel, moneyFloor } from "./ns-utils.js";

// Re-pointed at the node's config by main(), before anything reads it.
let E = CONFIG.econ;

/**
 * Is the node buyer wanted? Only where the config has it on, and only up to the
 * hacking level past which nodes stop being worth buying. The daemon launches
 * this script on the answer and the script stops itself on it. Pure.
 * @param {{hacknetNodes?: boolean, hacknetMaxHackingLevel?: number} | null | undefined} econ - cfg.econ
 * @param {number} hacking - the player's hacking level
 */
export function hacknetNodesWanted(econ, hacking) {
  return econ?.hacknetNodes === true && hacking <= econ.hacknetMaxHackingLevel;
}

/** @param {NS} ns */
function spendOnNodes(ns) {
  const hn = ns.hacknet;
  const totalBudget = Math.max(0, playerMoney(ns) - moneyFloor()) * E.hacknetBudgetFraction;
  if (totalBudget < E.hacknetMinSpend) return;

  let spent = 0;
  while (true) {
    const remaining = totalBudget - spent;
    if (remaining < E.hacknetMinSpend) break;

    const nodeCount = hn.numNodes();
    let bestCost = Infinity;
    let bestAction = null;

    if (nodeCount < E.hacknetMaxNodes) {
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

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const node = Number(ns.args[0]);
  if (!(node > 0)) {
    ns.tprint("hacknet-nodes.js: usage: run /lib/hacknet-nodes.js <bitnode> (the daemon passes it) - exiting.");
    return;
  }
  E = forNode(node).econ;

  // Checked before every pass, the first included: off for this node, or past
  // the level cap (levels only fall at a reset, which ends this script anyway).
  while (hacknetNodesWanted(E, hackingLevel(ns))) {
    try {
      spendOnNodes(ns);
    } catch (e) {
      ns.print(`hacknet-nodes tick error: ${String(e)}`);
    }
    await ns.sleep(E.tickMs);
  }
  ns.print("Hacknet nodes are no longer wanted here - exiting.");
}
