// lib/corp-lib.js
//
// Helpers shared by the corporation scripts (lib/corp-upkeep, corp-steady,
// corp-expand, corp-office, corp-market, corp-invest).
//
// ── Why the corp manager is split across six files ───────────────────────────
// Bitburner prices the corporation API per DISTINCT function reachable from a
// script: every getter is 10GB and every action 20GB. A script's size is therefore
// set by how many different corp calls it can reach, not by how much work it does.
// The old single builder reached ~30 of them and cost ~490GB - so large that it
// could only ever be placed on a top-end host, which is exactly when you least
// have one (early game, small network). Four focused one-shot phases are 120-200GB
// each and the daemon runs them in rotation, so peak footprint is one phase.
//
// That pricing model is also why this module exports only small helpers: a shared
// function costs its importer nothing unless that importer actually reaches it, so
// splitting common code out here is free, while merging the PHASES back together
// would not be.
//
// Nothing here is BitNode-specific; CONFIG.corp is deep-merged per node by
// forNode(), and each phase resolves its own config.

import { CONFIG, forNode } from "./config.js";

const CO = CONFIG.corp;

/** Run `fn`, returning undefined instead of throwing. The corp API throws for a
 * great many benign "not yet" cases (no warehouse, no unlock, no such division),
 * so this is the normal way to probe state. */
