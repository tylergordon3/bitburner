// lib/corp-office.js
//
// Build phase 2 of 4: PEOPLE - office sizes, hiring, job assignment, and the
// material divisions' Advert levels. A bounded one-shot run in rotation by
// lib/corp-daemon.js; see lib/corp-lib.js for why the corp manager is split.
//
// ── The early-round protocol (manual 19.2 / 19.3) ────────────────────────────
// Rounds 1 and 2 are not ratio problems, they're a fixed sequence, and this file
// implements it literally:
//
//   Round 1: grow the HQ office 3 -> 4 and put ALL FOUR employees on R&D until the
//   division banks 55 RP (round1ResearchPoints). Only then switch to the
//   O1/E1/B1/M1 producing split. RP banked this early lifts the quality of
//   everything the division ever makes, and quality is what makes early Plants
//   sellable at all.
//
//   Round 2: Agriculture 4 -> 8, Chemical stays at 3, EVERYONE on R&D until
//   Agriculture holds ~700 RP and Chemical ~390 (round2ResearchPoints). The manual
//   calls this wait mandatory - it's what the round exists for. Then the fixed
//   splits: Agri O3/E1/B2/M2, Chem O1/E1/B1. lib/corp-invest.js gates accepting
//   the round-2 offer on the same RP numbers, so the wait can't be skipped by the
//   investment logic either.
//
//   Round 3+: material divisions run the Engineer-heavy raw-production split
//   (EngineerProduction, not RP, is what drives material quality now); the Tobacco
//   design office runs the "progress" split to develop products fast, and its
//   support offices sit on R&D.
//
// ── Assignment protocol: zero everything, then set ───────────────────────────
// setJobAssignment moves employees between a job and the Unassigned pool, and
// REDUCING one role is what frees the bodies that INCREASING another needs. Set
// roles one at a time in a fixed order and the calls that grow a role can fail
// because the calls that would shrink another haven't happened yet. The manual's
// stated protocol - set every job to 0, then set every job to its target - makes
// order irrelevant, so that's what assignJobs does, skipping offices already in
// the desired shape so we never churn a correct assignment.

import { CONFIG } from "./config.js";
import { emitEvent } from "./events.js";
import {
  safe, did, affordable, divisionByIndustry, designCity, currentRound, roundKnown, offerHoldActive, distributeJobs,
  accumulateJournal, summariseCounts,
  nodeCorp, growthActive, seatsForBudget, envelopeBalance, envelopeSpendable, drawEnvelope,
} from "./corp-lib.js";

const CO = CONFIG.corp;
const CITIES = /** @type {any[]} */ (CO.cities);

// Every assignable job, for the zero-everything half of the protocol. The API's
// own names - not a tunable.
const ALL_JOBS = ["Operations", "Engineer", "Business", "Management", "Research & Development", "Intern"];
const RND = "Research & Development";

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  if (!ns.corporation.hasCorporation()) return;
  try {
    pass(ns);
  } catch (e) {
    ns.print(`corp-office error: ${String(e)}`);
  }
  // One-shot: exit so the RAM is only held transiently.
}

/**
 * One pass. Exported for the tests.
 * @param {NS} ns
 */
