// lib/sleeves.js
//
// Standalone duplicate-sleeve manager for BN10 ("Digital Carbon"). Same shape as
// lib/gang.js: a self-contained loop the daemon scp's + exec's onto whatever host
// has room, since the sleeve API is RAM-heavy (ns.sleeve.* is ~4GB PER method,
// ~40GB across the ~10 methods used here) - far too much to share a lean home
// with the daemon. Its only imports are lib/config.js and the pure decision cores
// it delegates to (lib/crime-logic.js), none of which touch Netscript - 0 RAM.
//
// BN10 is the ONE place you can buy extra sleeves and their memory, from The
// Covenant, and the payoff of sleeves comes from their NUMBER + memory, not from
// smashing the node and leaving. So this manager's whole job, once the player is
// rich, is:
//
//   1. Buy every sleeve The Covenant will sell (getSleeveCost climbs to ~1e20 for
//      the last one, then returns Infinity - that's the natural stop).
//   2. Buy sleeve AUGMENTATIONS, cheapest-first across the roster. These are the
//      cheapest permanent upgrade going: each one lifts that sleeve's multipliers
//      for the rest of the node, so its crime chance, its earnings and everything
//      it syncs back to the player all rise. They need the sleeve at ZERO shock,
//      which is why the shock ladder below now recovers all the way down.
//   3. Max memory (1..100) on every sleeve. Memory sets a sleeve's STARTING sync
//      each BitNode, which is what makes owned sleeves useful in later nodes -
//      the reddit "buy 99 memory for each of the brain-dead bastards" step. Bought
//      last: unlike augs it does nothing for THIS run.
//   4. Keep each sleeve productive: recover shock -> synchronize to 100 -> earn.
//      Shocked/unsynced sleeves earn at a penalty, so we clear those first before
//      earning in earnest.
//
// ── What "earn" means per sleeve (the assignment ladder) ─────────────────────
// A sleeve's stats are its own, and a fresh one is far too weak to land a crime:
// committing it to Mug at a 12% success chance mostly buys failed attempts. So
// each shock-clear, synced sleeve gets whichever of these is worth the most:
//
//   a. CRIME, when it can actually land one (best crime chance >= crimeMinChance).
//      Which crime is an expected-$/ms rate check, not a stat threshold - see
//      lib/crime-logic.js. Chances/gains come from ns.formulas.work (0GB), with a
//      weakest-combat-stat fallback when Formulas.exe isn't around.
//   b. FIELD WORK for the faction the player is currently grinding
//      (globalThis.gordFactionWork, published by lib/player-actions.js): a weak
//      sleeve still adds real rep to the exact grind we're already doing, and
//      field work trains all four combat stats toward (a) while it does.
//   c. GYM, when there's no faction grind to help with: train the weakest combat
//      stat until the sleeve can mug at crimeMinChance, then it graduates
//      to (a). Powerhouse Gym is in Sector-12, so the sleeve is travelled there
//      once if needed.
//
// Spending is gated by fractions of current cash (see CONFIG.sleeves) so buying
// sleeves/memory never starves the daemon's aug + server purchases. Publishes
// globalThis.gordSleeveState every tick for ui/dashboard.js (ui/bn10.js).

import { CONFIG } from "./config.js";
import { pickBestCrime } from "./crime-logic.js";
import { emitEvent } from "./events.js";

const S = CONFIG.sleeves;

// checkJs rejects plain strings where the API wants CrimeType/CityName-style enum
// unions; casting through any is the project convention - see the memory note
// [[bitburner-enum-string-casts]].
const GYM = /** @type {any} */ (S.gym);
const GYM_CITY = /** @type {any} */ (S.gymCity);

