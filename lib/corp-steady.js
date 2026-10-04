// lib/corp-steady.js
//
// The always-on "operate the corp" script - the per-cycle work that can't wait for
// a rotation slot. It runs forever on the reserved cloud-corp host and owns:
//   - the PRODUCT pipeline (develop / sell / recycle products), including
//     pricing them each cycle until Market-TA.II takes over (nextProductPrice),
//   - Wilson Analytics + Advert for the product division (the main profit driver
//     in the product rounds - Wilson is not retroactive, so it has to be bought
//     the cycle it becomes affordable, not a rotation later),
//   - corp-wide upgrade spending from surplus,
//   - dividends once public and past the investment rounds,
//   - publishing globalThis.gordCorpState for ui/dashboard.js.
//
// Employee upkeep (tea + party) used to live here and deliberately does NOT any
// more: it moved to lib/corp-upkeep.js, a ~62GB always-on script small enough to
// place almost anywhere, so the single highest-value piece of corp automation
// survives even when this ~200GB operator can't be placed - and keeps working when
// you manage the corp by hand.
//
// The bounded STRUCTURAL work (unlocks, cities, warehouses, offices, materials,
// research, investment rounds) lives in the four one-shot build phases -
// lib/corp-expand/office/market/invest.js - which lib/corp-daemon.js runs in
// rotation on borrowed off-home RAM. corp-invest publishes the investment round
// (gordCorpRound) so this file never pays for getInvestmentOffer; corp-expand and
// corp-office publish gordCorpExpandDone / gordCorpOfficeDone, the handshake that
// stops this file's upgrade spending from outbidding the buildout for the same
// funds.

import { CONFIG } from "./config.js";
import { emitEvent } from "./events.js";
import { safe, did, corpFunds, affordable, offerHoldActive, divisionByIndustry, designCity, accumulateJournal, summariseCounts } from "./corp-lib.js";

const CO = CONFIG.corp;

// Products the journal has already reported as finished. This tick runs several
// times a second, so anything reported here needs an edge to fire on, not just a
// condition. Module-level: the script is a long-lived process.
const announcedFinished = new Set();

// Where products are designed is resolved LIVE per division (corp-lib's
// designCity) rather than read from config: it has to be a city the division
// actually occupies, or makeProduct throws into did() and the whole pipeline
// fails silently. See designCity for the round this cost the BN3 corp.
const TOBACCO_INDUSTRY = CO.tobaccoDivision.industry;

// Corp-wide levelable upgrades, in the order we prefer to spend on them.
const UPGRADE_PRIORITY = /** @type {any[]} */ (CO.upgradePriority);
const WILSON = /** @type {any} */ (CO.wilsonUpgrade);

const PRODUCT_PREFIX = CO.productPrefix;
const DIVIDEND_RATE = CO.dividendRate;
const DIVIDEND_MIN_PROFIT_PER_SEC = CO.dividendMinProfitPerSec;

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  if (!ns.corporation.hasCorporation()) {
    ns.tprint("corp-steady.js: no corporation yet - exiting (daemon creates it).");
    return;
  }

  // The module-level state below outlives this process (the game reuses the
  // compiled module for identical source - across restarts, installs and
  // BitNodes), and the next node's corporation re-uses the same product names:
  // a stale "Tobacco-v0" here would swallow its finish line and hand its first
  // sell-out the old product's probe step.
  announcedFinished.clear();
  _probes.clear();
  _buys = {};
  _lastLog = 0;

  // The state the corp just finished processing; null until the first
  // transition, so a (re)start waits for a real cycle boundary before spending.
  /** @type {string | null} */
  let state = null;
  while (true) {
    try {
      tick(ns, state);
    } catch (e) {
      ns.print(`corp-steady tick error: ${String(e)}`);
    }
    // nextUpdate() sleeps until the next corp state transition (0 RAM, and it
    // rides "bonus time" so an idle/backgrounded game fast-forwards the corp).
    // It resolves with the state that was just processed.
    state = await ns.corporation.nextUpdate();
  }
}

