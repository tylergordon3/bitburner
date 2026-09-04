// lib/corp-steady.js
//
// The always-on "operate the corp" script - the per-cycle work that can't wait for
// a rotation slot. It runs forever on the reserved cloud-corp host and owns:
//   - the PRODUCT pipeline (develop / sell / recycle products),
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
import { safe, did, corpFunds, affordable, divisionByIndustry, designCity, accumulateJournal, summariseCounts } from "./corp-lib.js";

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

  while (true) {
    try {
      tick(ns);
    } catch (e) {
      ns.print(`corp-steady tick error: ${String(e)}`);
    }
    // nextUpdate() sleeps until the next corp state transition (0 RAM, and it
    // rides "bonus time" so an idle/backgrounded game fast-forwards the corp).
    await ns.corporation.nextUpdate();
  }
}

/** @param {NS} ns */
function tick(ns) {
  // Round is published by lib/corp-invest.js; default to 1 until it has run so we
  // never pay dividends before the investment rounds are banked.
  const round = globalThis.gordCorpRound ?? 1;
  const corp = safe(() => ns.corporation.getCorporation());
  if (!corp) return;

  // Found by INDUSTRY, not by the configured name: a division created by hand in
  // the Corporation UI can be called anything, and matching on CO.tobaccoDivision
  // .name would silently skip the product pipeline for it.
  const tobaccoName = divisionByIndustry(ns, TOBACCO_INDUSTRY);
  if (tobaccoName) {
    const tobacco = { name: tobaccoName };
    manageProducts(ns, tobacco);
    manageWilsonAdvert(ns, tobacco, corp);
  }

  buyUpgrades(ns, round);
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
 * @param {NS} ns
 */
function manageProducts(ns, div) {
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

  // Put every finished product on sale (idempotent). With Market-TA.II the game
  // auto-prices for max profit; without it, MP is a safe default.
  for (const p of details) {
    if ((p.developmentProgress ?? 0) < 100) continue;
    safe(() => c.sellProduct(div.name, city, p.name, "MAX", "MP", true));
    if (hasResearchedTA2) safe(() => c.setProductMarketTA2(div.name, p.name, true));
    if (!announcedFinished.has(p.name)) {
      announcedFinished.add(p.name);
      emitEvent(`[corp] Product ${p.name} finished, now on sale ($${ns.format.number(totalInvest(p))} invested)`, "corp");
    }
  }

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

  let budget = corpFunds(ns) * (1 - CO.fundsReserveFraction) * CO.upgradeBudgetFraction;

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
