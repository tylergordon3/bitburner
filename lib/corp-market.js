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
//   1. computes each material's TARGET (inputs: their share of the input slice;
//      boost materials: the manual's closed-form optimum for the boost slice -
//      see optimalBoostQuantities in lib/corp-lib.js),
//   2. sets an order of shortfall / materialBuySeconds per second - sized so the
//      order completes right around this phase's next rotation slot (stretched
//      10x under bonus time, which runs cycles that much faster in real time),
//      and capped so standing orders can never claim the warehouse slice
//      reserved for production output,
//   3. clears the order to 0 the moment its target is reached, unreachable
//      (no room), or GONE - inputs once Smart Supply takes them over, boost
//      materials the optimizer drops. A buyMaterial order lives in the game, not
//      in this script: one that nobody resets keeps buying forever, which is
//      exactly the warehouse-congestion loop the manual warns about (12.2),
//   4. drains stock that overshot its target (a late review, bonus time) back
//      down at market price - the manual's congestion mitigation, but recovering
//      the money instead of discarding at 0. Boost stock always; INPUT stock only
//      while the warehouse is congested, where the overshoot has stopped being
//      self-correcting: a full warehouse can't produce, so it can't consume its
//      inputs either, and the division sits at $0 revenue for good.
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
import { safe, did, affordable, divisionByIndustry, currentRound, optimalBoostQuantities, accumulateJournal, summariseCounts } from "./corp-lib.js";

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
    manageDivision(ns, div.name, div.industry, smartSupply, round);
    manageResearch(ns, div.name, round);
  }

  // Throttled order-activity line: while warehouses fill toward their targets
  // this fires at most every journal.ordersMs; once stock is at target no orders
  // are placed and the line goes quiet on its own.
  const rec = accumulateJournal("marketOrders", CO.journal.ordersMs, {
    "purchase orders": _orders.orders,
    "units short": Math.round(_orders.units),
    "overshoot sell-offs": _orders.selloffs,
  });
  if (rec) emitEvent(`[corp] Ordering materials: ${summariseCounts(ns, rec)}`, "corp");

  ns.print(`[corp-market] round ${round} | ${divisions.length} division(s) | ` +
    `${smartSupply ? "Smart Supply" : "manual input orders"}`);
}

/**
 * One division: per city, keep inputs flowing (Smart Supply or manual orders),
 * keep boost materials topped up, and keep every produced material on sale.
 * @param {NS} ns @param {boolean} smartSupply @param {number} round
 */
function manageDivision(ns, divName, industry, smartSupply, round) {
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

    if (smartSupply) safe(() => c.setSmartSupply(divName, /** @type {any} */ (city), true));

    // ONE reconcile map per city covering every material we might ever have
    // ordered. Inputs are explicitly ZEROED once Smart Supply owns purchasing:
    // the manual orders placed before the unlock otherwise persist in the game
    // and keep buying forever underneath Smart Supply's own purchases.
    const inputs = smartSupply ? zeroedInputs(industryData) : inputTargets(wh, industryData);
    const boosts = boostTargets(wh, industryData);
    // In rounds 1-2 boosts stand aside for capacity the buildout can afford right
    // now; when they do, they're ordered at 0, which CLEARS any standing order
    // without touching stock we already own (manageOvershoot below still works off
    // the real optimum, so a gated round never dumps the pile it already paid for).
    const targets = { ...inputs, ...boostOrderTargets(ns, boosts, round) };
    manageOrders(ns, divName, city, targets, wh, industryData);
    // Boost overshoot always drains; input overshoot only when the warehouse is
    // congested AND the targets are ours to reconcile (never under Smart Supply,
    // whose inputs we deliberately don't manage). Inputs are passed either way so
    // the drain's own sell orders get reviewed - and cleared - once it's over.
    manageOvershoot(ns, divName, city, boosts, inputs, !smartSupply && congested(wh));

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
 * Robots, AI Cores): the exact optimum for the boost slice of the warehouse, via
 * the manual's closed-form Lagrange solution (see optimalBoostQuantities in
 * lib/corp-lib.js). These multiply the division production multiplier, which is
 * why the manual treats stocking them as the round's closing move. A material
 * the optimum drops entirely (Robots at small budgets) comes back as target 0,
 * which manageOrders uses to CLEAR any standing order for it.
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
  // Product divisions get the smaller slice: their warehouse also houses the
  // imported input and the unsold product inventory (see config).
  const fraction = industryData.makesProducts
    ? CO.productBoostWarehouseFraction
    : CO.boostWarehouseFraction;
  const slice = wh.size * fraction;
  return optimalBoostQuantities(slice, BOOST_MATERIALS.map(mat => ({
    name: mat,
    coefficient: factors[mat] ?? 0,
    size: MATERIAL_SIZE[mat],
  })));
}

