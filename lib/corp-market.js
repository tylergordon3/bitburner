// lib/corp-market.js
//
// Build phase 3 of 4: MATERIALS and RESEARCH - input stocking, boost materials,
// selling, Smart Supply, and research purchases. A bounded one-shot run in
// rotation by lib/corp-daemon.js; see lib/corp-lib.js for why the corp manager is
// split.
//
// ── buyMaterial orders, not bulkPurchase ─────────────────────────────────────
// The old builder used bulkPurchase, which buys instantly but demands the full
// price UP FRONT - so it was affordability-gated, and a poor corp simply never
// stocked its boost materials. The manual is emphatic that this is backwards:
// buyMaterial places a per-second purchase ORDER filled during the PURCHASE state,
// and orders are allowed to take the corp into DEBT. The intended round-1/2 shape
// is to spend the funds on the buildout and then go negative buying boost
// materials at the end of the round; debt from long-term purchases doesn't hurt
// valuation the way missing production multipliers do. So this file:
//
//   1. computes each material's TARGET (its share of the warehouse slice),
//   2. sets an order of shortfall / materialBuySeconds per second - sized so the
//      order completes right around this phase's next rotation slot,
//   3. clears the order to 0 once the target is reached, so an order can never
//      run away and choke the warehouse the outputs need.
//
// No affordability gate on ordering, by design. The warehouse slice fractions are
// the real spending cap: a material can never be ordered past its share of the
// warehouse, however rich or poor the corp is.
//
// ── Research policy (manual 6.3) ─────────────────────────────────────────────
// Nothing before round 4 - round-3 RP gain is too low for any purchase to repay
// itself, and the pool feeds product rating. From round 4, strict priority order,
// each purchase capped to a fraction of the CURRENT pool by tier: the lab and the
// Market-TAs at 1/2 (TA.II is the single biggest round-3+ upgrade), stat research
// at 1/5, production research at 1/10. Draining the pool right before a product
// finishes costs more than any research returns.

import { CONFIG } from "./config.js";
import { emitEvent } from "./events.js";
import { safe, did, divisionByIndustry, currentRound, accumulateJournal, summariseCounts } from "./corp-lib.js";

const CO = CONFIG.corp;
const CITIES = /** @type {any[]} */ (CO.cities);
const MATERIAL_SIZE = CO.materialSize;
const BOOST_MATERIALS = /** @type {any[]} */ (CO.boostMaterials);
const RESEARCH_PRIORITY = /** @type {any[]} */ (CO.researchPriority);

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  if (!ns.corporation.hasCorporation()) return;
  try {
    pass(ns);
  } catch (e) {
    ns.print(`corp-market error: ${String(e)}`);
  }
  // One-shot: exit so the RAM is only held transiently.
}

/** @param {NS} ns */
function pass(ns) {
  const round = currentRound();

  const divisions = [
    { name: divisionByIndustry(ns, CO.agriDivision.industry), industry: CO.agriDivision.industry },
    { name: divisionByIndustry(ns, CO.chemicalDivision.industry), industry: CO.chemicalDivision.industry },
    { name: divisionByIndustry(ns, CO.tobaccoDivision.industry), industry: CO.tobaccoDivision.industry },
  ].filter(d => d.name);

  const smartSupply = safe(() => ns.corporation.hasUnlock("Smart Supply")) ?? false;

  for (const div of divisions) {
    manageDivision(ns, div.name, div.industry, smartSupply);
    manageResearch(ns, div.name, round);
  }

  // Throttled order-activity line: while warehouses fill toward their targets
  // this fires at most every journal.ordersMs; once stock is at target no orders
  // are placed and the line goes quiet on its own.
  const rec = accumulateJournal("marketOrders", CO.journal.ordersMs, {
    "purchase orders": _orders.orders,
    "units short": Math.round(_orders.units),
  });
  if (rec) emitEvent(`[corp] Ordering materials: ${summariseCounts(ns, rec)}`, "corp");

  ns.print(`[corp-market] round ${round} | ${divisions.length} division(s) | ` +
    `${smartSupply ? "Smart Supply" : "manual input orders"}`);
}

/**
 * One division: per city, keep inputs flowing (Smart Supply or manual orders),
 * keep boost materials topped up, and keep every produced material on sale.
 * @param {NS} ns @param {boolean} smartSupply
 */
function manageDivision(ns, divName, industry, smartSupply) {
  const c = ns.corporation;
  const industryData = safe(() => c.getIndustryData(/** @type {any} */ (industry)));
  const hasTA2 = safe(() => c.hasResearched(divName, /** @type {any} */ ("Market-TA.II")));

  // One-time journal latch: the moment Smart Supply takes over a division's
  // input purchasing is worth a line (it's a $25b unlock paying off), but
  // setSmartSupply is re-issued idempotently every pass, so the latch - not the
  // call - is the edge. Remembered on globalThis across one-shot runs.
  if (smartSupply) {
    const on = globalThis.gordCorpSmartSupplyOn ?? (globalThis.gordCorpSmartSupplyOn = {});
    if (!on[divName]) {
      on[divName] = true;
      emitEvent(`[corp] Smart Supply now manages ${divName}'s input materials`, "corp");
    }
  }

  for (const city of CITIES) {
    const wh = safe(() => c.getWarehouse(divName, /** @type {any} */ (city)));
    if (!wh) continue;

    if (smartSupply) {
      safe(() => c.setSmartSupply(divName, /** @type {any} */ (city), true));
    } else {
      manageOrders(ns, divName, city, inputTargets(wh, industryData));
    }

    manageOrders(ns, divName, city, boostTargets(wh, industryData));

    // Sell everything this industry produces. With Market-TA.II the game
    // auto-prices for max profit; without it MAX at MP is the safe default.
    for (const mat of industryData?.producedMaterials ?? /** @type {any[]} */ (CO.defaultProducedMaterials)) {
      safe(() => c.sellMaterial(divName, /** @type {any} */ (city), mat, "MAX", "MP"));
      if (hasTA2) safe(() => c.setMaterialMarketTA2(divName, /** @type {any} */ (city), mat, true));
    }
  }
}