// The four combat stats, each as the GymType id setToGymWorkout wants ("str") next
// to the SleevePerson.skills field it trains ("strength"). Not a tunable - it's the
// API's own naming - so it lives here rather than in lib/config.js.
const COMBAT_STATS = [
  { gym: "str", skill: "strength" },
  { gym: "def", skill: "defense" },
  { gym: "dex", skill: "dexterity" },
  { gym: "agi", skill: "agility" },
];

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
  // Augs before memory: an aug raises this sleeve's multipliers NOW (everything it
  // earns, and everything it shares back), while memory only pays off in a future
  // BitNode - and memory is gated behind a complete roster, which may never happen.
  const augs = buyAugs(ns);
  const memBuys = buyMemory(ns);

  const count = ns.sleeve.getNumSleeves();
  const sleeves = [];
  for (let i = 0; i < count; i++) {
    sleeves.push(assignSleeve(ns, i));
  }

  publishState(ns, sleeves, buys, memBuys, augs);
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
 * Buy sleeve augmentations, cheapest-first across the whole roster, under a
 * per-tick budget of augMaxSpendFraction of SPENDABLE cash (so an invite hoard
 * still pauses the shop, like every other purchase here).
 *
 * Sleeve augs are the cheapest permanent upgrade in this node: each one raises that
 * sleeve's multipliers forever, which lifts its crime success, its earnings, and
 * the exp/money it syncs back to the player - so unlike memory they're worth buying
 * from the moment we can afford them rather than at the end of the roster.
 *
 * Two rules the game enforces, honoured here:
 *  - a sleeve's shock must be ZERO before any aug can be bought for it (which is
 *    why shockRecoveredBelow is 0 - a sleeve parked at 0.9 shock could never buy
 *    one), and both API calls throw rather than return false when it isn't;
 *  - getSleevePurchasableAugs already excludes what that sleeve has installed, so
 *    whatever it returns is genuinely new.
 * @param {NS} ns @returns {{bought: number, available: number, spent: number}}
 */
function buyAugs(ns) {
  const count = ns.sleeve.getNumSleeves();

  // Gather every offer across the roster first, so a cheap aug on sleeve #7 isn't
  // starved by an expensive one on sleeve #0.
  const offers = [];
  for (let i = 0; i < count; i++) {
    if (ns.sleeve.getSleeve(i).shock > 0) continue; // not eligible yet
    try {
      for (const aug of ns.sleeve.getSleevePurchasableAugs(i)) {
        offers.push({ sleeve: i, name: aug.name, cost: aug.cost });
      }
    } catch { /* shock/API edge case - skip this sleeve, retry next tick */ }
  }
  offers.sort((a, b) => a.cost - b.cost);

  let budget = money(ns) * S.augMaxSpendFraction;
  let bought = 0;
  let spent = 0;

  for (const offer of offers) {
    // Cheapest-first, so the first thing we can't afford ends the pass.
    if (offer.cost > budget || offer.cost > money(ns)) break;

    let ok = false;
    try { ok = ns.sleeve.purchaseSleeveAug(offer.sleeve, offer.name); }
    catch { /* raced with something else buying/changing state - skip it */ }
    if (!ok) continue;

    budget -= offer.cost;
    spent += offer.cost;
    bought++;
    ns.print(`Sleeve #${offer.sleeve}: bought ${offer.name} for $${ns.format.number(offer.cost)}.`);
    emitEvent(`[+] Sleeve #${offer.sleeve} aug: ${offer.name} ($${ns.format.number(offer.cost)})`, "buy",
      { augs: [offer.name] });
  }

  return { bought, available: offers.length - bought, spent };
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
 * Drive one sleeve through the shock -> sync -> earn ladder (see the assignment
 * ladder in the file header for what "earn" resolves to), only issuing a setTo*
 * call when the sleeve isn't already doing the right thing - re-issuing the same
 * task restarts it and, for crime, forfeits progress toward the next completion.
 * Returns a compact status object for the dashboard.
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

  // 3. Crime, if this sleeve can actually land one. Which crime is decided by
  //    expected $/ms (chance x money / time), not by a stat threshold, so it
  //    switches to Homicide the moment Homicide is genuinely the better earner.
  const crimes = crimeCandidates(ns, info);
  const current = task?.type === "CRIME" ? task.crimeType : null;
  const pick = pickBestCrime(crimes, {
    minChance: S.crimeMinChance,
    current,
    stickyMargin: S.crimeStickyMargin,
  });

  if (pick) {
    if (pick.crime !== current) ns.sleeve.setToCommitCrime(i, /** @type {any} */ (pick.crime));
    return sleeveStatus(i, info, `Crime: ${pick.crime} (${Math.round(pick.chance * 100)}%)`);
  }

  // 4. Too weak to crime. If the player is grinding a faction, put the sleeve on
  //    field work for it: real rep on the grind we're already doing, plus all-round
  //    combat exp toward step 3.
  const grind = currentFactionGrind();
  if (grind) {
    const workType = startFactionWork(ns, i, grind.faction, task);
    if (workType) {
      return sleeveStatus(i, info, `Faction: ${grind.faction} (${workType})`);
    }
  }

  // 5. Nothing to grind for - train the weakest combat stat until this sleeve can
  //    mug reliably (crimeMinChance), at which point step 3 takes over.
  return trainAtGym(ns, i, info, task, crimes);
}