/**
 * True when a warehouse is too full for its division to keep producing. Output
 * needs somewhere to go: Agriculture turns 0.035 units of storage of inputs into
 * 0.08 of outputs, so a warehouse at ~100% stops producing, therefore stops
 * consuming its inputs, therefore never drains itself. See
 * warehouseCongestionFraction.
 * @param {any} wh
 */
function congested(wh) {
  return wh.size > 0 && wh.sizeUsed >= wh.size * CO.warehouseCongestionFraction;
}

/**
 * The boost targets to ORDER against this round. Boost orders bypass every
 * affordability check (they're allowed to run the corp into debt, by design), so
 * in rounds 1-2 they can outbid the buildout for the same money - which is how a
 * round-1 corp ended up $1b in debt with every warehouse still at level 1 and no
 * way to buy the next one. Boost materials are never consumed, so the space and
 * the money were both gone for good.
 *
 * The rule is therefore NOT "wait until capacity is finished" but "never outbid
 * capacity that could be bought right now". Boosts are held only while the
 * buildout can actually spend on its next step - affordable(), so the operating
 * reserve and the division-founding savings floor both count. The moment capacity
 * spending is blocked for any reason (the round's targets are met, the corp is
 * banking for a founding, the next warehouse level is simply out of reach) the
 * money isn't going to capacity anyway, and the production multiplier boosts feed
 * is the best thing left to buy - it's what grows the revenue that pays for the
 * rest. Waiting for gordCorpExpandDone alone would starve exactly the corp that
 * needs it: round 2 targets warehouse level 17 in all six cities, which an
 * under-capitalised corp cannot reach without first growing what it earns.
 *
 * Gated rounds return every boost at target 0 rather than an empty map: 0 is what
 * manageOrders reads as "clear any standing order", where an absent key would
 * leave one running unreviewed.
 * @param {NS} ns @param {Record<string, number>} boosts @param {number} round
 */
export function boostOrderTargets(ns, boosts, round) {
  if (round > CO.boostAfterBuildoutRound) return boosts;
  if (globalThis.gordCorpExpandDone) return boosts;
  // undefined = corp-expand hasn't published a step yet (its first pass of the
  // rotation precedes ours, so this is only the opening tick). Assume capacity is
  // pending and hold - the conservative side of the one decision that bricked a corp.
  const cheapest = globalThis.gordCorpCheapestStep;
  if (cheapest !== undefined && !affordable(ns, cheapest)) return boosts;

  /** @type {Record<string, number>} */
  const zeroed = {};
  for (const mat of Object.keys(boosts)) zeroed[mat] = 0;
  return zeroed;
}

/**
 * The order-completion window in seconds. Bonus time runs corp cycles ~10x
 * faster in REAL time while a per-second order still buys rate*10 per cycle, so
 * an order sized for a 60s window fills in ~6s and then keeps buying ~10x past
 * its target before the next review - stretch the window to match.
 * getBonusTime is 0GB. @param {NS} ns
 */
function orderSeconds(ns) {
  const bonus = safe(() => ns.corporation.getBonusTime()) ?? 0;
  return CO.materialBuySeconds * (bonus > 10_000 ? 10 : 1);
}

