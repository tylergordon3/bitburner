// lib/sleeve-shop.js
//
// The Covenant's sleeve + memory SHOP, which only exists in BitNode 10. Split out
// of lib/sleeves.js because of RAM: the four calls this file makes -
// getSleeveCost, purchaseSleeve, getMemoryUpgradeCost, upgradeMemory - are 4GB
// each and were charged to the sleeve manager on EVERY node, even though they
// can't do anything outside BN10. As its own ~26GB helper (launched by
// lib/daemon-core.js only when the current node is sleeves.shopBitNode) the
// manager drops to ~55GB everywhere, and the shop places on a small host.
//
// What it buys, and in what order (see CONFIG.sleeves for the budgets, turned up
// in BITNODE[10] because buying this shop out is the point of the node):
//   1. SLEEVES - each at most buyMaxSpendFraction of spendable cash, re-read after
//      every buy. getSleeveCost() is Infinity once we own the maximum.
//   2. MEMORY toward memoryMax on every sleeve, under memoryMaxSpendFraction per
//      tick, largest affordable chunk per sleeve - but memory yields to the next
//      SLEEVE while that sleeve is within memoryDeferSleeveReach of affordable. A
//      sleeve is worth more than memory twice over (an extra earner now, plus its
//      own 99 memory levels), yet getSleeveCost climbs to ~1e20, so an
//      unreachable one must not block memory forever - that's how a run ends
//      having skipped the one upgrade that carries into the next node.
//
// Spending respects globalThis.gordMoneyFloor (the daemon's invite hoard), like
// every other spender. Publishes globalThis.gordSleeveShop; lib/sleeves.js folds
// it into gordSleeveState so the SLEEVE dashboard tab is unchanged, and announces
// once when there is nothing left to buy - the cue to finish the node.
//
// Args: [0] the current BitNode number (the daemon passes it; ns.getResetInfo is
// 1GB, which this helper would otherwise pay for one integer).

import { forNode } from "./config.js";
import { emitEvent } from "./events.js";
import { spendableMoney as money } from "./ns-utils.js";

let S = forNode(10).sleeves;

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const node = Number(ns.args[0]);
  if (!Number.isFinite(node)) {
    ns.tprint("sleeve-shop.js: usage: run /lib/sleeve-shop.js <bitnode> (the daemon passes this) - exiting.");
    return;
  }
  S = forNode(node).sleeves;
  if (node !== S.shopBitNode) {
    ns.tprint(`sleeve-shop.js: The Covenant only sells sleeves in BitNode ${S.shopBitNode} - exiting.`);
    return;
  }

  let count;
  try { count = ns.sleeve.getNumSleeves(); } catch { count = -1; }
  if (count < 0) {
    ns.tprint("sleeve-shop.js: sleeve API unavailable - exiting.");
    return;
  }

  ns.tprint(`sleeve-shop.js: managing The Covenant's shop (${count} sleeve(s) owned).`);

  while (true) {
    try {
      tick(ns);
    } catch (e) {
      ns.print(`sleeve-shop tick error: ${String(e)}`);
    }
    await ns.sleep(S.tickMs);
  }
}

/** @param {NS} ns */
function tick(ns) {
  const buys = buySleeves(ns);
  const mem = buyMemory(ns);

  const nextCost = ns.sleeve.getSleeveCost();
  const maxed = !Number.isFinite(nextCost);
  const memoryDone = mem.remainingLevels === 0 && ns.sleeve.getNumSleeves() > 0;
  const shoppingDone = maxed && memoryDone;
  announceShoppingDone(ns, shoppingDone);

  globalThis.gordSleeveShop = {
    nextCost,                 // Infinity once the roster is maxed
    maxed,
    memoryDone,
    memoryRemainingLevels: mem.remainingLevels,
    memoryRemainingCost: mem.remainingCost,
    savingForSleeve: mem.savingForSleeve,
    shoppingDone,
    buysThisTick: buys,
    memBuysThisTick: mem.levels,
    memSpendThisTick: mem.spent,
    updatedAt: Date.now(),
  };
}

// One-shot latch for the "BN10 shopping is finished" announcement.
let _shoppingDoneAnnounced = false;