export function pass(ns) {
  // No round published yet (first rotation after a reload): skip rather than
  // staff against the round-1 default - see roundKnown. On an established corp
  // that default re-split every Agriculture office to the round-1 jobs.
  if (!roundKnown()) {
    ns.print("[corp-office] waiting for corp-invest to publish the round");
    return;
  }
  const round = currentRound();

  // This pass's tally starts from zero - see _grown.
  _grown.seats = 0;
  _grown.hires = 0;
  _grown.advert = 0;
  _grown.$spend = 0;

  // A ready round is being held for its offer to settle: grow nothing and buy no
  // Advert this pass (seats and Advert are money the valuation doesn't carry).
  // Hiring into seats already bought is free, and job assignment costs nothing,
  // so both carry on.
  _buying = !offerHoldActive();
  _need = 0;

  // The growth loop (CONFIG.corp.growth): past the rounds the targets below
  // are only FLOORS, and each office also grows by its part of what
  // lib/corp-steady.js has set aside since the last pass - the "office"
  // envelope for the product division, "supportOffice" for the material ones.
  // Both balances are read once, here, so every office's part is a share of
  // the same figure rather than of whatever the office before it left.
  const G = nodeCorp().growth;
  const growing = growthActive(round, G);
  _hiresLeft = G.maxHiresPerPass;
  _drawn.office = 0;
  _drawn.supportOffice = 0;
  const officeEnvelope = growing ? envelopeBalance("office") : 0;
  const supportEnvelope = growing ? envelopeBalance("supportOffice") : 0;
  // What the whole pass may spend out of them: the corp's free funds as they
  // stand NOW, counted down as seats are bought. Asked per office instead,
  // "funds above the 10% reserve" is a fresh 90% each time, and six offices in
  // a row would take the corp to a millionth of what it held.
  _growthFree = growing ? envelopeSpendable(ns, Infinity) : 0;

  const agri = divisionByIndustry(ns, CO.agriDivision.industry);
  const chem = divisionByIndustry(ns, CO.chemicalDivision.industry);
  const tobacco = divisionByIndustry(ns, CO.tobaccoDivision.industry);

  let agriDone = false;
  let chemDone = true; // vacuously true until Chemical exists

  // A division that isn't there leaves its part to the other one (a corp built
  // by hand needn't have a Chemical division at all).
  const agriPart = !chem ? 1 : !agri ? 0 : G.supportAgriShare;
  if (agri) {
    const target = CO.agriTargets[round] ?? CO.agriTargetsMax;
    agriDone = materialOffices(ns, agri, CO.agriDivision.industry, target, round,
      (supportEnvelope * agriPart) / CITIES.length);
  }
  if (chem) {
    const target = CO.chemicalTargets[round] ?? CO.chemicalTargetsMax;
    chemDone = materialOffices(ns, chem, CO.chemicalDivision.industry, target, round,
      (supportEnvelope * (1 - agriPart)) / CITIES.length);
  }
  if (tobacco) productOffices(ns, tobacco, round, growing ? G : null, officeEnvelope);

  // Settle the envelopes with what was actually spent. Stamped even when that
  // is nothing: the stamp is how corp-steady knows this phase is still being
  // placed (see depositEnvelopes). With no material division at all there is
  // nothing the support budget can ever buy here, so it is handed straight back.
  if (growing) {
    const now = Date.now();
    drawEnvelope("office", _drawn.office, now);
    drawEnvelope("supportOffice", agri || chem ? _drawn.supportOffice : supportEnvelope, now);
  }

  // Handshake: lib/corp-invest.js gates accepting rounds 1-2 on this (offices at
  // size and staffed), and lib/corp-steady.js holds corp-wide upgrade spending
  // until both this and gordCorpExpandDone are true.
  globalThis.gordCorpOfficeDone = agriDone && chemDone;

  // What the material divisions' offices still need to reach this round's
  // targets (seats + Advert), for lib/corp-expand.js: in rounds 1-2 its warehouse
  // climb leaves this much untouched, so the offices - cheaper, and first in the
  // manual's order - aren't starved by a phase that happens to run before this
  // one. Stamped with the round and the time: a figure for another round, or one
  // nobody has refreshed, is not a floor (see corp-expand's warehouseClimbFloor).
  globalThis.gordCorpOfficeNeed = { round, cost: _need, at: Date.now() };

  // Batched journal line for this pass's office growth, at most every
  // journal.buildMs (accumulates across passes while throttled).
  const rec = accumulateJournal("officeBuild", CO.journal.buildMs, {
    "office seats": _grown.seats,
    hires: _grown.hires,
    "Advert levels": _grown.advert,
    $spend: _grown.$spend,
  });
  if (rec) emitEvent(`[corp] Grew: ${summariseCounts(ns, rec)}`, "corp");

  ns.print(`[corp-office] round ${round} | agri ${agri ? (agriDone ? "ready" : "growing") : "-"} | ` +
    `chem ${chem ? (chemDone ? "ready" : "growing") : "-"} | tobacco ${tobacco ? "managed" : "-"}`);
}