export function safe(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** Run `fn` for effect; true if it didn't throw. */
export function did(fn) {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

/** @param {NS} ns - the corporation's liquid funds (negative while in debt). */
export function corpFunds(ns) {
  return safe(() => ns.corporation.getCorporation().funds) ?? 0;
}

/**
 * True if spending `cost` still leaves the operating reserve intact - plus the
 * current OBJECTIVE that lib/corp-expand.js publishes as gordCorpSavingFor.
 *
 * The reserve alone is PROPORTIONAL, so it can never accumulate a lump sum: every
 * spender (seats, advert, warehouse levels, upgrade levels) drains the surplus to
 * 10% each pass, so the CHEAPEST pending purchase always wins and anything dearer
 * than it is unreachable at any income. That is not a founding-specific problem -
 * it is why the BN10 corp sat at 2 of 6 cities with Advert 1 while turning a
 * profit - so the floor is not a founding-specific fix: corp-expand nominates one
 * objective at a time (founding, then city) and everything cheaper queues behind
 * it until it lands.
 *
 * `ignoreSaving` exempts a spend from the objective (never from the reserve), and
 * is for exactly one case: the purchase that IS the objective, spending the money
 * banked for it. Anything else passing true re-opens the leak - office seats did,
 * until corp-expand started giving them a turn instead of a bypass.
 *
 * Note this is for SPENDING decisions only. Material purchase orders deliberately
 * bypass it - the manual's whole round-1/2 plan ends with the corp in debt from
 * buying boost materials, which is allowed and free. See buyToTarget.
 * @param {NS} ns
 */
export function affordable(ns, cost, ignoreSaving = false) {
  if (!Number.isFinite(cost) || cost < 0) return false;
  const funds = corpFunds(ns);
  const saving = ignoreSaving ? 0 : (globalThis.gordCorpSavingFor ?? 0);
  return funds - cost >= funds * CO.fundsReserveFraction + saving;
}

/**
 * True while lib/corp-invest.js is holding a READY investment round for its offer
 * to settle (globalThis.gordCorpOfferHold) - the signal for every spender to
 * stop. The offer is a share of a valuation whose every cycle is
 *   10b + Funds/3 + max(AssetDelta, 0) * 315000
 * and a purchase is a drop in assets: a cycle that spends more than it earned
 * contributes NO AssetDelta term at all to the 10-cycle mean being sold.
 *
 * The flag has to be FRESH. corp-invest is a one-shot the daemon re-launches each
 * rotation, and it is the only thing that can clear the flag - so if it stops
 * being placed (no free RAM) with the flag up, a plain boolean would freeze every
 * purchase in the corp for the life of the save. corp-invest stamps
 * gordCorpOfferHoldAt each pass it holds; a stamp older than offerHoldStaleMs
 * (many rotations) means nobody is tending the hold, so it lapses.
 * Pure but for the two globals; `now` is injectable for the tests.
 * @param {number} [now]
 */
export function offerHoldActive(now = Date.now()) {
  if (globalThis.gordCorpOfferHold !== true) return false;
  const at = globalThis.gordCorpOfferHoldAt;
  return typeof at === "number" && now - at < CO.offerHoldStaleMs;
}

/**
 * The division object to work with for a configured industry: the LIVE name of
 * whichever division already runs that industry, or the configured name when there
 * isn't one yet (i.e. when we're about to found it).
 *
 * Matching on industry rather than name is what lets the buildout adopt a division
 * created by hand in the Corporation UI. The BN10 corp's Agriculture division was
 * made manually as "AgriGord"; a name-equality check sees no "Agriculture" division
 * at all and would pay another $40b startingCost for a duplicate beside it.
 * @param {NS} ns @param {{name: string, industry: string}} div
 */
export function resolveDivision(ns, div) {
  const c = ns.corporation;
  for (const name of safe(() => c.getCorporation().divisions) ?? []) {
    if (safe(() => c.getDivision(name).industry) === div.industry) {
      return { name, industry: div.industry };
    }
  }
  return div;
}

/** The live name of the division running `industry`, or null. @param {NS} ns */
export function divisionByIndustry(ns, industry) {
  const c = ns.corporation;
  for (const name of safe(() => c.getCorporation().divisions) ?? []) {
    if (safe(() => c.getDivision(name).industry) === industry) return name;
  }
  return null;
}

/**
 * The city a product division designs its products in - and therefore where its
 * MAIN office (the big "progress"-split one) is grown.
 *
 * It is the city the division was FOUNDED in, i.e. the free office expandIndustry
 * drops into Sector-12, and it never moves. That is not a preference, it is the
 * only choice that works:
 *
 *   - makeProduct(div, city, ...) THROWS for a city the division doesn't occupy,
 *     and every corp call here is wrapped in safe()/did(). A hard-coded design
 *     city the division hasn't expanded into yet therefore fails silently, every
 *     cycle, forever. That is exactly what happened to the BN3 corp: Tobacco was
 *     founded in Sector-12, config named Aevum, and the division sat at 0 products
 *     through the whole of round 3 - which is itself gated on a finished product,
 *     so nothing could ever break the loop.
 *   - The choice must also be STABLE. Product development is driven by the office
 *     in the city the product is being developed in, so moving the design city
 *     mid-pipeline hands the "progress" split to an empty new office and demotes
 *     the one actually building the product to the R&D support split.
 *
 * Nothing is lost by designing in the founding city: Bitburner's cities are
 * mechanically identical, so the old configured city bought nothing and cost an
 * office+warehouse ($9b) before the first product could exist at all.
 *
 * getDivision is already reached by every caller, so this costs no extra RAM.
 * @param {NS} ns @returns {any} a CityName, or null if the division can't be read
 */
export function designCity(ns, divName) {
  const cities = safe(() => ns.corporation.getDivision(divName).cities) ?? [];
  return cities.length ? cities[0] : null;
}

/**
 * The current investment round, as published by lib/corp-invest.js (the only phase
 * that pays the 10GB for getInvestmentOffer). Defaults to 1 rather than "past the
 * rounds" so a phase running before invest's first pass behaves conservatively:
 * round 1 gates everything expensive.
 */
export function currentRound() {
  return globalThis.gordCorpRound ?? 1;
}

/**
 * False until lib/corp-invest.js has published the round this process lifetime.
 * The build phases check it and skip their pass rather than fall back on
 * currentRound()'s default: after a page reload (globalThis is wiped) "round 1"
 * is simply wrong for an established corp, and acting on it is not harmless -
 * corp-market's round-1 branch orders boost materials on credit, corp-office
 * re-splits every Agriculture office to the round-1 jobs. corp-invest runs first
 * in the rotation, so the cost of waiting is one daemon tick.
 */
export function roundKnown() {
  return typeof globalThis.gordCorpRound === "number";
}

/**
 * The RP a material division must bank before its round-1/2 producing phase
 * starts: round 1's flat figure, round 2's per-industry one, 0 when there is no
 * gate (round 3+, or an industry the round doesn't gate). The same numbers
 * lib/corp-office.js holds staff on R&D for and lib/corp-invest.js gates
 * acceptance on.
 * @param {number} round @param {string} industry
 */
export function earlyRpGate(round, industry) {
  if (round === 1) return CO.round1ResearchPoints;
  if (round === 2) return CO.round2ResearchPoints[industry] ?? 0;
  return 0;
}

/**
 * Integer head-counts per role summing exactly to `total`.
 * @param {number} total @param {Record<string, number>} ratios
 * @returns {Record<string, number>}
 */
export function distributeJobs(total, ratios) {
  const roles = Object.keys(ratios);
  /** @type {Record<string, number>} */
  const counts = {};
  let assigned = 0;
  for (const r of roles) {
    counts[r] = Math.floor(total * ratios[r]);
    assigned += counts[r];
  }
  // Hand out the rounding remainder. First to weighted roles the floor left at
  // ZERO, then largest ratio first, so the dominant role (Engineer in every
  // producing split) absorbs the rest rather than a 0-ratio role.
  //
  // The zero-first step is not cosmetic. Flooring starves the small weights in a
  // small office, and a role at zero isn't "a bit low", it is a missing factor:
  // the round-2 split (O3/E1/B2/M2) on a 4-seat office came out O2/E0/B1/M1 - no
  // Engineer, in the round whose whole purpose is material quality - and the
  // design office's 1% Business came out 0 at any size under ~90, which is the
  // sales factor of the city every product is made in.
  const byRatio = roles.filter(r => ratios[r] > 0).sort((a, b) => ratios[b] - ratios[a]);
  if (!byRatio.length) return counts;
  for (const r of byRatio) {
    if (assigned >= total) break;
    if (counts[r] === 0) {
      counts[r]++;
      assigned++;
    }
  }
  for (let i = 0; assigned < total; i++, assigned++) {
    counts[byRatio[i % byRatio.length]]++;
  }
  return counts;
}

/**
 * How many corp-seconds of saving separate `funds` from `cost` at the current
 * profit rate: 0 when we can already pay, Infinity when the corp isn't earning.
 * Pure (0GB), and the shared answer to the one question both the savings floor
 * (lib/corp-expand.js) and the stall rescue (lib/corp-invest.js) turn on - "can
 * we get there from here?"
 *
 * The BN10 corp is why it exists. It reached round 3 with $452m, +$7.4k/s and
 * both divisions still unfounded, so corp-expand froze every discretionary spend
 * to bank their $90b combined cost - 140 DAYS away - which meant the warehouses
 * and cities that would have grown that $7.4k/s could never be bought either.
 * Every gate in the corp read as "still saving, be patient" while the corp was in
 * fact stationary. A target you cannot reach is not a target, it's a deadlock.
 *
 * Note these are CORP seconds: bonus time runs cycles ~10x faster in real time,
 * so the horizons that use this are wall-clock optimistic by roughly that much.
 * @param {number} funds @param {number} cost @param {number} profitPerSec
 */
export function secondsToAfford(funds, cost, profitPerSec) {
  if (!(cost > 0) || funds >= cost) return 0;
  if (!(profitPerSec > 0)) return Infinity;
  return (cost - funds) / profitPerSec;
}

export function pctStr(have, need) {
  if (!Number.isFinite(need) || need <= 0) return "-";
  return `${Math.min(100, (have / need) * 100).toFixed(0)}%`;
}

// ── Optimal boost-material quantities ────────────────────────────────────────
//
// The division production multiplier is, per warehouse,
//   ((1+0.002x)^c1 * (1+0.002y)^c2 * (1+0.002z)^c3 * (1+0.002w)^c4)^0.73
// maximised subject to the storage constraint s1*x + s2*y + s3*z + s4*w = S.
// The manual (8.3.2) solves this with Lagrange multipliers to a closed form:
//
//   x*s1 = (S - 500*(s1/c1 * (c2+c3+c4) - (s2+s3+s4))) * c1 / (c1+c2+c3+c4)
//
// (and symmetrically for the others). Splitting the space proportionally to the
// coefficients - what we did before - ignores the SIZES, and sizes dominate:
// Real Estate is 0.005/unit against Robots' 0.5, which is most of why the manual
// calls Agriculture the best starting industry at all. Exact, and ~1000x faster
// than the numeric libraries the manual benchmarks against it.

/**
 * Optimal unit counts of each boost material for `space` storage. Materials whose
 * optimum comes out negative at this budget are dropped and the rest re-solved
 * (manual 8.5) - at small budgets the right amount of Robots is simply zero.
 * Pure math, 0GB; unit-tested against the manual's own tables.
 *
 * @param {number} space - storage budget, in warehouse units
 * @param {{name: string, coefficient: number, size: number}[]} mats
 * @returns {Record<string, number>} units per material name (0 when dropped)
 */
export function optimalBoostQuantities(space, mats) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const m of mats) out[m.name] = 0;
  solveBoost(space, mats.filter(m => m.coefficient > 0 && m.size > 0), out);
  return out;
}

