// lib/corp-bribe.js
//
// One-shot: buy the reputation the daemon's aug list is short of with corp funds
// ($1e9 a point, corporation.bribe). Launched off-home by lib/corp-daemon.js while
// buyAugs has published a shortfall (globalThis.gordBribeWishes) and the corp can
// pay; buyAugs then sees the reputation on its next tick and buys the augs itself.
// This script only ever raises reputation.
//
// A helper because bribe is 20GB and getCorporation 10GB, which the daemon should
// not carry for what is a few calls an hour; what to buy is corp-lib's bribePlan
// (pure, tested).

import { emitEvent } from "./events.js";
import { safe, nodeCorp, bribePlan } from "./corp-lib.js";

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  const c = ns.corporation;
  if (!c.hasCorporation()) return;

  const wishes = globalThis.gordBribeWishes?.list ?? [];
  const corp = safe(() => c.getCorporation());
  const plan = bribePlan(corp, wishes, nodeCorp().bribe);
  if (plan.length === 0) return;

  let spent = 0;
  let bought = 0;
  for (const { faction, amount, rep } of plan) {
    if (!safe(() => c.bribe(/** @type {any} */ (faction), amount))) continue;
    spent += amount;
    bought += rep;
  }
  if (bought > 0) {
    emitEvent(
      `[buy] Corp bribes: $${ns.format.number(spent)} for ${ns.format.number(bought)} rep ` +
      `across ${plan.length} faction(s)`,
      "buy",
      { factions: plan.map(p => p.faction) },
    );
  }
}