// This pass's growth tally, flushed as one batched journal line at the end of
// pass() (see there); the CROSS-pass throttling lives in accumulateJournal's
// globalThis store. Zeroed at the top of pass(), NOT by construction: module
// scope is not per-run scope, even for a one-shot. The game compiles a script
// once per source text and hands every later run the same module instance
// (NetscriptJSEvaluator's moduleCache), so this object is the one the last
// rotation left behind. Unreset it held every seat the corp had ever bought,
// and each pass fed that lifetime total into the journal accumulator again -
// "Grew: office seats +18" every two minutes from a corp that had grown nothing.
const _grown = { seats: 0, hires: 0, advert: 0, $spend: 0 };

// Per-pass state, set at the top of pass() (for the same reason): whether this
// pass may spend at all (false while a ready round's
// offer is being held), and the running total of what the MATERIAL divisions'
// offices still need to reach their round targets - published as
// gordCorpOfficeNeed.
let _buying = true;
let _need = 0;

// Also per pass, and reset there: how many hireEmployee calls the pass has
// left (growth.maxHiresPerPass - an office can grow by a thousand seats in one
// purchase, and each seat is its own API call), and what the pass has spent
// out of each growth envelope.
let _hiresLeft = Infinity;
const _drawn = { office: 0, supportOffice: 0 };
let _growthFree = 0;

// ── Material divisions (Agriculture / Chemical) ──────────────────────────────

/**
 * Grow, staff and assign every office of a material division for the current
 * round, plus its Advert level (Chemical's advert target is 0 - the manual says
 * never buy it advert - so the call is skipped there). Returns true when every
 * city office is at target size and fully hired - the readiness half of the
 * round-1/2 investment gate.
 *
 * `growthPerCity` is each office's part of the "supportOffice" envelope - 0
 * outside the growth loop - spent on seats past the round target. The manual's
 * support divisions get a small budget, but not none: the product's effective
 * rating is capped at inputQuality * sqrt(rating), input quality is mostly
 * EngineerProduction here, and a product division that out-eats Agriculture
 * tops itself up with quality-1 Plants from the market.
 * @param {NS} ns @param {number} round @param {number} [growthPerCity]
 */
function materialOffices(ns, divName, industry, target, round, growthPerCity = 0) {
  let ready = true;

  // Resolve the staffing plan ONCE per division (the RP-gate read behind it is a
  // getDivision call - per-city it was 6 reads for one answer), and journal the
  // mode as an EDGE: "switched to the producing split" marks the round-1/2 RP gate
  // being banked, which is the milestone the whole early game waits on.
  const plan = staffingPlan(ns, divName, industry, round);
  noteStaffingMode(divName, plan.label);

  for (const city of CITIES) {
    const office = growAndHire(ns, divName, city, target.office, "supportOffice", growthPerCity);
    if (!office) {
      ready = false;
      continue;
    }
    if (office.size < target.office || office.numEmployees < office.size) ready = false;

    // Seats this office is still short of its round target (it couldn't afford
    // them this pass): their cost goes into the figure corp-expand reserves. An
    // unreadable cost counts as 0 - never let a bad read become a floor.
    if (office.size < target.office) {
      _need += safe(() => ns.corporation.getOfficeSizeUpgradeCost(
        divName, /** @type {any} */ (city), target.office - office.size)) ?? 0;
    }

    assignJobs(ns, divName, city, office, plan.jobs(office.numEmployees));
  }

  if ((target.advert ?? 0) > 0) {
    advertToLevel(ns, divName, target.advert);
    _need += advertCostToLevel(
      safe(() => ns.corporation.getHireAdVertCost(divName)) ?? 0,
      safe(() => ns.corporation.getDivision(divName).numAdVerts) ?? target.advert,
      target.advert,
      CO.advertCostMult,
    );
  }
  return ready;
}