/**
 * Reconcile purchase orders against targets: order the shortfall at a rate sized
 * to finish by this phase's next rotation slot, capped to the warehouse space
 * orders are allowed to claim, and RESET the order to 0 in every other case -
 * target met (with the shortfall tolerance as hysteresis), target zero, or no
 * room. The unconditional reset is the load-bearing part: a buyMaterial order is
 * game state that outlives this one-shot, so any path that leaves an order
 * standing un-reviewed is a warehouse-choking loop waiting to happen.
 * @param {NS} ns @param {Record<string, number>} targets @param {any} wh
 * @param {any} industryData
 */
function manageOrders(ns, divName, city, targets, wh, industryData) {
  const c = ns.corporation;
  const seconds = orderSeconds(ns);
  // Space new orders may still claim: everything but the slice reserved for
  // production output. Product divisions hold back much more - their output
  // (the products) lingers in the warehouse until sold, where materials ship
  // out at MAX every cycle. When the warehouse is crowded, orders shrink to fit
  // and then clear entirely - re-placing an unfillable order every pass just
  // eats whatever space production frees, which stalls the division for good.
  const headroom = industryData?.makesProducts
    ? CO.productOrderHeadroomFraction
    : CO.orderHeadroomFraction;
  let room = wh.size * (1 - headroom) - wh.sizeUsed;

  for (const [mat, target] of Object.entries(targets)) {
    const clear = () => safe(() => c.buyMaterial(divName, /** @type {any} */ (city), /** @type {any} */ (mat), 0));
    if (!(target > 0)) {
      clear();
      continue;
    }
    const stored = safe(() => c.getMaterial(divName, /** @type {any} */ (city), /** @type {any} */ (mat)).stored) ?? 0;
    const shortfall = target - stored;
    if (shortfall <= target * CO.boostShortfallTolerance) {
      clear();
      continue;
    }

    const size = MATERIAL_SIZE[mat];
    const units = size > 0 ? Math.min(shortfall, room / size) : 0;
    if (units <= 0) {
      clear();
      continue;
    }
    room -= units * size;
    if (did(() => c.buyMaterial(divName, /** @type {any} */ (city), /** @type {any} */ (mat), units / seconds))) {
      _orders.orders++;
      _orders.units += units;
    }
  }
}

/**
 * Drain stock that overshot its target back DOWN to it, at market price.
 * Overshoot happens whenever a review is late (a starved rotation slot, bonus
 * time running an order ~10x past its window) - and boost materials are never
 * consumed, so the excess squats on warehouse space forever. The manual's
 * congestion mitigation (12.2) is to discard the excess; selling at MP does the
 * job while recovering the money. The sell order is reset to 0 the moment stock
 * is back inside the band - standing sell orders have exactly the same
 * never-reviewed failure mode as buys.
 *
 * Boost materials drain unconditionally. INPUTS only drain when `drainInputs` is
 * set, which the caller does only for a CONGESTED warehouse whose inputs we
 * actually manage. That exception exists because input overshoot is normally
 * self-correcting - production eats it - but a warehouse at ~100% has no room to
 * produce into, so production stops, consumption stops, and the overshoot becomes
 * permanent: a division pinned at $0 revenue while salaries drain the corp into
 * debt it can never climb out of. Draining to target (never to 0) reopens the
 * headroom without dumping the imported high-quality stock the Chemicals loop
 * feeds in.
 *
 * `inputs` is passed whether or not it may drain, so the sell orders this leaves
 * behind are reviewed and cleared once the congestion is over (and, under Smart
 * Supply, so an order from before the unlock can't outlive it). Same rule as the
 * buy side: every order this file can place, it reconciles every pass.
 * @param {NS} ns @param {Record<string, number>} boosts
 * @param {Record<string, number>} inputs @param {boolean} drainInputs
 */