/**
 * True on the one tick per corp cycle that may SPEND and re-price: the one right
 * after START was processed. Pure - exported for the tests.
 *
 * nextUpdate() resolves on every state, five times a cycle, and every spender
 * here sizes itself as a share of CURRENT funds - so "20% of funds on Advert"
 * ran five times a cycle and was really 1 - 0.8^5 = 67% of funds, with Wilson
 * and the upgrades stacked on top. That is not the budget CONFIG states or the
 * manual's ("each cycle ... at least 20% of current funds"), and four of the five
 * decisions were made on money that hadn't changed: funds only move by revenue
 * at START, where the game books the cycle's revenue and expenses. So START is
 * the one tick with new information, and the one the fractions were written for.
 * (This makes the budget honest; it is the offer HOLD, not this, that protects
 * the valuation while a round is being sold.)
 * @param {string | null} state - what nextUpdate() last resolved with
 */
export function isSpendTick(state) {
  return state === "START";
}

/** @param {NS} ns @param {string | null} state */
function tick(ns, state) {
  // Round is published by lib/corp-invest.js; default to 1 until it has run so we
  // never pay dividends before the investment rounds are banked.
  const round = globalThis.gordCorpRound ?? 1;
  const corp = safe(() => ns.corporation.getCorporation());
  if (!corp) return;
  const spend = isSpendTick(state);

  // Found by INDUSTRY, not by the configured name: a division created by hand in
  // the Corporation UI can be called anything, and matching on CO.tobaccoDivision
  // .name would silently skip the product pipeline for it.
  const tobaccoName = divisionByIndustry(ns, TOBACCO_INDUSTRY);
  if (tobaccoName) {
    const tobacco = { name: tobaccoName };
    manageProducts(ns, tobacco, spend);
    if (spend) manageWilsonAdvert(ns, tobacco, corp);
  }

  if (spend) buyUpgrades(ns, round);
  manageDividends(ns, corp, round);
  flushBuyJournal(ns);
  publishState(ns, round, corp);
  logStatus(ns, round, corp);
}

// ── Wilson Analytics + Advert (product division) ─────────────────────────────

/**
 * Drive the product division's advertising, the main profit lever in the product
 * rounds: each cycle buy Wilson Analytics levels while affordable (capped so it
 * never eats more than half our funds), then spend at least advertFundsFraction
 * of funds on Advert. Wilson multiplies the benefit of every FUTURE Advert
 * purchase - it is not retroactive - which is why it's bought first, and bought
 * here per-cycle rather than in a rotation phase. Only called once Tobacco
 * exists, so no Wilson/Advert money is wasted in the material rounds (the manual:
 * don't buy Wilson in rounds 1-2).
 *
 * The Advert fraction steps up once profit clears the manual's
 * thresholdOfFocusingOnAdvert (~1e18/s): past that point Advert's benefit
 * outweighs essentially anything else the money could buy (manual 19.4.2).
 * @param {NS} ns @param {any} corp
 */
function manageWilsonAdvert(ns, div, corp) {
  const c = ns.corporation;
  // An investment round is ready and lib/corp-invest.js is waiting for its offer
  // to settle: every dollar spent now comes straight off the valuation on sale.
  // (offerHoldActive, not the bare flag: a hold nobody is tending expires.)
  if (offerHoldActive()) return;

  for (let guard = 0; guard < CO.upgradeSteps; guard++) {
    const cost = safe(() => c.getUpgradeLevelCost(WILSON)) ?? Infinity;
    if (!affordable(ns, cost) || cost > corpFunds(ns) * 0.5) break;
    if (!did(() => c.levelUpgrade(WILSON))) break;
    noteBuy("Wilson Analytics", cost);
  }

  const profit = (corp.revenue ?? 0) - (corp.expenses ?? 0);
  const fraction = profit >= CO.advertFocusProfit ? CO.advertFocusFraction : CO.advertFundsFraction;
  let budget = corpFunds(ns) * fraction;
  for (let guard = 0; guard < CO.upgradeSteps; guard++) {
    const cost = safe(() => c.getHireAdVertCost(div.name)) ?? Infinity;
    if (cost > budget || !affordable(ns, cost)) break;
    if (!did(() => c.hireAdVert(div.name))) break;
    noteBuy(`Advert (${div.name})`, cost);
    budget -= cost;
  }
}

// ── Purchase journal ─────────────────────────────────────────────────────────