/**
 * Cost of taking Advert from `level` to `target`, given the price of the next
 * level - each level costs `mult` times the last. 0 when already there (or the
 * price can't be read). Pure - exported for the tests.
 * @param {number} nextCost @param {number} level @param {number} target @param {number} mult
 */
export function advertCostToLevel(nextCost, level, target, mult) {
  if (!(nextCost > 0) || !Number.isFinite(nextCost)) return 0;
  let total = 0;
  let cost = nextCost;
  for (let l = level; l < target; l++) {
    total += cost;
    cost *= mult;
  }
  return total;
}

/**
 * Journal a division's staffing mode when it CHANGES - the interesting edges are
 * "banking RP" -> "producing split" (the RP gate banked) and back after an office
 * grows into a new round. Remembered on globalThis because this script exits
 * between passes.
 */
function noteStaffingMode(divName, label) {
  const modes = globalThis.gordCorpStaffMode ?? (globalThis.gordCorpStaffMode = {});
  if (modes[divName] === label) return;
  modes[divName] = label;
  emitEvent(`[corp] ${divName}: staffing set to ${label}`, "corp");
}

/**
 * The staffing plan a material division should be running right now: a label for
 * the journal's mode-change edge, and a jobs(headcount) closure the per-city loop
 * feeds each office's size into.
 *
 * Rounds 1-2: ALL R&D until the division's RP gate is banked, then the manual's
 * fixed split for that round (stored as weights and normalised, so an office
 * grown past the scripted size by hand still gets the same shape). Round 3+: the
 * Engineer-heavy raw-production ratio.
 * @param {NS} ns @param {number} round
 * @returns {{label: string, jobs: (headcount: number) => Record<string, number>}}
 */
function staffingPlan(ns, divName, industry, round) {
  if (round <= 2) {
    const gate = round === 1
      ? CO.round1ResearchPoints
      : CO.round2ResearchPoints[industry] ?? 0;
    const rp = safe(() => ns.corporation.getDivision(divName).researchPoints) ?? 0;
    if (rp < gate) {
      // Label must be STABLE - noteStaffingMode journals on label change, so live
      // RP progress in here would re-fire the "edge" every pass.
      return {
        label: `all R&D (banking RP toward ${gate})`,
        jobs: headcount => ({ [RND]: headcount }),
      };
    }

    const weights = CO.earlyJobs[round]?.[industry];
    if (weights) {
      const ratios = normalise(weights);
      return {
        label: `round-${round} producing split (RP gate ${gate} banked)`,
        jobs: headcount => distributeJobs(headcount, ratios),
      };
    }
  }

  return {
    label: "raw-production split (Engineer-heavy)",
    jobs: headcount => distributeJobs(headcount, CO.jobsMaterialProd),
  };
}

// ── Product division (Tobacco) ───────────────────────────────────────────────

/**
 * The design office (corp-lib's designCity) gets the big budget and the "progress" split -
 * product development speed is the whole point of rounds 3-4; support offices get
 * the R&D-heavy split to bank the RP that product rating keys off. Advert for the
 * product division is deliberately NOT here: corp-steady drives it every cycle
 * alongside Wilson, which is faster than a rotation slot.
 *
 * `G` is CONFIG.corp.growth while the growth loop runs, else null. With it,
 * tobaccoTargets is only where the offices START: each then grows by its part
 * of `envelope` (the "office" budget corp-steady has set aside - the manual's
 * 8/23 of everything the corp spends), half to the design office and the rest
 * split between the others, with no ceiling. Six offices of 500 - the 3,000
 * employees of "Small town" - is ~$4.6e17 of seats; nothing here knows that
 * number, it is just where the budget passes on its way up.
 * @param {NS} ns @param {number} round @param {any} [G] @param {number} [envelope]
 */