/**
 * Per-crime numbers for the rate check: live success chance + money per success
 * for THIS sleeve (its own stats and multipliers, which is why we can't reuse the
 * player's), plus the crime's fixed duration from config.
 *
 * ns.formulas.* costs 0GB but needs Formulas.exe on home; without it we fall back
 * to weakest-combat-stat proxies (S.fallbackMugCombat / S.fallbackHomicideCombat)
 * for the chance, which is enough to keep the ladder moving in the right order.
 * @param {NS} ns @param {any} info - SleevePerson from ns.sleeve.getSleeve
 */
function crimeCandidates(ns, info) {
  return S.crimeCandidates.map(name => {
    const crime = /** @type {any} */ (name);
    const timeMs = S.crimeTimeMs[name] ?? 0;
    try {
      return {
        crime: name,
        chance: ns.formulas.work.crimeSuccessChance(info, crime),
        money: ns.formulas.work.crimeGains(info, crime).money,
        timeMs,
      };
    } catch {
      // No Formulas.exe: approximate. The chance proxy is a step at the combat
      // level where an unbuffed sleeve reaches ~50% on that crime, and money falls
      // back to the game's base payout so the rate comparison still orders them.
      const combat = weakestCombat(info);
      const gate = name === "Mug" ? S.fallbackMugCombat : S.fallbackHomicideCombat;
      return {
        crime: name,
        chance: combat >= gate ? Math.min(1, (combat / gate) * 0.5) : 0,
        money: S.crimeFallbackMoney[name] ?? 0,
        timeMs,
      };
    }
  });
}

/**
 * The faction the player's work slot is currently earning rep for, or null. Read
 * from globalThis.gordFactionWork (stamped by lib/player-actions.js every tick the
 * daemon keeps working a faction) and ignored once stale, so sleeves can't keep
 * grinding a faction the daemon has moved on from.
 */
function currentFactionGrind() {
  const rec = globalThis.gordFactionWork;
  if (!rec?.faction) return null;
  if (Date.now() - (rec.at ?? 0) > S.factionWorkStaleMs) return null;
  return rec;
}

/**
 * Put sleeve `i` on faction work, trying S.factionWorkTypes in order (field
 * first - it's the all-round combat-exp option). Returns the work type that took,
 * or null if the faction offers none of them to a sleeve (setToFactionWork can
 * also throw, e.g. for a faction we're not in, so each attempt is guarded).
 * @param {NS} ns @param {number} i @param {string} faction @param {any} task
 */
function startFactionWork(ns, i, faction, task) {
  const onIt = task?.type === "FACTION" && task.factionName === faction;

  for (const type of S.factionWorkTypes) {
    // Already doing this exact work - re-issuing would just restart it.
    if (onIt && task.factionWorkType === type) return type;
    try {
      if (ns.sleeve.setToFactionWork(i, /** @type {any} */ (faction), /** @type {any} */ (type))) {
        return type;
      }
    } catch { /* faction doesn't offer this work type to sleeves - try the next */ }
  }

  return null;
}