function manageOvershoot(ns, divName, city, boosts, inputs, drainInputs) {
  const c = ns.corporation;
  const seconds = orderSeconds(ns);
  // Boost target wins on any material that is both a boost and an industry input
  // (Hardware for Software, say) - the same precedence the order side uses, so
  // the two can never fight over one material's stock level.
  const drainable = { ...(drainInputs ? inputs : {}), ...boosts };

  for (const mat of new Set([...Object.keys(boosts), ...Object.keys(inputs)])) {
    const target = drainable[mat];
    const clear = () => safe(() => c.sellMaterial(divName, /** @type {any} */ (city), /** @type {any} */ (mat), "0", "MP"));
    if (target === undefined) {          // an input we're not draining this pass
      clear();
      continue;
    }
    const stored = safe(() => c.getMaterial(divName, /** @type {any} */ (city), /** @type {any} */ (mat)).stored) ?? 0;
    const excess = stored - target;
    if (excess > Math.max(target * CO.orderOvershootTolerance, 1)) {
      if (did(() => c.sellMaterial(divName, /** @type {any} */ (city), /** @type {any} */ (mat), String(excess / seconds), "MP"))) {
        _orders.selloffs++;
      }
    } else {
      clear();
    }
  }
}

/**
 * Every input material at target 0 - the reconcile map's way of saying "clear
 * any manual order" once Smart Supply owns input purchasing.
 * @param {any} industryData @returns {Record<string, number>}
 */
function zeroedInputs(industryData) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const mat of Object.keys(industryData?.requiredMaterials ?? {})) out[mat] = 0;
  return out;
}

// This pass's order activity, flushed as one throttled journal line in pass().
// Units across materials are apples and oranges (a Real Estate unit vs an AI
// Core), so the line is an activity indicator, not an invoice.
const _orders = { orders: 0, units: 0, selloffs: 0 };

// ── Research ─────────────────────────────────────────────────────────────────

/**
 * Buy division research in strict priority order, from round 4, each purchase
 * capped to its tier's share of the CURRENT pool - see the header. Strict order
 * means the first unowned research that fails its cap ends the pass: never skip
 * ahead to a cheaper later one. A research named in CO.researchBundle is only
 * bought when its whole bundle fits the cap - Market-TA.I alone is a dead 20k
 * RP (it's nothing but TA.II's prerequisite), so the pair waits until it can
 * land together, per the manual. Purchases continue down the list within one
 * pass while the (re-read) pool keeps covering them, so a banked-up pool buys
 * TA.I and TA.II back to back.
 * @param {NS} ns @param {number} round
 */
function manageResearch(ns, divName, round) {
  if (round < CO.researchFromRound) return;

  const c = ns.corporation;

  for (const research of RESEARCH_PRIORITY) {
    if (safe(() => c.hasResearched(divName, research))) continue;

    // Re-read the pool each purchase - research() drains it.
    const points = safe(() => c.getDivision(divName).researchPoints) ?? 0;
    const cost = safe(() => c.getResearchCost(divName, research)) ?? Infinity;
    const bundleCost = (/** @type {any[]} */ (CO.researchBundle[research] ?? []))
      .filter(r => !safe(() => c.hasResearched(divName, r)))
      .reduce((sum, r) => sum + (safe(() => c.getResearchCost(divName, r)) ?? Infinity), cost);

    if (bundleCost > points * poolFraction(research)) break; // strict order: stop here
    if (!did(() => c.research(divName, research))) break;
    // Research is rare and shapes the whole run (Market-TA.II, the lab, the
    // stat researches) - it goes to the journal immediately, not batched.
    emitEvent(`[corp] ${divName}: researched ${research} (${ns.format.number(cost)} RP)`, "corp");
  }
}

/** The pool-fraction cap for one research, by tier (priority / stat / production). */
function poolFraction(research) {
  const F = CO.researchMaxPoolFraction;
  if (CO.researchPriorityTier.includes(research)) return F.priority;
  if (CO.researchProduction.includes(research)) return F.production;
  return F.stat;
}