function productOffices(ns, divName, round, G = null, envelope = 0) {
  // The one office that develops products, resolved the same way corp-steady
  // resolves it. Grown to designOffice seats; every other city is a support
  // office. Getting this wrong doesn't just mis-size an office - it hands the
  // "progress" split to a city that isn't developing anything.
  const design = designCity(ns, divName);
  const mainPart = G ? (G.mainOfficeShareByRound[round] ?? G.mainOfficeShare) : 0;
  const corp = G ? safe(() => ns.corporation.getCorporation()) : null;
  const profit = (corp?.revenue ?? 0) - (corp?.expenses ?? 0);

  let employees = 0;
  let seats = 0;
  for (const city of CITIES) {
    const isDesign = city === design;
    const targetSize = isDesign ? CO.tobaccoTargets.designOffice : CO.tobaccoTargets.supportOffice;
    const part = isDesign ? mainPart : (1 - mainPart) / (CITIES.length - 1);
    const office = growAndHire(ns, divName, city, targetSize, "office", envelope * part);
    if (!office) continue;
    employees += office.numEmployees;
    seats += office.size;

    const ratios = productJobRatios(isDesign, round, profit, G);
    assignJobs(ns, divName, city, office, distributeJobs(office.numEmployees, ratios));
  }

  // For the dashboard and tools/corp-status.js (neither of which this costs
  // anything): the product division's headcount, i.e. progress toward the
  // 3,000-employee achievement.
  globalThis.gordCorpStaff = { division: divName, employees, seats, at: Date.now() };
}

/**
 * The job split for one product-division office. Pure - exported for the tests.
 *
 * Through round 4 (and whenever the growth loop is off) it is the manual's
 * "progress" setup: the design office develops, the others bank RP. AFTER
 * round 4 the manual changes both: the design office runs "profit-progress" -
 * re-weighted toward Business once profit passes mainRichProfit - and the
 * other offices put half their staff on R&D and the rest in the "profit"
 * setup. That second half is where the Business staff who sell the product in
 * five of its six cities come from; on the old split each of those cities had
 * one.
 * @param {boolean} isDesign @param {number} round @param {number} profit
 * @param {any} G - CONFIG.corp.growth, or null when the loop is off
 * @returns {Record<string, number>}
 */
export function productJobRatios(isDesign, round, profit, G) {
  if (!G || round <= CO.investmentRounds) return isDesign ? CO.jobsProductMain : CO.jobsProductSupport;
  if (!isDesign) return G.jobsSupport;
  return profit >= G.mainRichProfit ? G.jobsMainRich : G.jobsMain;
}

// ── Building blocks ──────────────────────────────────────────────────────────

/**
 * Grow the office toward `targetSize` (affordability-gated, officeStep seats at a
 * time) and hire every open seat. Returns the office's final state, or null when
 * the city has no office at all.
 *
 * Seats used to be exempt from the savings floor, on the reasoning that each hire
 * is a producing worker and so growing them shortens the save. They are not any
 * more: an office upgrade is itself a multi-billion LUMP, big enough to drain the
 * fund it was exempted from, and the exemption existed only because the ordering
 * underneath was broken - seats could never win a cheapest-first race against
 * warehouse levels, so they were given a bypass instead of a turn. Now that
 * lib/corp-expand.js banks for one objective at a time they get their turn
 * honestly, and honouring the floor is what lets a ~$9b city ever be reached.
 *
 * `growth` (the growth loop only) is this office's part of the `envelope`
 * budget, spent on seats PAST the target: as many as it buys, in one
 * upgradeOfficeSize call (seatsForBudget). The price is still read from the
 * game before buying, and - upgradeOfficeSize returns silently when the corp
 * can't pay - it is the office's new size that counts as "bought".
 *
 * Hiring fills one seat per API call, so it stops at the pass's hire cap
 * (_hiresLeft) and carries on next rotation; the returned office then has
 * fewer employees than seats, which every caller already copes with.
 * @param {NS} ns @param {number} targetSize
 * @param {"office" | "supportOffice"} [envelope] @param {number} [growth]
 */
