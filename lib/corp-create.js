// lib/corp-create.js
//
// One-shot, node-agnostic corporation *creation*, split out of the daemons so
// they don't carry corporation.createCorporation (20GB) on home RAM. A daemon
// exec's this off-home whenever it has no corporation yet; it creates one and
// exits. Idempotent: a quick no-op once a corp already exists.
//
// Two creation paths:
//   - Seed funded (free): only offered in BN3. When available it fires almost
//     immediately.
//   - Self funded ($150b): the only path outside BN3. Gated behind
//     corp.selfFundBuffer so founding a corp never drains the player and stalls
//     aug/program progression.
//
// Gated by corp.enabled (per node, via forNode) so a node that opts out of the
// corp machinery never creates one. Mirrors how day-to-day play lives in its own
// scripts (lib/corp-upkeep.js, lib/corp-steady.js, and the four build phases).

import { forNode } from "./config.js";

/** @param {NS} ns */
export async function main(ns) {
  const c = ns.corporation;
  if (c.hasCorporation()) return;

  const node = ns.getResetInfo().currentNode;
  const CO = forNode(node).corp;
  if (!CO.enabled) return;

  // Seed-funded path (free) - only available in BN3.
  if (c.canCreateCorporation(false) === "Success") {
    if (c.createCorporation(CO.name, false)) {
      ns.tprint(`Created corporation ${CO.name} (seed funded).`);
      return;
    }
  }

  // Self-funded path ($150b). Only once the player is comfortably clear of the
  // cost, so we never found a corp at the expense of progression.
  const money = ns.getPlayer().money ?? 0;
  if (money < CO.selfFundCost * CO.selfFundBuffer) return;
  if (c.canCreateCorporation(true) === "Success" && money >= CO.selfFundCost) {
    if (c.createCorporation(CO.name, true)) {
      ns.tprint(`Created corporation ${CO.name} (self funded).`);
    }
  }
}