// Buys since the last flush. Module state is fine here (unlike the one-shot
// phases): this script is a long-lived process.
/** @type {Record<string, number>} */
let _buys = {};

/** Tally one purchase toward the next journal batch line. */
function noteBuy(label, cost) {
  _buys[label] = (_buys[label] ?? 0) + 1;
  _buys.$spend = (_buys.$spend ?? 0) + (Number.isFinite(cost) ? cost : 0);
}

/**
 * Emit the accumulated purchases as one journal line, at most every
 * CO.journal.buysMs. Wilson, Advert and the corp-wide upgrades each land many
 * times a minute in the product rounds - logged raw they'd drown the journal, so
 * the batch line is the deal: full visibility, one line a minute.
 * @param {NS} ns
 */
function flushBuyJournal(ns) {
  const rec = accumulateJournal("steadyBuys", CO.journal.buysMs, _buys);
  _buys = {};
  if (rec) emitEvent(`[corp] Bought: ${summariseCounts(ns, rec)}`, "corp");
}

// ── Logging (ns.print is 0 RAM; throttled so the per-cycle tick doesn't spam) ──

let _lastLog = 0;

/** @param {NS} ns @param {number} round @param {any} corp */
function logStatus(ns, round, corp) {
  const now = Date.now();
  if (now - _lastLog < CO.logEveryMs) return;
  _lastLog = now;

  const profit = (corp.revenue ?? 0) - (corp.expenses ?? 0);
  const roundLabel = round > CO.investmentRounds ? "post-invest" : `round ${round}/${CO.investmentRounds}`;
  const div = corp.dividendRate ? `${(corp.dividendRate * 100).toFixed(0)}%` : "off";
  // tributeModifier is the dividend-tax penalty; lower is better.
  const tribute = corp.tributeModifier != null ? corp.tributeModifier.toFixed(2) : "?";

  ns.print(
    `[corp] ${roundLabel} | funds $${ns.format.number(corp.funds ?? 0)} | ` +
    `rev $${ns.format.number(corp.revenue ?? 0)}/s | profit $${ns.format.number(profit)}/s | ` +
    `val $${ns.format.number(corp.valuation ?? 0)} | ${corp.public ? "public" : "private"} | div ${div} | tribute ${tribute}`
  );
}

// ── Product pipeline (Tobacco) ───────────────────────────────────────────────

/**
 * Keep a product pipeline running in the design city: develop new products up to
 * the division cap, put finished ones on sale, and recycle the lowest-rated slot
 * once we're at the cap so a newer, better product can replace it.
 *
 * The investment fraction is deliberately tiny (1% of funds - see
 * productInvestFraction): Design/Advertising investment enters the product
 * formula raised to the power 0.1, so it scales appallingly and the money is
 * worth far more in Advert and offices. What actually makes each product better
 * than the last is everything else growing between makeProduct calls.
 *
 * `spend` is the once-per-cycle tick (isSpendTick): re-pricing, recycling and
 * starting a product happen only there. Announcing a finished product and
 * putting it on sale for the first time still happen on any tick.
 * @param {NS} ns @param {{name: string}} div @param {boolean} spend
 */