/** One Lagrange pass; recurses with the most-negative material removed. */
function solveBoost(space, mats, out) {
  if (!mats.length || !(space > 0)) return;
  const cSum = mats.reduce((sum, m) => sum + m.coefficient, 0);
  const sSum = mats.reduce((sum, m) => sum + m.size, 0);

  const units = new Map();
  let worst = null;
  for (const m of mats) {
    const x = ((space - 500 * ((m.size / m.coefficient) * (cSum - m.coefficient) - (sSum - m.size)))
      * (m.coefficient / cSum)) / m.size;
    units.set(m.name, x);
    if (x < 0 && (worst === null || x < units.get(worst))) worst = m.name;
  }
  if (worst !== null) {
    solveBoost(space, mats.filter(m => m.name !== worst), out);
    return;
  }
  for (const m of mats) out[m.name] = Math.floor(units.get(m.name));
}

// ── The growth loop (CONFIG.corp.growth) ─────────────────────────────────────
//
// Past the investment rounds the corp stops building toward fixed targets and
// splits a share of its surplus every cycle instead (manual 19.4.2). The split
// is decided in ONE place - lib/corp-steady.js, the only script that runs every
// cycle - but two of its biggest parts are bought by phases that run once a
// rotation and own the API calls for them: office seats (lib/corp-office.js)
// and warehouse levels (lib/corp-expand.js). Giving steady those calls would
// add ~100GB to the one script that must always be placed, so the money
// crosses over as ENVELOPES on globalThis instead: steady deposits each
// cycle's office and warehouse parts, the phases draw them down when their
// slot comes, and steady counts what is still in them as already spent. That
// keeps the manual's proportions whatever the rotation's pace - under bonus
// time a phase sees sixty cycles of deposits at once, not one.