/**
 * Train the sleeve's weakest combat stat at Powerhouse Gym until it can land a
 * crime at S.crimeMinChance, at which point assignSleeve's step 3 takes over. The
 * gym is in Sector-12 and a sleeve can only take a class in its own city, so
 * travel it there first (a one-off flat fee, paid out of spendable cash only).
 * @param {NS} ns @param {number} i @param {any} info @param {any} task
 * @param {{crime: string, chance: number}[]} crimes
 */
function trainAtGym(ns, i, info, task, crimes) {
  const mug = crimes.find(c => c.crime === "Mug") ?? crimes[0];
  const progress = `mug ${Math.round((mug?.chance ?? 0) * 100)}% / ${Math.round(S.crimeMinChance * 100)}%`;

  if (info.city !== S.gymCity) {
    if (money(ns) < S.travelCost) return sleeveStatus(i, info, `Idle (need $ to reach ${S.gymCity})`);
    if (!ns.sleeve.travel(i, GYM_CITY)) return sleeveStatus(i, info, `Idle (can't reach ${S.gymCity})`);
  }

  // Weakest of the four combat stats, so training evens them out - crime success
  // weights all four, and the weakest is what holds the chance down.
  const { gym, skill } = weakestCombatStat(info);
  const onIt = task?.type === "CLASS" && task.classType === gym;
  if (!onIt) ns.sleeve.setToGymWorkout(i, GYM, /** @type {any} */ (gym));

  return sleeveStatus(i, info, `Gym: ${skill} (${progress})`);
}

/** @param {any} info - a SleevePerson from ns.sleeve.getSleeve */
function weakestCombat(info) {
  return Math.min(...COMBAT_STATS.map(s => info.skills[s.skill]));
}

/** @param {any} info - the COMBAT_STATS entry for the sleeve's lowest combat stat. */
function weakestCombatStat(info) {
  return [...COMBAT_STATS].sort((a, b) => info.skills[a.skill] - info.skills[b.skill])[0];
}

/** @param {number} i @param {any} info - a SleevePerson from ns.sleeve.getSleeve */
function sleeveStatus(i, info, action) {
  return {
    index: i,
    action,
    shock: info.shock,
    sync: info.sync,
    memory: info.memory,
    combat: weakestCombat(info),
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
function publishState(ns, sleeves, buysThisTick, memBuysThisTick, augs) {
  const nextCost = ns.sleeve.getSleeveCost();
  const memoryDone = sleeves.length > 0 && sleeves.every(s => s.memory >= S.memoryMax);
  // "Productive" = past the shock/sync ladder and doing something that earns for
  // us: crime, or faction work for the grind the player is already running.
  const earning = sleeves.filter(s => s.action.startsWith("Crime") || s.action.startsWith("Faction")).length;
  const allProductive = sleeves.length > 0 && earning === sleeves.length;
  const grind = currentFactionGrind();

  globalThis.gordSleeveState = {
    count: sleeves.length,
    nextCost,                 // Infinity once the roster is maxed
    maxed: !Number.isFinite(nextCost),
    memoryMax: S.memoryMax,
    memoryDone,
    earning,
    allProductive,
    factionGrind: grind?.faction ?? null,
    buysThisTick,
    memBuysThisTick,
    // Sleeve augs: bought this tick, still on offer, and $ spent this tick. A
    // non-zero `augsAvailable` that never falls means we're budget-bound (or the
    // roster still has shock to shed - augs need shock 0).
    augsThisTick: augs?.bought ?? 0,
    augsAvailable: augs?.available ?? 0,
    augSpendThisTick: augs?.spent ?? 0,
    sleeves,
    updatedAt: Date.now(),
  };
}
