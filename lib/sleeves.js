// lib/sleeves.js
//
// Standalone duplicate-sleeve manager for BN10 ("Digital Carbon"). Same shape as
// lib/gang.js: a self-contained loop the daemon scp's + exec's onto whatever host
// has room, since the sleeve API is RAM-heavy (ns.sleeve.* is ~4GB PER method,
// ~40GB across the ~10 methods used here) - far too much to share a lean home
// with the daemon. Its only import is lib/config.js (no Netscript calls, 0 RAM).
//
// BN10 is the ONE place you can buy extra sleeves and their memory, from The
// Covenant, and the payoff of sleeves comes from their NUMBER + memory, not from
// smashing the node and leaving. So this manager's whole job, once the player is
// rich, is:
//
//   1. Buy every sleeve The Covenant will sell (getSleeveCost climbs to ~1e20 for
//      the last one, then returns Infinity - that's the natural stop).
//   2. Max memory (1..100) on every sleeve. Memory sets a sleeve's STARTING sync
//      each BitNode, which is what makes owned sleeves useful in later nodes -
//      the reddit "buy 99 memory for each of the brain-dead bastards" step.
//   3. Keep each sleeve productive: recover shock -> synchronize to 100 -> commit
//      crime (money + karma + combat, all of which flow back to the player scaled
//      by sync). Shocked/unsynced sleeves earn at a penalty, so we clear those
//      first before earning in earnest.
//
// Spending is gated by fractions of current cash (see CONFIG.sleeves) so buying
// sleeves/memory never starves the daemon's aug + server purchases. Publishes
// globalThis.gordSleeveState every tick for ui/dashboard.js (ui/bn10.js).

import { CONFIG } from "./config.js";
import { emitEvent } from "./events.js";

const S = CONFIG.sleeves;

// checkJs rejects plain strings where the API wants CrimeType/CityName-style enum
// unions; casting through any is the project convention - see the memory note
// [[bitburner-enum-string-casts]].
const PRODUCTIVE_CRIME = /** @type {any} */ (S.productiveCrime);
const FALLBACK_CRIME = /** @type {any} */ (S.fallbackCrime);

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  // getNumSleeves throws if the sleeve API is unavailable (not BN10 / no SF10);
  // treat that as "nothing to manage" and exit cleanly rather than crash-looping.
  if (numSleevesSafe(ns) < 0) {
    ns.tprint("sleeves.js: sleeve API unavailable (need BitNode 10 / SF10) - exiting.");
    return;
  }

  while (true) {
    tick(ns);
    await ns.sleep(S.tickMs);
  }
}

/** @param {NS} ns - sleeve count, or -1 if the API is unavailable. */
function numSleevesSafe(ns) {
  try {
    return ns.sleeve.getNumSleeves();
  } catch {
    return -1;
  }
}

/** @param {NS} ns */
function tick(ns) {
  const buys = buySleeves(ns);
  const memBuys = buyMemory(ns);

  const count = ns.sleeve.getNumSleeves();
  const sleeves = [];
  for (let i = 0; i < count; i++) {
    sleeves.push(assignSleeve(ns, i));
  }

  publishState(ns, sleeves, buys, memBuys);
}

/**
 * Buy as many sleeves as we can afford this tick. Each purchase may cost at most
 * buyMaxSpendFraction of current cash, re-read after every buy so we never chain
 * into a purchase that eats the whole treasury. getSleeveCost() returns Infinity
 * once we own the maximum, which ends the loop.
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
    ns.tprint(`Purchased a new sleeve (#${ns.sleeve.getNumSleeves() - 1}) for $${ns.format.number(cost)}.`);
    emitEvent(`[+] Bought sleeve #${ns.sleeve.getNumSleeves() - 1} for $${ns.format.number(cost)}`, "buy");
    bought++;
  }
  return bought;
}

/**
 * Top up memory toward memoryMax on every sleeve, cheapest-remaining first, under
 * a per-tick budget of memoryMaxSpendFraction of cash. Buys the largest affordable
 * chunk per sleeve (halving down from the remaining amount) so a full 1->100 climb
 * completes over a handful of ticks rather than 99 single upgrades.
 *
 * Deferred until the roster is complete (getSleeveCost() == Infinity): sleeves get
 * strictly more expensive as you buy them (up to ~1e20), so per the strategy we
 * finish buying every sleeve before spending a cent on memory - memory only sets a
 * sleeve's STARTING sync in FUTURE nodes anyway, so there's no rush this run.
 * @param {NS} ns @returns {number} total memory levels bought this tick
 */
