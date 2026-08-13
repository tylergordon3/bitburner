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
import { safe, did, affordable, divisionByIndustry, currentRound, distributeJobs, accumulateJournal, summariseCounts } from "./corp-lib.js";

const CO = CONFIG.corp;
const CITIES = /** @type {any[]} */ (CO.cities);
const PRODUCT_CITY = /** @type {any} */ (CO.productCity);

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

/** @param {NS} ns */
function pass(ns) {
  const round = currentRound();

  const agri = divisionByIndustry(ns, CO.agriDivision.industry);
  const chem = divisionByIndustry(ns, CO.chemicalDivision.industry);
  const tobacco = divisionByIndustry(ns, CO.tobaccoDivision.industry);

  let agriDone = false;
  let chemDone = true; // vacuously true until Chemical exists

  if (agri) {
    const target = CO.agriTargets[round] ?? CO.agriTargetsMax;
    agriDone = materialOffices(ns, agri, CO.agriDivision.industry, target, round);
  }
  if (chem) {
    const target = CO.chemicalTargets[round] ?? CO.chemicalTargetsMax;
    chemDone = materialOffices(ns, chem, CO.chemicalDivision.industry, target, round);
  }
  if (tobacco) productOffices(ns, tobacco, round);

  // Handshake: lib/corp-invest.js gates accepting rounds 1-2 on this (offices at
  // size and staffed), and lib/corp-steady.js holds corp-wide upgrade spending
  // until both this and gordCorpExpandDone are true.
  globalThis.gordCorpOfficeDone = agriDone && chemDone;

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
// pass() (see there). Module scope is per-RUN scope for a one-shot, so it's
// zeroed by construction each launch; the CROSS-pass throttling lives in
// accumulateJournal's globalThis store.
const _grown = { seats: 0, hires: 0, advert: 0, $spend: 0 };

// ── Material divisions (Agriculture / Chemical) ──────────────────────────────

/**
 * Grow, staff and assign every office of a material division for the current
 * round, plus its Advert level (Chemical's advert target is 0 - the manual says
 * never buy it advert - so the call is skipped there). Returns true when every
 * city office is at target size and fully hired - the readiness half of the
 * round-1/2 investment gate.
 * @param {NS} ns @param {number} round
 */
function materialOffices(ns, divName, industry, target, round) {
  let ready = true;

  // Resolve the staffing plan ONCE per division (the RP-gate read behind it is a
  // getDivision call - per-city it was 6 reads for one answer), and journal the
  // mode as an EDGE: "switched to the producing split" marks the round-1/2 RP gate
  // being banked, which is the milestone the whole early game waits on.
  const plan = staffingPlan(ns, divName, industry, round);
  noteStaffingMode(divName, plan.label);

  for (const city of CITIES) {
    const office = growAndHire(ns, divName, city, target.office);
    if (!office) {
      ready = false;
      continue;
    }
    if (office.size < target.office || office.numEmployees < office.size) ready = false;

    assignJobs(ns, divName, city, office, plan.jobs(office.numEmployees));
  }

  if ((target.advert ?? 0) > 0) advertToLevel(ns, divName, target.advert);
  return ready;
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
 * The design office (PRODUCT_CITY) gets the big budget and the "progress" split -
 * product development speed is the whole point of rounds 3-4; support offices get
 * the R&D-heavy split to bank the RP that product rating keys off. Advert for the
 * product division is deliberately NOT here: corp-steady drives it every cycle
 * alongside Wilson, which is faster than a rotation slot.
 * @param {NS} ns @param {number} round
 */
function productOffices(ns, divName, round) {
  for (const city of CITIES) {
    const isDesign = city === PRODUCT_CITY;
    const targetSize = isDesign ? CO.tobaccoTargets.designOffice : CO.tobaccoTargets.supportOffice;
    const office = growAndHire(ns, divName, city, targetSize);
    if (!office) continue;

    const ratios = isDesign ? CO.jobsProductMain : CO.jobsProductSupport;
    assignJobs(ns, divName, city, office, distributeJobs(office.numEmployees, ratios));
  }
}

// ── Building blocks ──────────────────────────────────────────────────────────

/**
 * Grow the office toward `targetSize` (affordability-gated, officeStep seats at a
 * time) and hire every open seat. Returns the office's final state, or null when
 * the city has no office at all.
 *
 * Seats are exempt from the savings floor (affordable's ignoreSaving): they're
 * capped by the round target and every hire is a producing worker, so growing
 * them while saving for a division founding shortens the save instead of
 * starving it - see affordable() in lib/corp-lib.js.
 * @param {NS} ns
 */
function growAndHire(ns, divName, city, targetSize) {
  const c = ns.corporation;
  let office = safe(() => c.getOffice(divName, /** @type {any} */ (city)));
  if (!office) return null;

  while (office.size < targetSize) {
    const step = Math.min(CO.officeStep, targetSize - office.size);
    const cost = safe(() => c.getOfficeSizeUpgradeCost(divName, /** @type {any} */ (city), step)) ?? Infinity;
    if (!affordable(ns, cost, /* ignoreSaving */ true)) break;
    if (!did(() => c.upgradeOfficeSize(divName, /** @type {any} */ (city), step))) break;
    _grown.seats += step;
    _grown.$spend += cost;
    office = safe(() => c.getOffice(divName, /** @type {any} */ (city))) ?? office;
  }

  while (office.numEmployees < office.size) {
    if (!safe(() => c.hireEmployee(divName, /** @type {any} */ (city)))) break;
    office.numEmployees++;
    _grown.hires++;
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
