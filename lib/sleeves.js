// lib/sleeves.js
//
// Duplicate-sleeve manager, run by EVERY per-node daemon. Same shape as
// lib/gang.js: a self-contained loop the daemon scp's + exec's onto whatever host
// has room, since the sleeve API is RAM-heavy (ns.sleeve.* is ~4GB PER method,
// ~72GB across the methods used here) - far too much to share a lean home with the
// daemon. Its only imports are lib/config.js, lib/capabilities.js and the pure
// decision cores it delegates to (lib/crime-logic.js), none of which touch
// Netscript beyond a free getResetInfo().
//
// Sleeves exist wherever you're in BitNode 10 or hold SF10, so this is launched on
// every node and self-exits where the API is unavailable, or where the roster is
// empty. Publishes globalThis.gordSleeveState every tick for ui/dashboard.js.
//
// ── The ladder every sleeve climbs ───────────────────────────────────────────
//   1. SHOCK RECOVERY to zero. Shocked sleeves earn and sync at a penalty, and -
//      the reason we recover all the way to 0 rather than "close enough" - the
//      game refuses to sell a sleeve an augmentation while its shock is above 0.
//   2. SYNCHRONIZE to 100. Sync scales how much of a sleeve's exp and earnings
//      flow back to the player, so it's worth maxing before earning in earnest.
//   3. Earn - which means one of two things depending on whether we have a gang:
//
//   GANG BOOTSTRAP (gang API available, no gang yet)
//     Founding a gang needs karma (-54,000 normally, -9 in BN2) and the sleeve
//     roster is the best karma engine we have: sleeve crime karma counts for the
//     player. So crimes are ranked by KARMA per ms instead of money - homicide
//     yields 3.0 a hit against mug's 0.25 - which produces exactly the ladder we
//     want: GYM the weakest combat stat until the sleeve can land a mug at
//     crimeMinChance, MUG, then switch to HOMICIDE the moment homicide clears the
//     same bar (at which point it's ~8x mug's karma rate).
//
//   MIRROR (we're in a gang, or gangs aren't available on this node)
//     Each sleeve shadows the PLAYER's own work slot - same crime, same faction
//     (preferring the same job type), same company, same gym stat - so the roster
//     multiplies whatever the daemon has decided is the most valuable thing to be
//     doing. When a sleeve can't or shouldn't copy it (too weak to land the
//     player's crime, faction won't take it, or the player is studying - see
//     mirrorStudy) it drops back to its own money-best crime, then to the gym.
//
// ── Spending ─────────────────────────────────────────────────────────────────
// AUGMENTATIONS are bought everywhere, cheapest-first across the roster: each one
// permanently lifts that sleeve's multipliers, so its crime chance, its earnings
// and everything it syncs back all rise.
//
// BUYING SLEEVES and MEMORY only works in BitNode 10 ("Digital Carbon"), where The
// Covenant sells both - getSleeveCost climbs to ~1e20 for the last sleeve, and
// memory (1..100) sets a sleeve's STARTING sync in every future BitNode, which is
// what makes owned sleeves useful later. Those two steps are gated on
// CONFIG.sleeves.shopBitNode; everything else runs identically on every node.
//
// All spending is a fraction of cash ABOVE globalThis.gordMoneyFloor, so it never
// starves the daemon's aug purchases or a money-gated faction-invite hoard.

import { CONFIG, forNode } from "./config.js";
import { getCapabilities } from "./capabilities.js";
import { pickBestCrime } from "./crime-logic.js";
import { emitEvent } from "./events.js";

// Resolved per BitNode in main() via forNode(), NOT read straight off CONFIG: this
// is a shared library, and BITNODE[10] genuinely overrides the shop budgets (BN10 is
// the only node where sleeves and memory are for sale, so it spends far harder on
// them than the defaults would). See the "Adding a BitNode override" note in
// lib/config.js - a library reading an overridable key has to resolve it itself.
let S = CONFIG.sleeves;