/**
 * The corp config for the BitNode being played: CONFIG.corp with the node's
 * BITNODE entry and, in the money-run node, the MONEY_RUN overlay merged in.
 * The node comes from lib/corp-daemon.js (globalThis.gordCorpNode, re-published
 * every daemon tick) because asking the game costs RAM in every phase; until it
 * has been published this is the plain default. Only the growth loop and the
 * dividend policy read their settings through here - everything older reads
 * CONFIG.corp at module scope, which no overlay reaches.
 */
export function nodeCorp() {
  return forNode(globalThis.gordCorpNode ?? 0).corp;
}

/**
 * True when the growth loop runs in `round`. Pure - exported for the tests.
 * @param {number} round @param {{enabled: boolean, fromRound: number}} G
 */
export function growthActive(round, G) {
  return !!G && G.enabled === true && round >= G.fromRound;
}

/**
 * One cycle's growth budget, split the manual's way. Pure - exported for the
 * tests (and what the model in the config comment was run with).
 *
 *   surplus  = funds above the operating reserve, the objective lib/corp-expand
 *              is banking for, and whatever is already sitting in envelopes;
 *   Advert   = past advertFocusProfit, advertFocusFraction of FUNDS first (the
 *              manual's "at least 20%, personally up to 60%"), until awareness
 *              and popularity reach the game's cap;
 *   pool     = spendFraction of the rest; supportShare of it goes to the
 *              material divisions, and the remainder is divided in the manual's
 *              23rds - or 19ths once the wilsonAdvert part has dropped out.
 *
 * Wilson is not in here: it is a lump (each level costs double the last), so
 * the caller buys it BEFORE asking for this, out of funds, when it is cheap
 * enough (wilsonMaxFundsFraction).
 *
 * @param {{funds: number, saving: number, outstanding: number, profit: number, advertMaxed: boolean}} s
 * @param {any} G - CONFIG.corp.growth
 * @param {{fundsReserveFraction: number, advertFocusProfit: number, advertFocusFraction: number}} R
 */