function manageProducts(ns, div, spend) {
  const c = ns.corporation;
  const info = safe(() => c.getDivision(div.name));
  if (!info || !info.makesProducts) return;

  // Resolved live, and null only while the division has no city at all. Passing
  // a city the division doesn't occupy makes every call below a silent no-op.
  const city = designCity(ns, div.name);
  if (!city) return;

  const products = info.products ?? [];
  const details = products
    .map(p => safe(() => c.getProduct(div.name, city, p)))
    .filter(Boolean);

  const inDevelopment = details.some(p => (p.developmentProgress ?? 0) < 100);
  const hasResearchedTA2 = safe(() => c.hasResearched(div.name, "Market-TA.II"));

  // Put every finished product on sale. With Market-TA.II the game prices it;
  // without, priceProduct does - once a cycle, from what the last SALE showed.
  for (const p of details) {
    if ((p.developmentProgress ?? 0) < 100) continue;
    // Never been offered for sale (a fresh product's price is the empty string,
    // which the game reads as "don't sell"): start it at MP in every city NOW
    // rather than waiting for the cycle tick. Only then - an unconditional
    // "MP" here would stamp out the price the cycle tick worked out.
    if (unpriced(p.desiredSellPrice)) safe(() => c.sellProduct(div.name, city, p.name, "MAX", "MP", true));
    if (hasResearchedTA2) {
      // TA.II overrides the price field, so it only needs to be valid.
      if (spend) safe(() => c.sellProduct(div.name, city, p.name, "MAX", "MP", true));
      safe(() => c.setProductMarketTA2(div.name, p.name, true));
    } else if (spend) {
      for (const sellCity of info.cities ?? []) priceProduct(ns, div.name, sellCity, p.name);
    }
    if (!announcedFinished.has(p.name)) {
      announcedFinished.add(p.name);
      emitEvent(`[corp] Product ${p.name} finished, now on sale ($${ns.format.number(totalInvest(p))} invested)`, "corp");
    }
  }

  // Starting or recycling a product is a spend like any other: once a cycle.
  if (!spend) return;

  // Only ever develop one product at a time (they share design attention).
  if (inDevelopment) return;

  const maxProducts = info.maxProducts ?? CO.maxProductsFallback;

  // Budget for the next product's design + marketing. The manual's rule is flatly
  // "it's fine to spend 1% of your current funds" - there is no minimum in it -
  // and productInvestMin is ours, to stop a rich corp burning a slot on a rubbish
  // product when it could wait a cycle and do better.
  //
  // It must NOT apply to the FIRST product, which is not a quality decision at
  // all: rounds 3 and 4 are gated on finished products (productsBeforeRound), so
  // a corp under the floor waits for money it can only get by accepting a round
  // it can never reach. That is a closed loop, and it is where the BN3 corp sat
  // with $3.4b against a $100b implied floor and a $1.1t offer it couldn't take.
  // Investment enters the rating formula at power 0.1, so a cheap first product
  // costs almost nothing in quality and buys the round that pays for the rest.
  const funds = corpFunds(ns);
  const invest = Math.min(funds * CO.productInvestFraction, CO.productInvestCap);
  const floor = products.length ? CO.productInvestMin : 0;
  if (invest <= floor) return; // too poor to make a worthwhile product yet

  // At the cap with nothing in development: recycle the lowest-RATED slot,
  // unconditionally. The manual's round-3+ loop is "continuously develop new
  // product" - each one is almost always better than the last because RP,
  // offices and employee stats have all grown since, NOT because of the design
  // investment. (An earlier version gated this on the new product out-investing
  // the weakest by 2x, which deadlocked the pipeline forever once two products
  // hit productInvestCap.)
  if (products.length >= maxProducts) {
    const finished = details.filter(p => (p.developmentProgress ?? 0) >= 100);
    if (!finished.length) return;
    const worst = finished.reduce((a, b) => ((a.rating ?? 0) <= (b.rating ?? 0) ? a : b));
    if (did(() => c.discontinueProduct(div.name, worst.name))) {
      announcedFinished.delete(worst.name);
      forgetProbes(div.name, worst.name);
      emitEvent(`[corp] Discontinued ${worst.name} (lowest rating) to develop a better product`, "corp");
    }
    return; // freed slot; a new product is created next tick
  }
  const idx = nextProductIndex(products);
  const name = `${PRODUCT_PREFIX}${idx}`;
  if (did(() => c.makeProduct(div.name, city, name, invest / 2, invest / 2))) {
    emitEvent(`[corp] Developing product ${name} in ${city} ($${ns.format.number(invest)} invested)`, "corp");
  }
}