function growAndHire(ns, divName, city, targetSize, envelope = "office", growth = 0) {
  const c = ns.corporation;
  let office = safe(() => c.getOffice(divName, /** @type {any} */ (city)));
  if (!office) return null;

  while (_buying && office.size < targetSize) {
    const step = Math.min(CO.officeStep, targetSize - office.size);
    const cost = safe(() => c.getOfficeSizeUpgradeCost(divName, /** @type {any} */ (city), step)) ?? Infinity;
    if (!affordable(ns, cost)) break;
    if (!did(() => c.upgradeOfficeSize(divName, /** @type {any} */ (city), step))) break;
    _grown.seats += step;
    _grown.$spend += cost;
    office = safe(() => c.getOffice(divName, /** @type {any} */ (city))) ?? office;
  }

  if (_buying && growth > 0 && office.size >= targetSize) {
    const budget = Math.min(growth, _growthFree);
    const seats = seatsForBudget(office.size, budget);
    const cost = seats > 0
      ? safe(() => c.getOfficeSizeUpgradeCost(divName, /** @type {any} */ (city), seats)) ?? Infinity
      : Infinity;
    // (The hair of slack is for the last bit of a float, nothing more.)
    if (cost <= budget * (1 + 1e-9) && affordable(ns, cost)
      && did(() => c.upgradeOfficeSize(divName, /** @type {any} */ (city), seats))) {
      const after = safe(() => c.getOffice(divName, /** @type {any} */ (city))) ?? office;
      if (after.size > office.size) {
        _grown.seats += after.size - office.size;
        _grown.$spend += cost;
        _drawn[envelope] += cost;
        _growthFree -= cost;
        office = after;
      }
    }
  }

  while (office.numEmployees < office.size && _hiresLeft > 0) {
    if (!safe(() => c.hireEmployee(divName, /** @type {any} */ (city)))) break;
    office.numEmployees++;
    _grown.hires++;
    _hiresLeft--;
  }

  return office;
}

/**
 * Apply `desired` counts using the zero-then-set protocol (see the header). Skips
 * the office entirely when it's already in the desired shape - re-issuing an
 * identical assignment is harmless to the game but churns employeeNextJobs for
 * nothing every rotation.
 * @param {NS} ns @param {any} office @param {Record<string, number>} desired
 */
function assignJobs(ns, divName, city, office, desired) {
  const current = office.employeeJobs ?? {};
  const dirty = ALL_JOBS.some(job => (desired[job] ?? 0) !== (current[job] ?? 0));
  if (!dirty) return;

  const c = ns.corporation;
  for (const job of ALL_JOBS) {
    safe(() => c.setJobAssignment(divName, /** @type {any} */ (city), /** @type {any} */ (job), 0));
  }
  for (const job of ALL_JOBS) {
    const n = desired[job] ?? 0;
    if (n > 0) safe(() => c.setJobAssignment(divName, /** @type {any} */ (city), /** @type {any} */ (job), n));
  }
}

/** Hire Advert toward a target level, one affordable step at a time. */
function advertToLevel(ns, divName, targetLevel) {
  const c = ns.corporation;
  if (!_buying) return; // a ready round's offer is being held - see pass()
  for (let i = 0; i < CO.upgradeSteps; i++) {
    const level = safe(() => c.getDivision(divName).numAdVerts) ?? 0;
    if (level >= targetLevel) return;
    const cost = safe(() => c.getHireAdVertCost(divName)) ?? Infinity;
    if (!affordable(ns, cost)) return;
    if (!did(() => c.hireAdVert(divName))) return;
    _grown.advert++;
    _grown.$spend += cost;
  }
}

/**
 * Weights -> ratios summing to 1, for distributeJobs.
 * @param {Record<string, number>} weights @returns {Record<string, number>}
 */
function normalise(weights) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  /** @type {Record<string, number>} */
  const out = {};
  for (const [k, v] of Object.entries(weights)) out[k] = v / total;
  return out;
}