export function growthBudget(s, G, R) {
  const out = {
    advert: 0,
    upgrades: { rawProduction: 0, employeeStats: 0, salesBot: 0, projectInsight: 0 },
    envelopes: { office: 0, warehouse: 0, supportOffice: 0, supportWarehouse: 0 },
  };
  const surplus = s.funds * (1 - R.fundsReserveFraction)
    - (s.saving > 0 ? s.saving : 0) - (s.outstanding > 0 ? s.outstanding : 0);
  if (!(surplus > 0) || !Number.isFinite(surplus)) return out;

  const focus = !s.advertMaxed && s.profit >= R.advertFocusProfit;
  const focusAdvert = focus ? Math.min(s.funds * R.advertFocusFraction, surplus) : 0;
  const pool = (surplus - focusAdvert) * G.spendFraction;
  const support = pool * G.supportShare;
  const core = pool - support;

  const weights = { ...G.budget };
  if (s.advertMaxed || focus) weights.wilsonAdvert = 0;
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  const part = key => (total > 0 ? (core * (weights[key] ?? 0)) / total : 0);

  out.advert = focusAdvert + part("wilsonAdvert");
  out.upgrades.rawProduction = part("rawProduction") * (1 - G.rawWarehouseShare);
  out.upgrades.employeeStats = part("employeeStats");
  out.upgrades.salesBot = part("salesBot");
  out.upgrades.projectInsight = part("projectInsight");
  out.envelopes.office = part("office");
  out.envelopes.warehouse = part("rawProduction") * G.rawWarehouseShare;
  out.envelopes.supportOffice = support * (1 - G.supportWarehouseShare);
  out.envelopes.supportWarehouse = support * G.supportWarehouseShare;
  return out;
}

/**
 * True once Advert can do nothing more for a division: the game clamps
 * awareness and popularity at Number.MAX_VALUE, and the manual's rule is to
 * stop buying Wilson and Advert there. @param {any} division - getDivision()
 */
export function advertMaxed(division) {
  return (division?.awareness ?? 0) >= Number.MAX_VALUE && (division?.popularity ?? 0) >= Number.MAX_VALUE;
}

// Office size pricing - the game's calculateOfficeSizeUpgradeCost, which no
// BitNode multiplier touches: 4e9 / 0.09 * 1.09^(size/3) * (1.09^(seats/3) - 1).
// (Written as the game writes it, 1 + 0.09, so the two agree to the last bit.)
const OFFICE_COST_BASE = 4e9 / 0.09;
const OFFICE_COST_MULT = 1 + 0.09;

/** Price of `seats` more seats on an office of `size`. Pure. */
export function officeUpgradeCost(size, seats) {
  return OFFICE_COST_BASE * OFFICE_COST_MULT ** (size / 3) * (OFFICE_COST_MULT ** (seats / 3) - 1);
}

/**
 * How many seats `budget` adds to an office of `size`, in one purchase - the
 * inverse of officeUpgradeCost. This is what lets an office grow by hundreds of
 * seats in ONE upgradeOfficeSize call instead of officeStep at a time, each with
 * its own price read: a 500-seat office is 166 steps of 3. Pure - exported for
 * the tests.
 * @param {number} size @param {number} budget @returns {number}
 */
export function seatsForBudget(size, budget) {
  if (!(budget > 0) || !(size >= 0) || !Number.isFinite(budget)) return 0;
  const per = OFFICE_COST_BASE * OFFICE_COST_MULT ** (size / 3);
  let seats = Math.floor((3 * Math.log(1 + budget / per)) / Math.log(OFFICE_COST_MULT));
  // The log can round a hair high; never return a count the budget can't pay.
  while (seats > 0 && officeUpgradeCost(size, seats) > budget) seats--;
  return seats > 0 && Number.isFinite(seats) ? seats : 0;
}

/** @returns {Record<string, {balance: number, tendedAt: number}>} */
function envelopeStore() {
  return globalThis.gordCorpEnvelopes ?? (globalThis.gordCorpEnvelopes = {});
}

/** What is waiting in one envelope. */
export function envelopeBalance(name) {
  const e = globalThis.gordCorpEnvelopes?.[name];
  return e && e.balance > 0 ? e.balance : 0;
}

/** Everything set aside across all envelopes - funds the split must not count again. */
export function envelopesOutstanding() {
  let sum = 0;
  for (const e of Object.values(globalThis.gordCorpEnvelopes ?? {})) sum += e.balance > 0 ? e.balance : 0;
  return sum;
}