/**
 * Say so, once, when there is nothing left for The Covenant to sell us: every
 * sleeve bought and every one at max memory. That's the condition the whole node
 * is being played for, and the cue to turn the HUD's FINISH toggle on (or destroy
 * w0r1d_d43m0n by hand) - the BN10 daemon deliberately never beats the node on its
 * own, so without this there's nothing telling you the shopping trip is over.
 * @param {NS} ns @param {boolean} done
 */
function announceShoppingDone(ns, done) {
  if (_shoppingDoneAnnounced || !done) return;
  _shoppingDoneAnnounced = true;
  ns.tprint("Sleeve roster COMPLETE: every sleeve bought and memory maxed on all of them. Nothing left to buy in BN10 - safe to finish the node.");
  emitEvent("[+] Sleeve roster complete (all sleeves bought, memory maxed) - BN10 shopping done", "buy");
}

/**
 * Buy as many sleeves as we can afford this tick. Each purchase may cost at most
 * buyMaxSpendFraction of current cash, re-read after every buy so we never chain
 * into a purchase that eats the whole treasury.
 * @param {NS} ns @returns {number} sleeves bought this tick
 */
function buySleeves(ns) {
  let bought = 0;
  while (true) {
    const cost = ns.sleeve.getSleeveCost();
    if (!Number.isFinite(cost)) break; // hit the max sleeve count
    if (cost > money(ns) * S.buyMaxSpendFraction) break; // keep an operating reserve
    const res = ns.sleeve.purchaseSleeve();
    if (!res.success) break; // e.g. not a Covenant member yet - try again next tick
    const idx = ns.sleeve.getNumSleeves() - 1;
    ns.tprint(`Purchased a new sleeve (#${idx}) for $${ns.format.number(cost)}.`);
    emitEvent(`[+] Bought sleeve #${idx} for $${ns.format.number(cost)}`, "buy");
    bought++;
  }
  return bought;
}

/**
 * Top up memory toward memoryMax (100) on every sleeve, under a per-tick budget of
 * memoryMaxSpendFraction of spendable cash, buying the largest affordable chunk
 * per sleeve (halving down from the gap) - unless the next sleeve is within reach,
 * in which case we save for it instead (see the file header). Surveys the whole
 * roster before spending so the dashboard sees the outstanding levels and their
 * cost even on ticks where nothing is bought.
 * @param {NS} ns
 * @returns {{levels: number, spent: number, remainingLevels: number,
 *            remainingCost: number, savingForSleeve: boolean}}
 */
function buyMemory(ns) {
  const count = ns.sleeve.getNumSleeves();
  const spendable = money(ns);

  const gaps = [];
  let remainingLevels = 0;
  let remainingCost = 0;
  for (let i = 0; i < count; i++) {
    const gap = S.memoryMax - ns.sleeve.getSleeve(i).memory;
    if (gap <= 0) continue;
    gaps.push({ i, gap });
    remainingLevels += gap;
    const cost = ns.sleeve.getMemoryUpgradeCost(i, gap);
    if (Number.isFinite(cost)) remainingCost += cost;
  }

  const nextSleeve = ns.sleeve.getSleeveCost();
  const savingForSleeve = Number.isFinite(nextSleeve)
    && nextSleeve <= spendable * S.memoryDeferSleeveReach;

  if (savingForSleeve || gaps.length === 0) {
    return { levels: 0, spent: 0, remainingLevels, remainingCost, savingForSleeve };
  }

  let budget = spendable * S.memoryMaxSpendFraction;
  let levels = 0;
  let spent = 0;

  for (const { i, gap } of gaps) {
    // Largest chunk in [1..gap] whose cost fits the remaining budget.
    let amount = gap;
    while (amount > 0 && ns.sleeve.getMemoryUpgradeCost(i, amount) > budget) {
      amount = Math.floor(amount / 2);
    }
    if (amount <= 0) continue;

    const cost = ns.sleeve.getMemoryUpgradeCost(i, amount);
    if (!ns.sleeve.upgradeMemory(i, amount).success) continue;
    budget -= cost;
    spent += cost;
    levels += amount;
    remainingLevels -= amount;
    ns.print(`Sleeve #${i}: +${amount} memory (-> ${ns.sleeve.getSleeve(i).memory}) for $${ns.format.number(cost)}.`);
  }

  return { levels, spent, remainingLevels, remainingCost, savingForSleeve };
}