// ── Product pricing without Market-TA.II ─────────────────────────────────────
//
// A product sold at "MP" is sold at COST: a product's market price is just 5x its
// input materials. What it will actually fetch is MP plus a markup that, for any
// decent product, dwarfs MP - and Market-TA.II, the research that finds it, costs
// 70k RP behind a 140k pool that round 3 never banks. The manual calls pricing
// this by script "the best optimization in round 3+", and the gap is not subtle:
// profit is what rounds 3 and 4 are valued on.
//
// The game's sale rule (Division.processSaleState): above MP + MarkupLimit,
//
//     MaxSalesVolume = Potential * (MarkupLimit / (Price - MP))^2
//
// TA.II solves that for the price that sells exactly what's in the warehouse.
// Doing the same by formula needs MarkupLimit, which needs the product's hidden
// `markup`, plus demand, competition (two $5b unlocks), the Business factor and
// Advert - i.e. getOffice, getUpgradeLevel and more on this script's RAM bill.
// The manual's other route needs none of it: OBSERVE one sale. If a price was too
// high to sell everything, then  Sold * (Price - MP)^2 = Potential * MarkupLimit^2
// - the whole unknown right-hand side, measured in one number. The price that
// would have sold `target` instead is therefore
//
//     Price' = MP + (Price - MP) * sqrt(Sold / target)
//
// exactly, from four fields getProduct already returns. So this costs NO extra
// RAM (getProduct and sellProduct were both already reached), and it tracks the
// thing we can't see as it moves - Advert, Business staff, demand - because it is
// re-measured every cycle.
//
// The measurement only exists while the shelf does NOT sell out, so the target is
// deliberately a little under everything (leftoverTarget): a constant ~2% of a
// cycle's stock stays on the shelf, costing ~1% of the markup, and in return every
// cycle is a fresh, exact reading. When it does sell out (the potential jumped -
// a Wilson level, a new office), the price was too LOW by an unknown amount, so
// the markup is stepped up, and stepped harder each consecutive sell-out
// (probeStep, squared each time), until a sale overshoots and gives a reading.
// That is also the bootstrap from "MP": a handful of cycles to climb any number
// of orders of magnitude, one cycle of thin sales at the top, then exact.
//
// Per CITY, because each city has its own stock, Business staff and rating.

// seconds in a corp cycle - a game constant (secondsPerMarketCycle). getConstants
// would be 10GB for one integer.
const CYCLE_SECONDS = 10;

// Probe step per "division|product|city", carried between cycles. Module state is
// fine: this script is a long-lived process, and losing it on a restart only
// costs the escalation its memory (the price itself lives in the game).
/** @type {Map<string, number>} */
const _probes = new Map();

/** Drop a discontinued product's probe state. */
function forgetProbes(divName, product) {
  for (const key of [..._probes.keys()]) {
    if (key.startsWith(`${divName}|${product}|`)) _probes.delete(key);
  }
}

/** True for a price the game treats as "not for sale" (never set). */
function unpriced(price) {
  return price === undefined || price === null || (typeof price === "string" && price.trim() === "");
}

/**
 * A sell-price field as a number, or NaN when it isn't a plain number ("MP", an
 * expression, never set). Note Number("") is 0, not NaN - hence the guard.
 */
function numericPrice(price) {
  if (typeof price === "number") return price;
  if (typeof price !== "string" || price.trim() === "") return NaN;
  return Number(price);
}

/**
 * The price to set for one product in one city for the coming cycle, from what
 * the last SALE showed - see the block comment above for the derivation.
 * Returns price null for "sell at MP" (no markup known, or none sustainable).
 * Pure - exported for the tests.
 *
 * @param {{price: number, marketPrice: number, stored: number, sold: number, produced: number}} obs
 *   price: the price that was in force (NaN if it wasn't a plain number);
 *   marketPrice: the product's MP (productionCost) at that sale;
 *   stored: units left AFTER the sale; sold / produced: units per second.
 * @param {number | undefined} step - the probe multiplier carried from last cycle
 * @param {{leftoverTarget: number, probeStep: number, probeStepMax: number,
 *   seedMarkup: number, soldOutFraction: number, minMarkup: number}} P
 * @returns {{price: number | null, step: number}}
 */