function buyMemory(ns) {
  if (Number.isFinite(ns.sleeve.getSleeveCost())) return 0; // still buying sleeves

  let budget = money(ns) * S.memoryMaxSpendFraction;
  let bought = 0;

  const count = ns.sleeve.getNumSleeves();
  for (let i = 0; i < count; i++) {
    const remaining = S.memoryMax - ns.sleeve.getSleeve(i).memory;
    if (remaining <= 0) continue;

    // Largest chunk in [1..remaining] whose cost fits the remaining budget.
    let amount = remaining;
    while (amount > 0 && ns.sleeve.getMemoryUpgradeCost(i, amount) > budget) {
      amount = Math.floor(amount / 2);
    }
    if (amount <= 0) continue;

    const cost = ns.sleeve.getMemoryUpgradeCost(i, amount);
    const res = ns.sleeve.upgradeMemory(i, amount);
    if (!res.success) continue;
    budget -= cost;
    bought += amount;
    ns.print(`Sleeve #${i}: +${amount} memory (-> ${ns.sleeve.getSleeve(i).memory}) for $${ns.format.number(cost)}.`);
  }

  return bought;
}

/**
 * Drive one sleeve toward "productive" through the shock -> sync -> crime ladder,
 * only issuing a setTo* call when the sleeve isn't already doing the right thing
 * (re-issuing the same task would restart it and, for crime, forfeit progress
 * toward the next completion). Returns a compact status object for the dashboard.
 * @param {NS} ns @param {number} i
 */
function assignSleeve(ns, i) {
  const info = ns.sleeve.getSleeve(i);
  const task = ns.sleeve.getTask(i);

  // 1. Shock recovery until effectively healed. Shocked sleeves earn + sync at a
  //    penalty, so clearing this first pays off everything that follows.
  if (info.shock > S.shockRecoveredBelow) {
    if (task?.type !== "RECOVERY") ns.sleeve.setToShockRecovery(i);
    return sleeveStatus(i, info, "Shock Recovery");
  }

  // 2. Synchronize to full sync (scales exp/earnings shared back to the player).
  if (info.sync < S.syncTarget) {
    if (task?.type !== "SYNCHRO") ns.sleeve.setToSynchronize(i);
    return sleeveStatus(i, info, "Synchronizing");
  }

  // 3. Productive crime. Homicide once combat is high enough (best $/karma), else
  //    Mug - which still earns and trains combat toward the homicide threshold.
  const combat = Math.min(info.skills.strength, info.skills.defense, info.skills.dexterity, info.skills.agility);
  const crime = combat >= S.homicideCombatMin ? PRODUCTIVE_CRIME : FALLBACK_CRIME;
  const wanted = combat >= S.homicideCombatMin ? S.productiveCrime : S.fallbackCrime;

  const onRightCrime = task?.type === "CRIME" && task.crimeType === wanted;
  if (!onRightCrime) ns.sleeve.setToCommitCrime(i, crime);
  return sleeveStatus(i, info, `Crime: ${wanted}`);
}

/** @param {number} i @param {any} info - a SleevePerson from ns.sleeve.getSleeve */
function sleeveStatus(i, info, action) {
  return {
    index: i,
    action,
    shock: info.shock,
    sync: info.sync,
    memory: info.memory,
    combat: Math.min(info.skills.strength, info.skills.defense, info.skills.dexterity, info.skills.agility),
  };
}

/**
 * Spendable cash = money above globalThis.gordMoneyFloor. The daemon raises the
 * floor while it's hoarding for a money-gated faction invite (Daedalus / The
 * Covenant / Illuminati), so during those windows the sleeve shop pauses instead
 * of spending the cash the invite needs us to hold. globalThis is shared across
 * every script in the game, so we just read the flag the daemon set.
 * @param {NS} ns
 */
function money(ns) {
  const floor = globalThis.gordMoneyFloor ?? 0;
  return Math.max(0, (ns.getPlayer().money ?? 0) - floor);
}

// ── Dashboard state ──────────────────────────────────────────────────────────

/** @param {NS} ns */
function publishState(ns, sleeves, buysThisTick, memBuysThisTick) {
  const nextCost = ns.sleeve.getSleeveCost();
  const memoryDone = sleeves.length > 0 && sleeves.every(s => s.memory >= S.memoryMax);
  const allProductive = sleeves.length > 0 && sleeves.every(s => s.action.startsWith("Crime"));

  globalThis.gordSleeveState = {
    count: sleeves.length,
    nextCost,                 // Infinity once the roster is maxed
    maxed: !Number.isFinite(nextCost),
    memoryMax: S.memoryMax,
    memoryDone,
    allProductive,
    buysThisTick,
    memBuysThisTick,
    sleeves,
    updatedAt: Date.now(),
  };
}
