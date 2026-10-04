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
//      reserved for production output. INPUTS add the flow on top: what the
//      division consumed last cycle, less what an export route delivered - an
//      order is a rate that stands for the whole window, so the shortfall alone
//      capped production at target/window (see orderRate),
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
// No affordability gate on ordering in rounds 1-2, by design. The warehouse slice
// fractions are the spending cap there: a material can never be ordered past its
// share of the warehouse, however rich or poor the corp is. Two limits sit on
// top of that for BOOST materials: in rounds 1-2 nothing is ordered until the
// division has banked its RP (it produces nothing before then - see
// boostOrderTargets), and from round 3, where the manual's debt allowance ends,
// one pass may only commit a share of the corp's surplus (boostSpendBudget).
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
import { safe, did, corpFunds, affordable, divisionByIndustry, currentRound, roundKnown, earlyRpGate, offerHoldActive, optimalBoostQuantities, accumulateJournal, summariseCounts } from "./corp-lib.js";

const CO = CONFIG.corp;
const CITIES = /** @type {any[]} */ (CO.cities);
const MATERIAL_SIZE = CO.materialSize;
const BOOST_MATERIALS = /** @type {any[]} */ (CO.boostMaterials);

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
  // No round published yet (first rotation after a reload): do nothing rather
  // than act on the round-1 default - see roundKnown. Every order this file
  // places lives in the game, so "nothing" leaves the last pass's orders running
  // for one more tick, which is what would have happened anyway.
  if (!roundKnown()) {
    ns.print("[corp-market] waiting for corp-invest to publish the round");
    return;
  }
  const round = currentRound();

  // The product division draws on the boost budget FIRST from round 3: the
  // manual puts >= 90% of round-3+ funds there, and the budget below is one pot
  // shared by every order this pass places.
  const product = { name: divisionByIndustry(ns, CO.tobaccoDivision.industry), industry: CO.tobaccoDivision.industry };
  const support = [
    { name: divisionByIndustry(ns, CO.agriDivision.industry), industry: CO.agriDivision.industry },
    { name: divisionByIndustry(ns, CO.chemicalDivision.industry), industry: CO.chemicalDivision.industry },
  ];
  const divisions = (round > CO.boostAfterBuildoutRound ? [product, ...support] : [...support, product])
    .filter(d => d.name);

  const smartSupply = safe(() => ns.corporation.hasUnlock("Smart Supply")) ?? false;

  // What this pass may SPEND on boost materials - one pot, drawn down as orders
  // are placed. Infinity in rounds 1-2 (debt is the plan there).
  const budget = { left: boostSpendBudget(corpFunds(ns), globalThis.gordCorpSavingFor ?? 0, round) };

  for (const div of divisions) {
    manageDivision(ns, div.name, div.industry, smartSupply, round, budget);
    manageResearch(ns, div.name, round, div.industry === CO.tobaccoDivision.industry);
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
 * @param {{left: number}} budget - this pass's shared boost-spend pot
 */
function manageDivision(ns, divName, industry, smartSupply, round, budget) {
  const c = ns.corporation;
  const industryData = safe(() => c.getIndustryData(/** @type {any} */ (industry)));
  const hasTA2 = safe(() => c.hasResearched(divName, /** @type {any} */ ("Market-TA.II")));

  // Rounds 1-2: has this division banked the RP its producing phase waits on?
  // Read once per division (getDivision is already reached via divisionByIndustry,
  // so it costs no RAM). An unreadable division counts as NOT ready - the
  // conservative side of a decision that spends on credit.
  const rpGate = earlyRpGate(round, industry);
  const rpReady = rpGate <= 0
    || (safe(() => c.getDivision(divName).researchPoints) ?? 0) >= rpGate;

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
    const targets = { ...inputs, ...boostOrderTargets(ns, boosts, round, rpReady) };
    manageOrders(ns, divName, city, targets, wh, industryData, budget);
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
 * PAST those rounds the debt allowance ends. Rounds 1-2 are the only ones the
 * manual tells you to finish in the red ("the budget is too low ... buying boost
 * materials per second does not need funds because you can go into debt"); from
 * round 3 it gives an explicit budget split in which the whole raw-production
 * slice - warehouses and boosts together - is 1/23 of funds, with >= 90% going to
 * the product division and corporation upgrades. An unconditional order there is
 * a spender with no ceiling at all, and it behaved like one: a BN3 corp sitting on
 * $3.4b went to -$17.3b in a single pass when two warehouse levels enlarged the
 * boost targets, which blocked the first product (its budget is a share of LIQUID
 * funds) and pushed the city it was banking for from 15 minutes away to 1.2 hours.
 * The boosts weren't wrong to want - the timing was - so from round 3 they are
 * ordered only out of genuine surplus: funds positive AND clear of the operating
 * reserve and whatever lump corp-expand is banking for. That is the same
 * affordable() test every other round-3 spender already passes.
 *
 * Gated rounds return every boost at target 0 rather than an empty map: 0 is what
 * manageOrders reads as "clear any standing order", where an absent key would
 * leave one running unreviewed.
 *
 * `rpReady` (rounds 1-2 only): the division has banked the RP its producing
 * phase waits on (earlyRpGate). Until then lib/corp-office.js has every employee
 * on R&D, so the division produces NOTHING and a production multiplier buys
 * nothing - but the order would still put the corp tens of billions in debt for
 * the whole wait (~40 minutes in round 2), and debt is not free here: buyTea and
 * throwParty silently refuse when funds are short, as does every seat, Advert
 * and Smart Storage level the round still needs. The manual's order is the same:
 * wait for RP, switch to the producing split, THEN buy boosts. It can't starve
 * anything - RP accrues without funds, so the gate always opens - and stock
 * already bought is never dumped (hold only zeroes the ORDER).
 * @param {NS} ns @param {Record<string, number>} boosts @param {number} round
 * @param {boolean} [rpReady]
 */
export function boostOrderTargets(ns, boosts, round, rpReady = true) {
  const hold = () => {
    /** @type {Record<string, number>} */
    const zeroed = {};
    for (const mat of Object.keys(boosts)) zeroed[mat] = 0;
    return zeroed;
  };

  // Round 3+: surplus only. affordable(ns, 0) is "is there anything above the
  // reserve and the savings objective?"; the funds check is separate because a
  // corp at exactly $0 passes that test and would still buy the whole pile on
  // credit. (How MUCH of the surplus one pass may spend is boostSpendBudget.)
  // And never while a ready round's offer is being held: here boosts are
  // discretionary, and funds are a term of the valuation being sold. Rounds 1-2
  // deliberately do NOT stand down for the hold - there the boosts ARE the
  // round's closing move, the thing the offer is waiting to price, and buying
  // them costs no AssetDelta (stock is carried as an asset at what was paid).
  if (round > CO.boostAfterBuildoutRound) {
    if (offerHoldActive()) return hold();
    return corpFunds(ns) > 0 && affordable(ns, 0) ? boosts : hold();
  }

  if (!rpReady) return hold();
  if (globalThis.gordCorpExpandDone) return boosts;
  // undefined = corp-expand hasn't published a step yet (its first pass of the
  // rotation precedes ours, so this is only the opening tick). Assume capacity is
  // pending and hold - the conservative side of the one decision that bricked a corp.
  const cheapest = globalThis.gordCorpCheapestStep;
  if (cheapest !== undefined && !affordable(ns, cheapest)) return boosts;

  return hold();
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
 * How much one pass may SPEND on boost materials, across every division and city.
 *
 * Rounds 1-2: Infinity. Finishing those rounds in debt on boost buys is the
 * manual's plan, and the warehouse slice is the only cap that applies.
 *
 * Round 3+: a share of the genuine surplus - what is left above the operating
 * reserve and the objective corp-expand is banking for. boostOrderTargets already
 * refuses to order with no surplus at all, but that was only ever a yes/no: with
 * $1 of surplus the order was still sized by the WAREHOUSE shortfall, so every
 * warehouse level bought re-opened a multi-billion order on credit (the BN3
 * corp's $3.4b -> -$17.3b pass). Debt there zeroes the product budget (a share
 * of liquid funds) and pushes the banked objective back out of reach.
 *
 * A share rather than the whole surplus, because an order is a RATE that runs
 * until the next review: a rotation that takes twice its nominal minute buys
 * twice the units. At boostBudgetFraction the review can be several times late
 * before the purchase outruns the surplus it was sized against, and the pile
 * still fills geometrically over a few rotations.
 * Pure - exported for the tests.
 * @param {number} funds @param {number} saving - gordCorpSavingFor
 * @param {number} round
 */
export function boostSpendBudget(funds, saving, round) {
  if (round <= CO.boostAfterBuildoutRound) return Infinity;
  const surplus = funds * (1 - CO.fundsReserveFraction) - (saving > 0 ? saving : 0);
  return surplus > 0 ? surplus * CO.boostBudgetFraction : 0;
}

/**
 * The per-second purchase order for one material in one warehouse, and what it
 * claims: `units` of net stock change (for the room and journal accounting) and
 * their `cost`. rate 0 means "clear the order". Pure - exported for the tests.
 *
 *   rate = consumption - imports + fill / seconds
 *
 * `fill` is the stock CHANGE wanted over the window: the shortfall to target
 * (once it's past the tolerance band - hysteresis, so buy and drain can't
 * chatter), capped by the warehouse room orders may claim and, when a finite
 * `budget` is given, by what that money buys at `price`. It goes negative when
 * stock is over target, which pulls the rate below the flow term.
 *
 * The flow term is what an INPUT needs and a boost material never has (boosts
 * aren't consumed, so their callers pass 0). An order is a rate that stands for a
 * whole review window, so sizing it by the shortfall alone capped what a division
 * could ever consume at target/seconds: Agriculture with a level-4 warehouse
 * could draw ~38 Water/s against the ~56/s its boosted production wanted, and a
 * tenth of that under bonus time (the window stretches 10x). Ordering what was
 * actually consumed last cycle, less whatever an export route already delivered,
 * removes the ceiling - and the imports term is what stops a division with a
 * working export route from market-buying (quality 1) the material its supplier
 * is sending it at high quality.
 *
 * A crowded warehouse (no room left under the output headroom) orders nothing at
 * all, flow included - same rule as before: a standing order re-buys whatever
 * space production frees, which is the congestion loop (manual 12.2).
 *
 * @param {{target: number, stored: number, size: number, room: number,
 *   seconds: number, tolerance: number, consumption?: number, imports?: number,
 *   budget?: number, price?: number}} o
 * @returns {{rate: number, units: number, cost: number}}
 */
export function orderRate(o) {
  const none = { rate: 0, units: 0, cost: 0 };
  if (!(o.target > 0) || !(o.size > 0) || !(o.seconds > 0) || !(o.room > 0)) return none;

  const shortfall = o.target - (o.stored > 0 ? o.stored : 0);
  let fill = shortfall > o.target * o.tolerance
    ? Math.min(shortfall, o.room / o.size)
    : Math.min(shortfall, 0);

  const price = o.price > 0 ? o.price : 0;
  const budget = o.budget ?? Infinity;
  if (fill > 0 && Number.isFinite(budget)) {
    // A finite budget with no readable price can't be honoured - buy nothing.
    fill = price > 0 ? Math.min(fill, Math.max(0, budget) / price) : 0;
  }

  const flow = Math.max(0, o.consumption ?? 0) - Math.max(0, o.imports ?? 0);
  const rate = Math.max(0, flow + fill / o.seconds);
  if (!(rate > 0) || !Number.isFinite(rate)) return none;
  const units = Math.max(0, fill);
  return { rate, units, cost: units * price };
}

/**
 * Reconcile purchase orders against targets: order the shortfall at a rate sized
 * to finish by this phase's next rotation slot (plus, for inputs, the flow the
 * division is actually consuming - see orderRate), capped to the warehouse space
 * orders are allowed to claim and to this pass's boost budget, and RESET the
 * order to 0 in every other case - target met (with the shortfall tolerance as
 * hysteresis), target zero, or no room. The unconditional reset is the
 * load-bearing part: a buyMaterial order is game state that outlives this
 * one-shot, so any path that leaves an order standing un-reviewed is a
 * warehouse-choking loop waiting to happen.
 * @param {NS} ns @param {Record<string, number>} targets @param {any} wh
 * @param {any} industryData @param {{left: number}} budget
 */
function manageOrders(ns, divName, city, targets, wh, industryData, budget) {
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
    // One read gives everything the order is sized from: stock, market price,
    // and (for inputs) last cycle's consumption and imports. productionAmount is
    // NEGATIVE for a material the division consumes.
    const m = safe(() => c.getMaterial(divName, /** @type {any} */ (city), /** @type {any} */ (mat)));
    const isBoost = BOOST_MATERIALS.includes(mat);
    const size = MATERIAL_SIZE[mat];
    const order = orderRate({
      target,
      stored: m?.stored ?? 0,
      size,
      room,
      seconds,
      tolerance: CO.boostShortfallTolerance,
      consumption: isBoost ? 0 : -(m?.productionAmount ?? 0),
      imports: isBoost ? 0 : (m?.importAmount ?? 0),
      // Only boosts draw on the pot. Inputs are what production runs on - a
      // division denied them earns nothing - and their volume is bounded by the
      // input slice of the warehouse, not by the size of a boost pile.
      budget: isBoost ? budget.left : Infinity,
      price: m?.marketPrice ?? 0,
    });
    if (!(order.rate > 0)) {
      clear();
      continue;
    }
    room -= order.units * size;
    if (did(() => c.buyMaterial(divName, /** @type {any} */ (city), /** @type {any} */ (mat), order.rate))) {
      if (isBoost) budget.left -= order.cost;
      // Journal only the orders that are FILLING something. An input's standing
      // flow order (units 0) is steady state, and counting it would keep the
      // "ordering materials" line firing forever.
      if (order.units > 0) {
        _orders.orders++;
        _orders.units += order.units;
      }
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
 * @param {NS} ns @param {number} round @param {boolean} isProductDivision
 */
function manageResearch(ns, divName, round, isProductDivision) {
  if (round < CO.researchFromRound) return;

  const c = ns.corporation;

  for (const research of researchListFor(isProductDivision)) {
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

/**
 * The research list a division shops from, in strict order.
 *
 * Support divisions (Agriculture, Chemical) get their own list with the
 * Market-TA pair left out. The order is STRICT - the first research that fails
 * its pool cap ends the pass - and the TA bundle sits second, needing a 140k RP
 * pool (70k at the half-pool cap). A material division sells at MP into a market
 * that takes everything it makes, so TA.II buys it almost nothing, yet on the
 * shared list it stood between those divisions and every stat research behind
 * it: they bought the lab and then nothing, ever. Stat research there is what
 * raises EngineerProduction, i.e. the quality of the Plants the product is rated
 * on. (uPgrade: Fulcrum is product-only and isn't in their tree at all.)
 * Pure - exported for the tests.
 * @param {boolean} isProductDivision @returns {string[]}
 */
export function researchListFor(isProductDivision) {
  return isProductDivision
    ? CO.researchPriority
    : (CO.researchPrioritySupport ?? CO.researchPriority);
}

/** The pool-fraction cap for one research, by tier (priority / stat / production). */
function poolFraction(research) {
  const F = CO.researchMaxPoolFraction;
  if (CO.researchPriorityTier.includes(research)) return F.priority;
  if (CO.researchProduction.includes(research)) return F.production;
  return F.stat;
}