export function nextProductPrice(obs, step, P) {
  const mp = obs.marketPrice;
  const fresh = { price: null, step: P.probeStep };
  // No MP yet: this city has never run a SALE for the product. Nothing to price.
  if (!(mp > 0) || !Number.isFinite(mp)) return fresh;

  const markup = Number.isFinite(obs.price) && obs.price > mp ? obs.price - mp : 0;
  const stored = obs.stored > 0 ? obs.stored : 0;
  const sold = obs.sold > 0 ? obs.sold : 0;
  const produced = obs.produced > 0 ? obs.produced : 0;
  const carried = Math.min(Math.max(step ?? P.probeStep, P.probeStep), P.probeStepMax);
  const asIs = { price: markup > 0 ? mp + markup : null, step: carried };

  // What was on the shelf when the sale ran. Nothing there = nothing learned.
  const available = stored + sold * CYCLE_SECONDS;
  if (!(available > 0)) return asIs;

  // SOLD OUT: the price was too low by an unknown factor (or exactly right - the
  // two look the same). Step the markup up; harder each consecutive time.
  if (stored <= available * P.soldOutFraction) {
    if (!(markup > 0)) return { price: mp * (1 + P.seedMarkup), step: P.probeStep };
    return { price: mp + markup * carried, step: Math.min(carried * carried, P.probeStepMax) };
  }

  // Stock left over: the sale was demand-limited, which is a measurement.
  // ...unless there is no markup to scale (it can't clear even at MP - leave it
  // there), or nothing sold at all (priced out of the market entirely, or no
  // demand: either way restart from MP rather than scale a zero).
  if (!(markup > 0) || !(sold > 0)) return fresh;

  const target = (stored / CYCLE_SECONDS + produced) * (1 - P.leftoverTarget);
  if (!(target > 0)) return asIs;
  const next = markup * Math.sqrt(sold / target);
  // A markup that has decayed to a rounding error of MP isn't one: the product
  // can't hold a price here. Back to MP, so the next sell-out re-seeds properly
  // instead of doubling its way up from nothing.
  if (!Number.isFinite(next) || next < mp * P.minMarkup) return fresh;
  return { price: mp + next, step: P.probeStep };
}

/**
 * Re-price one finished product in one city for the coming cycle (no TA.II).
 * getProduct/sellProduct are both already in this script's RAM closure.
 * @param {NS} ns
 */
function priceProduct(ns, divName, city, product) {
  const c = ns.corporation;
  const d = safe(() => c.getProduct(divName, /** @type {any} */ (city), product));
  if (!d) return;

  const key = `${divName}|${product}|${city}`;
  const next = nextProductPrice({
    price: numericPrice(d.desiredSellPrice),
    marketPrice: d.productionCost ?? 0,
    stored: d.stored ?? 0,
    sold: d.actualSellAmount ?? 0,
    produced: d.productionAmount ?? 0,
  }, _probes.get(key), CO.productPricing);
  _probes.set(key, next.step);

  const price = next.price !== null && Number.isFinite(next.price) ? String(next.price) : "MP";
  safe(() => c.sellProduct(divName, /** @type {any} */ (city), product, "MAX", price, false));
}

/** Total money sunk into a product (its quality/earning ceiling). */
function totalInvest(product) {
  return (product.designInvestment ?? 0) + (product.advertisingInvestment ?? 0);
}