// checkJs rejects plain strings where the API wants CrimeType/CityName-style enum
// unions; casting through any is the project convention - see the memory note
// [[bitburner-enum-string-casts]]. Re-derived alongside S in configureForNode.
let GYM = /** @type {any} */ (S.gym);
let GYM_CITY = /** @type {any} */ (S.gymCity);
let UNIVERSITY = /** @type {any} */ (S.studyLocation);

// A mirrored CLASS task is either a gym workout or a university course; the only
// thing that tells them apart is whether classType is a GymType.
let GYM_STAT_IDS = new Set(S.gymStats);

/** @param {number} node - point S and everything derived from it at this node's config. */
function configureForNode(node) {
  S = forNode(node).sleeves;
  GYM = /** @type {any} */ (S.gym);
  GYM_CITY = /** @type {any} */ (S.gymCity);
  UNIVERSITY = /** @type {any} */ (S.studyLocation);
  GYM_STAT_IDS = new Set(S.gymStats);
}

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

  const caps = getCapabilities(ns);
  if (!caps.sleeves) {
    ns.tprint("sleeves.js: sleeve API unavailable (need BitNode 10 / SF10) - exiting.");
    return;
  }

  // Outside BN10 the roster is however many sleeves SF10 granted; if that's none
  // there is genuinely nothing to manage and nothing that can change it this run.
  if (numSleevesSafe(ns) <= 0) {
    ns.tprint("sleeves.js: no sleeves owned - exiting.");
    return;
  }

  // Per-node facts that can't change mid-run, resolved once: whether The Covenant's
  // sleeve/memory shop exists here, whether a gang is even possible, and the karma
  // gate to found one (-9 in BN2, -54,000 everywhere else).
  configureForNode(caps.currentNode);
  const cfg = forNode(caps.currentNode);
  const ctx = {
    node: caps.currentNode,
    shopOpen: caps.currentNode === S.shopBitNode,
    gangApi: caps.gang,
    karmaGate: cfg.gang.karma,
  };

  ns.tprint(
    `sleeves.js: managing ${ns.sleeve.getNumSleeves()} sleeve(s) in BN${ctx.node} ` +
    `(shop ${ctx.shopOpen ? "open" : "closed"}, gangs ${ctx.gangApi ? "available" : "unavailable"}).`
  );

  while (true) {
    tick(ns, ctx);
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

/** @param {NS} ns - true if we're in a gang; false (not just missing API) otherwise. */
function inGangSafe(ns) {
  try {
    return ns.gang.inGang();
  } catch {
    return false;
  }
}

/** @param {NS} ns @param {{node: number, shopOpen: boolean, gangApi: boolean, karmaGate: number}} ctx */
function tick(ns, ctx) {
  // Shop (BN10 only): sleeves first, then - once the roster is complete - memory.
  const buys = ctx.shopOpen ? buySleeves(ns) : 0;
  // Augs before memory, and everywhere rather than only in BN10: an aug raises this
  // sleeve's multipliers NOW (everything it earns, and everything it shares back),
  // while memory only pays off in a future BitNode.
  const augs = buyAugs(ns);
  const mem = ctx.shopOpen ? buyMemory(ns) : null;

  const mode = currentMode(ns, ctx);

  const count = ns.sleeve.getNumSleeves();
  const sleeves = [];
  for (let i = 0; i < count; i++) {
    sleeves.push(assignSleeve(ns, i, mode));
  }

  publishState(ns, { sleeves, buys, mem, augs, mode, ctx });
}

// One-shot latch for the "BN10 shopping is finished" announcement below.
let _shoppingDoneAnnounced = false;

/**
 * Say so, once, when there is nothing left for BN10's Covenant to sell us: every
 * sleeve bought and every one at max memory. That's the condition the whole node is
 * being played for, and the cue to turn the HUD's FINISH toggle on (or destroy
 * w0r1d_d43m0n by hand) - the BN10 daemon deliberately never beats the node on its
 * own, so without this there's nothing telling you the shopping trip is over.
 * @param {NS} ns
 */
function announceShoppingDone(ns, { maxed, memoryDone }) {
  if (_shoppingDoneAnnounced || !maxed || !memoryDone) return;
  _shoppingDoneAnnounced = true;
  ns.tprint("Sleeve roster COMPLETE: every sleeve bought and memory maxed on all of them. Nothing left to buy in BN10 - safe to finish the node.");
  emitEvent("[+] Sleeve roster complete (all sleeves bought, memory maxed) - BN10 shopping done", "buy");
}

/**
 * Which of the two assignment modes we're in this tick, plus everything the
 * per-sleeve logic needs to act on it.
 *
 * Gang bootstrap wins whenever a gang is possible here and we don't have one yet:
 * karma is the single blocking resource in that window, and the roster criming for
 * it is the fastest way through. Everything else mirrors the player.
 * @param {NS} ns @param {{gangApi: boolean, karmaGate: number}} ctx
 */
function currentMode(ns, ctx) {
  if (ctx.gangApi && !inGangSafe(ns)) {
    const karma = ns.getPlayer().karma ?? 0;
    return {
      id: "gang",
      metric: /** @type {"karma"} */ ("karma"),
      karma,
      karmaGate: ctx.karmaGate,
      detail: `karma ${karma.toFixed(0)} / ${ctx.karmaGate} to found a gang`,
      work: null,
    };
  }

  const work = S.mirrorPlayer ? playerWork(ns) : null;
  const detail = !S.mirrorPlayer ? "mirroring disabled - own crime ladder"
    : work ? `mirroring the player's ${describeWork(work)}`
    : "player's work slot idle - own crime ladder";

  return { id: "mirror", metric: /** @type {"money"} */ ("money"), work, detail };
}

/**
 * The player's current work slot, or null. ns.singularity.getCurrentWork() is the
 * exact answer (and cheap at SF4.3), but it's Singularity, so a node without it
 * simply falls back to the faction heartbeat lib/player-actions.js publishes.
 * @param {NS} ns
 */
function playerWork(ns) {
  try {
    const work = ns.singularity.getCurrentWork();
    if (work) return work;
  } catch { /* no Singularity here - fall through to the heartbeat */ }

  const rec = currentFactionGrind();
  return rec ? { type: "FACTION", factionName: rec.faction, factionWorkType: rec.type } : null;
}

/** One-clause description of a player Task, for the dashboard's mode line. */
function describeWork(work) {
  switch (work?.type) {
    case "CRIME": return `crime (${work.crimeType})`;
    case "FACTION": return `work for ${work.factionName}`;
    case "COMPANY": return `job at ${work.companyName}`;
    case "CLASS": return `class (${work.classType})`;
    default: return String(work?.type ?? "idle").toLowerCase();
  }
}

// ── Shopping ─────────────────────────────────────────────────────────────────

/**
 * Buy as many sleeves as we can afford this tick (BitNode 10 only - The Covenant is
 * the only seller and purchaseSleeve fails anywhere else). Each purchase may cost at
 * most buyMaxSpendFraction of current cash, re-read after every buy so we never
 * chain into a purchase that eats the whole treasury. getSleeveCost() returns
 * Infinity once we own the maximum, which ends the loop.
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
 * Sleeve augs are the cheapest permanent upgrade available: each one raises that
 * sleeve's multipliers forever, which lifts its crime success, its earnings, and
 * the exp/money it syncs back to the player - so unlike memory they're worth buying
 * from the moment we can afford them, in every BitNode rather than only BN10.
 *
 * Held back until the player holds augMinMoney, though: on a node where this manager
 * runs from the start, a slice of a tiny early treasury is money the bootstrap needs
 * for TOR and the port openers.
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

  const spendable = money(ns);
  if (spendable < S.augMinMoney) return { bought: 0, available: offers.length, spent: 0 };

  let budget = spendable * S.augMaxSpendFraction;
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
 * Top up memory toward memoryMax (100) on every sleeve, under a per-tick budget of
 * memoryMaxSpendFraction of spendable cash. Buys the largest affordable chunk per
 * sleeve (halving down from the gap) so a full 1->100 climb completes over a handful
 * of ticks rather than 99 single upgrades. BitNode 10 only - upgradeMemory works
 * nowhere else - so the caller gates this on shopOpen.
 *
 * ── Why memory yields to the next SLEEVE, but only while one is in reach ────────
 * A new sleeve outranks memory twice over: it's a whole extra earner for the rest of
 * the run, and it arrives with its own 99 memory levels to buy later, whereas memory
 * only sets a sleeve's STARTING sync in a FUTURE BitNode. So while the next sleeve is
 * within memoryDeferSleeveReach of what we can spend, we save for it instead.
 *
 * The reach test replaces what used to be "wait until the roster is COMPLETE", which
 * was a trap: getSleeveCost climbs to ~1e20, so if the last sleeve stayed out of
 * budget - the normal case for most of a run - memory was never bought at all, and
 * we'd leave BN10 having skipped the single upgrade that actually persists into the
 * next node. Now an unreachable sleeve simply stops blocking; if income later brings
 * it back into reach we go back to saving, which is the right call at each point.
 *
 * Surveys the whole roster before spending so the dashboard can show the outstanding
 * levels and their cost even on ticks where we buy nothing.
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
    ns.print(`Sleeve #${i}: +${amount} memory (-> ${ns.sleeve.getSleeve(i).memory}) for $${ns.format.number(cost)}.`);
  }

  return { levels, spent, remainingLevels, remainingCost, savingForSleeve };
}

// ── Assignment ───────────────────────────────────────────────────────────────

/**
 * Drive one sleeve through the shock -> sync -> earn ladder (see the file header
 * for what "earn" resolves to in each mode), only issuing a setTo* call when the
 * sleeve isn't already doing the right thing - re-issuing the same task restarts
 * it and, for crime, forfeits progress toward the next completion. Returns a
 * compact status object for the dashboard.
 * @param {NS} ns @param {number} i @param {any} mode
 */
function assignSleeve(ns, i, mode) {
  const info = ns.sleeve.getSleeve(i);
  const task = ns.sleeve.getTask(i);

  // 1. Shock recovery until fully healed. Shocked sleeves earn + sync at a penalty
  //    and can't be sold augmentations, so clearing this first pays for itself.
  if (info.shock > S.shockRecoveredBelow) {
    if (task?.type !== "RECOVERY") ns.sleeve.setToShockRecovery(i);
    return sleeveStatus(i, info, "shock", "Shock Recovery");
  }

  // 2. Synchronize to full sync (scales exp/earnings shared back to the player).
  if (info.sync < S.syncTarget) {
    if (task?.type !== "SYNCHRO") ns.sleeve.setToSynchronize(i);
    return sleeveStatus(i, info, "sync", "Synchronizing");
  }

  // 3. Mirror the player, when we're past the gang bootstrap and they're doing
  //    something a sleeve can copy. Anything it can't do falls through.
  if (mode.id === "mirror" && mode.work) {
    const mirrored = mirrorPlayerWork(ns, i, info, task, mode.work);
    if (mirrored) return sleeveStatus(i, info, mirrored.kind, mirrored.action);
  }

  // 4. Crime, if this sleeve can actually land one. Which crime is decided by
  //    expected yield per ms under the mode's metric - money normally, KARMA during
  //    the gang bootstrap, where homicide's 12x per-attempt karma is what pulls it
  //    ahead of mug as soon as it clears crimeMinChance.
  const crimes = crimeCandidates(ns, info);
  const current = task?.type === "CRIME" ? task.crimeType : null;
  const pick = pickBestCrime(crimes, {
    metric: mode.metric,
    minChance: S.crimeMinChance,
    current,
    stickyMargin: S.crimeStickyMargin,
  });

  if (pick) {
    if (pick.crime !== current) ns.sleeve.setToCommitCrime(i, /** @type {any} */ (pick.crime));
    // Chance qualifier only while imperfect - "(100%)" on every row is noise.
    const pct = Math.round(pick.chance * 100);
    return sleeveStatus(i, info, "crime", `Crime: ${pick.crime}${pct < 100 ? ` (${pct}%)` : ""}`);
  }

  // 5. Too weak to crime. Outside the gang bootstrap, if the player is grinding a
  //    faction, field work for it beats the gym: real rep on the grind we're already
  //    doing, plus all-round combat exp toward step 4. During the bootstrap we skip
  //    it - focused gym work reaches a landable mug sooner, and karma is the only
  //    thing that matters in that window.
  if (mode.id !== "gang") {
    const grind = currentFactionGrind();
    if (grind) {
      const workType = startFactionWork(ns, i, grind.faction, task);
      if (workType) {
        return sleeveStatus(i, info, "faction", `Faction: ${grind.faction} (${workType})`);
      }
    }
  }

  // 6. Nothing else to do - train the weakest combat stat until this sleeve can mug
  //    reliably (crimeMinChance), at which point step 4 takes over.
  return trainAtGym(ns, i, info, task, crimes);
}

/**
 * Put sleeve `i` on whatever the player's own work slot is doing. Returns
 * {kind, action} when the sleeve took the work, or null to fall through to its own
 * earning ladder - which is the answer for CREATE_PROGRAM and GRAFTING (no sleeve
 * equivalent exists) as well as for anything the sleeve is too weak or ineligible
 * to do.
 * @param {NS} ns @param {number} i @param {any} info @param {any} task @param {any} work
 */
function mirrorPlayerWork(ns, i, info, task, work) {
  switch (work.type) {
    case "CRIME": {
      const crime = work.crimeType;
      // Only copy a crime the sleeve can actually land - a sleeve committing the
      // player's homicide at 8% just buys failed attempts, and its own ladder
      // (mug now, homicide later) earns strictly more.
      const chance = crimeChance(ns, info, crime);
      if (!(chance >= S.crimeMinChance)) return null;
      if (!(task?.type === "CRIME" && task.crimeType === crime)) {
        if (!ns.sleeve.setToCommitCrime(i, /** @type {any} */ (crime))) return null;
      }
      const pct = Math.round(chance * 100);
      return { kind: "crime", action: `Mirror crime: ${crime}${pct < 100 ? ` (${pct}%)` : ""}` };
    }

    case "FACTION": {
      const type = startFactionWork(ns, i, work.factionName, task, work.factionWorkType);
      return type ? { kind: "faction", action: `Mirror faction: ${work.factionName} (${type})` } : null;
    }

    case "COMPANY": {
      if (task?.type === "COMPANY" && task.companyName === work.companyName) {
        return { kind: "company", action: `Mirror company: ${work.companyName}` };
      }
      try {
        if (ns.sleeve.setToCompanyWork(i, /** @type {any} */ (work.companyName))) {
          return { kind: "company", action: `Mirror company: ${work.companyName}` };
        }
      } catch { /* another sleeve already holds this job, or we're not employed */ }
      return null;
    }

    case "CLASS":
      return mirrorClass(ns, i, info, task, work.classType);

    default:
      return null; // CREATE_PROGRAM / GRAFTING - nothing a sleeve can copy
  }
}

/**
 * Mirror the player's gym workout or university course. We copy the CLASS - the
 * stat being trained, the course being taken - not the venue: both of our venues
 * (Powerhouse Gym, Rothman University) are in Sector-12, which is where a sleeve
 * already gets travelled for the gym, so this never costs an extra trip.
 * @param {NS} ns @param {number} i @param {any} info @param {any} task @param {string} classType
 */
function mirrorClass(ns, i, info, task, classType) {
  const isGym = GYM_STAT_IDS.has(classType);

  // A university course is off by default (mirrorStudy): the player only studies
  // when there's nothing better LEFT FOR THEM, but a sleeve always has something
  // better - crime, which earns and syncs combat exp back instead of paying
  // tuition. Decided before the travel check so declining costs nothing.
  if (!isGym && !S.mirrorStudy) return null;
  if (!travelToGymCity(ns, i, info)) return null;

  const onIt = task?.type === "CLASS" && task.classType === classType;

  if (isGym) {
    if (!onIt && !ns.sleeve.setToGymWorkout(i, GYM, /** @type {any} */ (classType))) return null;
    return { kind: "class", action: `Mirror gym: ${classType}` };
  }

  if (!onIt && !ns.sleeve.setToUniversityCourse(i, UNIVERSITY, /** @type {any} */ (classType))) return null;
  return { kind: "class", action: `Mirror study: ${classType}` };
}

/**
 * Per-crime numbers for the rate check: live success chance, money per success and
 * karma per success for THIS sleeve (its own stats and multipliers, which is why we
 * can't reuse the player's), plus the crime's fixed duration from config.
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
    // Karma isn't in the WorkStats formulas return, so it always comes from config.
    const karma = S.crimeKarma[name] ?? 0;
    try {
      return {
        crime: name,
        chance: ns.formulas.work.crimeSuccessChance(info, crime),
        money: ns.formulas.work.crimeGains(info, crime).money,
        karma,
        timeMs,
      };
    } catch {
      // No Formulas.exe: approximate. The chance proxy is a step at the combat
      // level where an unbuffed sleeve reaches ~50% on that crime, and money falls
      // back to the game's base payout so the rate comparison still orders them.
      return {
        crime: name,
        chance: fallbackChance(info, name),
        money: S.crimeFallbackMoney[name] ?? 0,
        karma,
        timeMs,
      };
    }
  });
}

/**
 * This sleeve's success chance at one named crime - used when mirroring, where the
 * player may be on a crime that isn't in S.crimeCandidates. Without Formulas.exe we
 * only have proxies for the two crimes we model, so anything else reports 0 and the
 * mirror declines (the sleeve runs its own ladder instead).
 * @param {NS} ns @param {any} info @param {string} name
 */
function crimeChance(ns, info, name) {
  try {
    return ns.formulas.work.crimeSuccessChance(info, /** @type {any} */ (name));
  } catch {
    return fallbackChance(info, name);
  }
}

/** @param {any} info @param {string} name - Formulas-free success-chance proxy. */
function fallbackChance(info, name) {
  const gate = name === "Mug" ? S.fallbackMugCombat
    : name === "Homicide" ? S.fallbackHomicideCombat
    : 0;
  if (!gate) return 0; // no proxy for this crime - treat as unlandable
  const combat = weakestCombat(info);
  return combat >= gate ? Math.min(1, (combat / gate) * 0.5) : 0;
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
 * Put sleeve `i` on faction work, trying `preferred` first (the player's own job
 * type, when we're mirroring) and then S.factionWorkTypes in order - field first,
 * since it's the all-round combat-exp option. Returns the work type that took, or
 * null if the faction offers none of them to a sleeve (setToFactionWork can also
 * throw, e.g. for a faction we're not in, so each attempt is guarded).
 * @param {NS} ns @param {number} i @param {string} faction @param {any} task
 * @param {string} [preferred]
 */
function startFactionWork(ns, i, faction, task, preferred) {
  const onIt = task?.type === "FACTION" && task.factionName === faction;
  const types = preferred ? [preferred, ...S.factionWorkTypes.filter(t => t !== preferred)] : S.factionWorkTypes;

  for (const type of types) {
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
 * crime at S.crimeMinChance, at which point assignSleeve's crime step takes over.
 * @param {NS} ns @param {number} i @param {any} info @param {any} task
 * @param {{crime: string, chance: number}[]} crimes
 */
function trainAtGym(ns, i, info, task, crimes) {
  const mug = crimes.find(c => c.crime === "Mug") ?? crimes[0];
  const progress = `mug ${Math.round((mug?.chance ?? 0) * 100)}% / ${Math.round(S.crimeMinChance * 100)}%`;

  if (!travelToGymCity(ns, i, info)) {
    return sleeveStatus(i, info, "idle", `Idle (can't reach ${S.gymCity})`);
  }

  // Weakest of the four combat stats, so training evens them out - crime success
  // weights all four, and the weakest is what holds the chance down.
  const { gym, skill } = weakestCombatStat(info);
  const onIt = task?.type === "CLASS" && task.classType === gym;
  if (!onIt) ns.sleeve.setToGymWorkout(i, GYM, /** @type {any} */ (gym));

  return sleeveStatus(i, info, "gym", `Gym: ${skill} (${progress})`);
}

/**
 * Make sure the sleeve is in the gym/university city (Sector-12). A sleeve can only
 * take a class where it stands, so this is a one-off flat $200k trip paid out of
 * spendable cash only. True once it's there.
 * @param {NS} ns @param {number} i @param {any} info
 */
function travelToGymCity(ns, i, info) {
  if (info.city === S.gymCity) return true;
  if (money(ns) < S.travelCost) return false;
  return ns.sleeve.travel(i, GYM_CITY);
}

/** @param {any} info - a SleevePerson from ns.sleeve.getSleeve */
function weakestCombat(info) {
  return Math.min(...COMBAT_STATS.map(s => info.skills[s.skill]));
}

/** @param {any} info - the COMBAT_STATS entry for the sleeve's lowest combat stat. */
function weakestCombatStat(info) {
  return [...COMBAT_STATS].sort((a, b) => info.skills[a.skill] - info.skills[b.skill])[0];
}

/**
 * @param {number} i @param {any} info - a SleevePerson from ns.sleeve.getSleeve
 * @param {string} kind - shock|sync|crime|faction|company|class|gym|idle, so the
 *   dashboard can colour and count without parsing the human-readable action.
 * @param {string} action
 */
function sleeveStatus(i, info, kind, action) {
  return {
    index: i,
    kind,
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

// Assignments that earn for us right now, as opposed to getting a sleeve ready to
// (shock/sync/gym) or spending money to learn (class).
const EARNING_KINDS = new Set(["crime", "faction", "company"]);

/** @param {NS} ns */
function publishState(ns, { sleeves, buys, mem, augs, mode, ctx }) {
  // getSleeveCost is only meaningful where the shop exists; elsewhere the roster is
  // whatever SF10 granted and there's nothing to buy.
  const nextCost = ctx.shopOpen ? ns.sleeve.getSleeveCost() : Infinity;
  const maxed = !Number.isFinite(nextCost);
  const memoryDone = sleeves.length > 0 && sleeves.every(s => s.memory >= S.memoryMax);
  if (ctx.shopOpen) announceShoppingDone(ns, { maxed, memoryDone });
  const earning = sleeves.filter(s => EARNING_KINDS.has(s.kind)).length;
  const allProductive = sleeves.length > 0 && earning === sleeves.length;
  const grind = currentFactionGrind();

  globalThis.gordSleeveState = {
    count: sleeves.length,
    node: ctx.node,
    // False outside BN10: no sleeves or memory for sale, so the dashboard hides
    // those rows rather than showing a purchase that can never happen.
    shopOpen: ctx.shopOpen,
    nextCost,                 // Infinity once the roster is maxed (or the shop is shut)
    maxed,
    memoryMax: S.memoryMax,
    memoryDone,
    // The BN10 shopping list: memory levels still to buy across the roster and what
    // they'd cost, plus whether we're deliberately holding off on them to save for
    // the next sleeve (which outranks memory - see buyMemory).
    memoryRemainingLevels: mem?.remainingLevels ?? 0,
    memoryRemainingCost: mem?.remainingCost ?? 0,
    savingForSleeve: mem?.savingForSleeve ?? false,
    // Everything the Covenant can still sell us is bought.
    shoppingDone: ctx.shopOpen && maxed && memoryDone,
    earning,
    allProductive,
    // "gang" while the roster is criming toward the karma gate, "mirror" once it's
    // shadowing the player. `modeDetail` is the one-line why.
    mode: mode.id,
    modeDetail: mode.detail,
    karma: mode.karma ?? null,
    karmaGate: mode.karmaGate ?? null,
    factionGrind: grind?.faction ?? null,
    buysThisTick: buys,
    memBuysThisTick: mem?.levels ?? 0,
    memSpendThisTick: mem?.spent ?? 0,
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