// ── Purchase orders ──────────────────────────────────────────────────────────

/**
 * Per-material stock targets for the industry's INPUT materials, splitting the
 * input slice of the warehouse by the industry's own coefficients. Only used
 * while Smart Supply is unowned: production is min(stored/ratio) across inputs,
 * so a division with no Water produces literally nothing - which is how a corp
 * that couldn't afford the $25b unlock used to sit at $0 revenue forever.
 * @param {any} wh @param {any} industryData @returns {Record<string, number>}
 */
function inputTargets(wh, industryData) {
  const required = industryData?.requiredMaterials ?? {};
  const entries = Object.entries(required).filter(([, ratio]) => ratio > 0);
  const totalRatio = entries.reduce((sum, [, r]) => sum + r, 0);
  if (!totalRatio) return {};

  const slice = wh.size * CO.inputWarehouseFraction;
  /** @type {Record<string, number>} */
  const targets = {};
  for (const [mat, ratio] of entries) {
    const size = MATERIAL_SIZE[mat];
    if (!size) continue; // unknown footprint - don't guess at warehouse space
    targets[mat] = Math.floor((slice * (ratio / totalRatio)) / size);
  }
  return targets;
}

/**
 * Per-material stock targets for the BOOST materials (Real Estate, Hardware,
 * Robots, AI Cores), splitting the boost slice of the warehouse by the industry's
 * production factors. These multiply the division production multiplier, which is
 * why the manual treats stocking them as the round's closing move.
 * @param {any} wh @param {any} industryData @returns {Record<string, number>}
 */
function boostTargets(wh, industryData) {
  if (!industryData) return {};
  const factors = {
    "Real Estate": industryData.realEstateFactor ?? 0,
    Hardware: industryData.hardwareFactor ?? 0,
    Robots: industryData.robotFactor ?? 0,
    "AI Cores": industryData.aiCoreFactor ?? 0,
  };
  const totalFactor = Object.values(factors).reduce((a, b) => a + b, 0);
  if (totalFactor <= 0) return {};

  const slice = wh.size * CO.boostWarehouseFraction;
  /** @type {Record<string, number>} */
  const targets = {};
  for (const mat of BOOST_MATERIALS) {
    if (factors[mat] <= 0) continue;
    targets[mat] = Math.floor((slice * (factors[mat] / totalFactor)) / MATERIAL_SIZE[mat]);
  }
  return targets;
}

/**
 * Reconcile purchase orders against targets: order the shortfall at a rate sized
 * to finish by this phase's next rotation slot, and clear the order once the
 * target is met (with the shortfall tolerance as hysteresis, so a rounding error
 * doesn't re-open an order every pass). Clearing unconditionally when at target
 * is what makes the no-affordability-gate design safe - an order exists only
 * while its material is genuinely short.
 * @param {NS} ns @param {Record<string, number>} targets
 */
function manageOrders(ns, divName, city, targets) {
  const c = ns.corporation;
  for (const [mat, target] of Object.entries(targets)) {
    if (!(target > 0)) continue;
    const stored = safe(() => c.getMaterial(divName, /** @type {any} */ (city), /** @type {any} */ (mat)).stored) ?? 0;
    const shortfall = target - stored;

    if (shortfall <= target * CO.boostShortfallTolerance) {
      safe(() => c.buyMaterial(divName, /** @type {any} */ (city), /** @type {any} */ (mat), 0));
      continue;
    }
    if (did(() => c.buyMaterial(divName, /** @type {any} */ (city), /** @type {any} */ (mat), shortfall / CO.materialBuySeconds))) {
      _orders.orders++;
      _orders.units += shortfall;
    }
  }
}

// This pass's order activity, flushed as one throttled journal line in pass().
// Units across materials are apples and oranges (a Real Estate unit vs an AI
// Core), so the line is an activity indicator, not an invoice.
const _orders = { orders: 0, units: 0 };

// ── Research ─────────────────────────────────────────────────────────────────

/**
 * Buy division research in strict priority order, from round 4, each purchase
 * capped to its tier's share of the CURRENT pool - see the header. Strict order
 * means the first unowned research that fails its cap ends the pass: never skip
 * ahead to a cheaper later one.
 * @param {NS} ns @param {number} round
 */
function manageResearch(ns, divName, round) {
  if (round < CO.researchFromRound) return;

  const c = ns.corporation;
  const points = safe(() => c.getDivision(divName).researchPoints) ?? 0;

  for (const research of RESEARCH_PRIORITY) {
    if (safe(() => c.hasResearched(divName, research))) continue;
    const cost = safe(() => c.getResearchCost(divName, research)) ?? Infinity;
    if (cost <= points * poolFraction(research)) {
      if (did(() => c.research(divName, research))) {
        // Research is rare and shapes the whole run (Market-TA.II, the lab, the
        // stat researches) - it goes to the journal immediately, not batched.
        emitEvent(`[corp] ${divName}: researched ${research} (${ns.format.number(cost)} RP)`, "corp");
      }
    }
    break; // strict order - don't skip ahead to a cheaper later research
  }
}

/** The pool-fraction cap for one research, by tier (priority / stat / production). */
function poolFraction(research) {
  const F = CO.researchMaxPoolFraction;
  if (CO.researchPriorityTier.includes(research)) return F.priority;
  if (CO.researchProduction.includes(research)) return F.production;
  return F.stat;
}