/** Highest trailing integer in existing product names, +1 (0 if none). */
function nextProductIndex(products) {
  let max = -1;
  for (const p of products) {
    const m = p.match(/(\d+)$/); // .match, not .exec - the analyzer bills `.exec(` as ns.exec
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

// ── Corp-wide upgrades ───────────────────────────────────────────────────────

/**
 * What one cycle may spend on corp-wide upgrades: upgradeBudgetFraction of the
 * SURPLUS - funds above the operating reserve and above whatever lump
 * lib/corp-expand.js is banking for (gordCorpSavingFor). Pure - exported for
 * the tests.
 *
 * The objective was missing from this. Wilson, Advert, seats and warehouse
 * levels all go through affordable(), which honours it; this budget was a plain
 * share of funds, so 36% of the money being banked left every cycle. A corp
 * saving a $9b city out of $1b a cycle levels off at $2.8b (F = 0.64 F + 1b)
 * and never gets there - the "cheapest purchase always wins" trap the objective
 * exists to close, left open on the one spender that ticks every cycle.
 * @param {number} funds @param {number} saving - gordCorpSavingFor
 */
export function upgradeBudget(funds, saving) {
  const surplus = funds * (1 - CO.fundsReserveFraction) - (saving > 0 ? saving : 0);
  return surplus > 0 ? surplus * CO.upgradeBudgetFraction : 0;
}

/**
 * Spend surplus cash leveling corp-wide upgrades, cheapest affordable first,
 * within a per-tick budget so we never drain the reserve or block expansions.
 *
 * Rounds 1-2 shop from upgradePriorityByRound (Smart Storage, then + Smart
 * Factories) instead of the full list: the manual says those are the ONLY
 * corp-wide upgrades worth early money, and the stat upgrades' lower base price
 * would otherwise win the cheapest-first scan with the exact purchases the
 * manual tells you to skip.
 * @param {NS} ns @param {number} round
 */
function buyUpgrades(ns, round) {
  const c = ns.corporation;
  const priority = /** @type {any[]} */ (CO.upgradePriorityByRound[round] ?? UPGRADE_PRIORITY);

  // Structure first. The build phases publish these once the current round's
  // capacity (corp-expand) and offices (corp-office) are fully built; until then
  // every dollar spent here is one the buildout needed more. The two used to race
  // for the same funds and this side won - it ticks several times a second
  // against the phases' once-per-rotation passes - so a corp that couldn't afford
  // its own warehouses still bought Smart Storage levels for them. Both default
  // falsy, so a fresh corp waits for the phases' first passes.
  if (!globalThis.gordCorpExpandDone || !globalThis.gordCorpOfficeDone) return;
  if (offerHoldActive()) return; // see manageWilsonAdvert

  let budget = upgradeBudget(corpFunds(ns), globalThis.gordCorpSavingFor ?? 0);

  for (let guard = 0; guard < CO.upgradeSteps; guard++) {
    let cheapest = null;
    let cheapestCost = Infinity;
    for (const up of priority) {
      const cost = safe(() => c.getUpgradeLevelCost(up)) ?? Infinity;
      if (cost < cheapestCost) {
        cheapestCost = cost;
        cheapest = up;
      }
    }
    if (!cheapest || cheapestCost > budget) break;
    if (!did(() => c.levelUpgrade(cheapest))) break;
    noteBuy(cheapest, cheapestCost);
    budget -= cheapestCost;
  }
}

// ── Dividends ────────────────────────────────────────────────────────────────

/**
 * Once public and past the investment rounds and turning a strong profit, pay the
 * player a dividend. Corp funds are otherwise walled off from personal money.
 * issueDividends is a silent no-op while private, so the public check (set by
 * lib/corp-invest.js going public after round 4) is what makes this actually pay.
 * @param {NS} ns
 */
function manageDividends(ns, corp, round) {
  if (!corp.public) return;                    // issueDividends no-ops while private
  if (round <= CO.investmentRounds) return;    // don't bleed profit while still growing valuation
  const profitPerSec = (corp.revenue ?? 0) - (corp.expenses ?? 0);
  if (profitPerSec < DIVIDEND_MIN_PROFIT_PER_SEC) return;
  if ((corp.dividendRate ?? 0) >= DIVIDEND_RATE) return;
  if (did(() => ns.corporation.issueDividends(DIVIDEND_RATE))) {
    emitEvent(`[corp] Dividends on at ${(DIVIDEND_RATE * 100).toFixed(0)}% ` +
      `(profit $${ns.format.number(profitPerSec)}/s) - the corp now pays you`, "corp");
  }
}

// ── Dashboard state ──────────────────────────────────────────────────────────

/** @param {NS} ns */
function publishState(ns, round, corp) {
  const c = ns.corporation;

  const divisions = (corp.divisions ?? []).map(name => {
    const d = safe(() => c.getDivision(name));
    return {
      name,
      industry: d?.industry ?? "?",
      products: d?.products?.length ?? 0,
      maxProducts: d?.maxProducts ?? 0,
      research: d?.researchPoints ?? 0,
      profit: (d?.lastCycleRevenue ?? 0) - (d?.lastCycleExpenses ?? 0),
    };
  });

  globalThis.gordCorpState = {
    name: corp.name,
    funds: corp.funds,
    revenue: corp.revenue,
    expenses: corp.expenses,
    profit: (corp.revenue ?? 0) - (corp.expenses ?? 0),
    valuation: corp.valuation,
    public: corp.public,
    dividendRate: corp.dividendRate,
    round,
    offerFunds: globalThis.gordCorpOffer ?? 0,
    divisions,
    updatedAt: Date.now(),
  };
}