/**
 * Add this cycle's parts to the envelopes. An envelope its phase has not
 * tended for `staleMs` is emptied and skipped instead: that phase has stopped
 * being placed (the build phases run on borrowed RAM), and money parked for a
 * script that is not running would just sit there. Its part goes back into the
 * surplus and is re-split next cycle. Returns the names released, for the log.
 * @param {Record<string, number>} amounts @param {number} now @param {number} staleMs
 * @returns {string[]}
 */
export function depositEnvelopes(amounts, now, staleMs) {
  const store = envelopeStore();
  const released = [];
  for (const [name, amount] of Object.entries(amounts)) {
    const e = store[name] ?? (store[name] = { balance: 0, tendedAt: now });
    if (now - e.tendedAt > staleMs) {
      if (e.balance > 0) released.push(name);
      e.balance = 0;
      continue;
    }
    if (amount > 0 && Number.isFinite(amount)) e.balance += amount;
  }
  return released;
}

/**
 * Take `amount` out of an envelope (a phase calls this with what it actually
 * spent), and stamp it as tended. Call it with 0 on a pass that bought
 * nothing - the stamp is what tells lib/corp-steady.js the phase is alive.
 * @param {string} name @param {number} amount @param {number} now
 */
export function drawEnvelope(name, amount, now) {
  const store = envelopeStore();
  const e = store[name] ?? (store[name] = { balance: 0, tendedAt: now });
  e.balance = Math.max(0, e.balance - (amount > 0 ? amount : 0));
  e.tendedAt = now;
}

/**
 * What a phase may spend right now from an envelope part: the part itself,
 * capped by what the corp can pay without touching the operating reserve or
 * the banked objective. The envelope is a claim on funds, not a bank account -
 * a product, a boost order or a dividend may have spent the money since it was
 * set aside.
 * @param {NS} ns @param {number} amount
 */
export function envelopeSpendable(ns, amount) {
  const funds = corpFunds(ns);
  const free = funds * (1 - CO.fundsReserveFraction) - (globalThis.gordCorpSavingFor ?? 0);
  return Math.max(0, Math.min(amount, free));
}

// ── Journal aggregation ──────────────────────────────────────────────────────
//
// Discrete milestones (a division founded, a round accepted) go straight to
// emitEvent. The REPEATED spends - an Advert level every cycle, a warehouse level
// every pass - would drown the journal logged raw, so they accumulate here and
// flush as one summary line per interval. The store lives on globalThis because
// the build phases are one-shots: they exit between passes, so module state
// can't carry a tally, but globalThis persists until an install/reload - exactly
// the durability a log throttle wants.

/**
 * Merge `add` (numbers, summed per key) into the named accumulator; then, if
 * anything is pending and at least `ms` has passed since this key last flushed,
 * return the accumulated record and reset it. Returns null while throttled or
 * empty, so callers can simply `if (rec) emitEvent(summariseCounts(...))`.
 *
 * Key convention: "$spend" accumulates money and is rendered as a total by
 * summariseCounts; every other key is a labelled count.
 * @param {string} key @param {number} ms @param {Record<string, number>} add
 * @returns {Record<string, number> | null}
 */
export function accumulateJournal(key, ms, add) {
  const store = globalThis.gordCorpJournalAccum ?? (globalThis.gordCorpJournalAccum = {});
  /** @type {Record<string, number>} */
  const rec = store[key] ?? (store[key] = {});
  for (const [k, v] of Object.entries(add)) {
    if (v > 0) rec[k] = (rec[k] ?? 0) + v;
  }

  const at = globalThis.gordCorpLogAt ?? (globalThis.gordCorpLogAt = {});
  const now = Date.now();
  if (!Object.values(rec).some(v => v > 0)) return null;
  if (now - (at[key] ?? 0) < ms) return null;
  at[key] = now;
  store[key] = {};
  return rec;
}

/**
 * Render an accumulator record as one journal-ready clause: counts as
 * "Label +N", the "$spend" key as a trailing money total. ns is only used for
 * format.number (0GB).
 * @param {NS} ns @param {Record<string, number>} rec
 */
export function summariseCounts(ns, rec) {
  const parts = [];
  let spend = 0;
  for (const [k, v] of Object.entries(rec)) {
    if (k === "$spend") spend = v;
    else if (v > 0) parts.push(`${k} +${v}`);
  }
  return parts.join(", ") + (spend > 0 ? ` ($${ns.format.number(spend)})` : "");
}
