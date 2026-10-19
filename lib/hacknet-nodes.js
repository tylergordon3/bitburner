// lib/hacknet-nodes.js
//
// The cheap early-game hacknet NODE buyer: a handful of nodes and their first
// upgrades, out of a slice of spare cash, while the hacking level is still too
// low for the botnet to earn. (Hacknet SERVERS - BN9's economy - are a different
// thing with a different manager: lib/hacknet.js.)
//
// Its own script because of RAM. These ten ns.hacknet.* calls cost 5GB, and
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
// RAM: 7.15GB = 1.6 base + 5.0 ns.hacknet.* + 0.5 getPlayer + 0.05 getHackingLevel.

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

/**
 * What one more level, one RAM doubling and one more core add to a node's $/s,
 * from the game's production formula (src/Hacknet/formulas/HacknetNodes.ts):
 *   level * 1.5 * 1.035^(ram - 1) * (cores + 5) / 6 * mult * HacknetNodeMoney
 * `production` already carries both multipliers, so each gain is a ratio of it -
 * which is what keeps the payback test honest in a node that pays a fraction of
 * normal. Pure.
 * @param {{level: number, ram: number, cores: number, production: number}} n
 */
export function nodeUpgradeGains(n) {
  const p = Math.max(0, n.production);
  return {
    level: n.level > 0 ? p / n.level : 0,
    ram: p * (Math.pow(1.035, n.ram) - 1),
    core: p / (n.cores + 5),
  };
}

/**
 * $/s of a brand-new node (level 1, 1GB, 1 core) at the fleet's measured rate;
 * with no node yet to measure, `fallbackRate` - the player's own hacknet money
 * multiplier, i.e. the node's multiplier assumed to be 1 - stands in. Pure.
 * @param {{level: number, ram: number, cores: number, production: number}[]} nodes
 * @param {number} fallbackRate
 */
export function newNodeGain(nodes, fallbackRate) {
  for (const n of nodes) {
    const shape = n.level * 1.5 * Math.pow(1.035, n.ram - 1) * (n.cores + 5) / 6;
    if (shape > 0 && n.production > 0) return 1.5 * (n.production / shape);
  }
  return 1.5 * Math.max(0, fallbackRate);
}

/**
 * The buy that pays for itself soonest, among those that fit `remaining` and
 * pay back within `horizonSec` - or null when none does. Pure.
 * @template {{cost: number, gain: number}} T
 * @param {T[]} options @param {number} remaining @param {number} horizonSec
 * @returns {T | null}
 */
export function pickNodeBuy(options, remaining, horizonSec) {
  let best = null;
  let bestPayback = Infinity;
  for (const o of options) {
    if (!(o.cost > 0) || o.cost > remaining || !(o.gain > 0)) continue;
    const payback = o.cost / o.gain;
    if (payback <= horizonSec && payback < bestPayback) {
      best = o;
      bestPayback = payback;
    }
  }
  return best;
}

/**
 * One pass: out of a slice of spare cash, the buy that pays back soonest, again
 * and again while one pays back within econ.hacknetPaybackMs. The payback test
 * is what stops it: the level cap alone (hacknetNodesWanted) never ends the
 * buyer in a node whose hacking level stays low - BN13 kept it on for a whole
 * day of cheapest-first upgrades, $1.25b spent for $17.7m back.
 * @param {NS} ns
 */
function spendOnNodes(ns) {
  const hn = ns.hacknet;
  const totalBudget = Math.max(0, playerMoney(ns) - moneyFloor()) * E.hacknetBudgetFraction;
  if (totalBudget < E.hacknetMinSpend) return;
  const horizonSec = E.hacknetPaybackMs / 1000;
  const fallbackRate = ns.getPlayer().mults?.hacknet_node_money ?? 1;

  let spent = 0;
  while (true) {
    const remaining = totalBudget - spent;
    if (remaining < E.hacknetMinSpend) break;

    const nodeCount = hn.numNodes();
    const stats = [];
    for (let i = 0; i < nodeCount; i++) stats.push(hn.getNodeStats(i));

    /** @type {{cost: number, gain: number, buy: () => any}[]} */
    const options = [];
    if (nodeCount < E.hacknetMaxNodes) {
      options.push({ cost: hn.getPurchaseNodeCost(), gain: newNodeGain(stats, fallbackRate), buy: () => hn.purchaseNode() });
    }
    stats.forEach((n, i) => {
      const g = nodeUpgradeGains(n);
      options.push({ cost: hn.getLevelUpgradeCost(i, 1), gain: g.level, buy: () => hn.upgradeLevel(i, 1) });
      options.push({ cost: hn.getRamUpgradeCost(i, 1), gain: g.ram, buy: () => hn.upgradeRam(i, 1) });
      options.push({ cost: hn.getCoreUpgradeCost(i, 1), gain: g.core, buy: () => hn.upgradeCore(i, 1) });
    });

    const pick = pickNodeBuy(options, remaining, horizonSec);
    if (!pick) break;
    pick.buy();
    spent += pick.cost;
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
