// lib/corp-steady.js
//
// The always-on "operate the corp" half of the corp manager, split off so the
// permanently-resident corp script is small. It runs forever on the reserved
// cloud-corp host and only touches the corporation calls needed to OPERATE an
// existing corp every cycle:
//   - buy tea + throw parties to keep every office at max energy/morale (guide:
//     mandatory - decayed energy/morale silently throttle production),
//   - run the product pipeline (develop / sell / recycle products),
//   - drive Wilson Analytics + Advert for the product division (the main profit
//     driver in the product rounds),
//   - spend surplus cash on corp-wide upgrades,
//   - pay dividends once we're public and past the investment rounds,
//   - publish globalThis.gordCorpState for ui/dashboard.js,
//   - record the discrete product/dividend milestones to the JOURNAL. Only the
//     edges: this tick fires several times a second, so the per-cycle tea, advert
//     and upgrade spending stay out of the log (the dashboard's CORP card already
//     shows that state continuously).
//
// The heavy, bounded STRUCTURAL work (unlocks, expanding industries/cities,
// growing + staffing offices, warehouses, export routes, boost materials,
// material selling, research, investment rounds, going public) lives in
// lib/corp-build.js, which the daemon runs as a periodic one-shot on borrowed
// off-home RAM. That file publishes the current investment round + offer via
// globalThis so this one doesn't need the (10GB) getInvestmentOffer call, plus
// gordCorpStructureDone - the handshake that stops this file's upgrade spending
// from outbidding the buildout for the same funds.
//
// Its only import is lib/config.js, which has no Netscript calls: the daemon
// scp's the whole source tree and exec's this file.

import { CONFIG } from "./config.js";
import { emitEvent } from "./events.js";

const CO = CONFIG.corp;

// Products the journal has already reported as finished. This tick runs several
// times a second, so anything reported here needs an edge to fire on, not just a
// condition. Module-level: the script is a long-lived process.
const announcedFinished = new Set();

// Where products are designed; also produces + sells. Cast to any: config values
// widen to `string`, which checkJs won't accept for the corp API's CityName union
// (a bare "Aevum" literal used to satisfy it) - see [[bitburner-enum-string-casts]].
const PRODUCT_CITY = /** @type {any} */ (CO.productCity);
const TOBACCO_INDUSTRY = CO.tobaccoDivision.industry;

// Corp-wide levelable upgrades, in the order we prefer to spend on them.
const UPGRADE_PRIORITY = /** @type {any[]} */ (CO.upgradePriority);
const WILSON = /** @type {any} */ (CO.wilsonUpgrade);

const PRODUCT_PREFIX = CO.productPrefix;
const FUNDS_RESERVE_FRACTION = CO.fundsReserveFraction;
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
  // Round is published by lib/corp-build.js; default to 1 until it has run so we
  // never pay dividends before the investment rounds are banked.
  const round = globalThis.gordCorpRound ?? 1;
  const corp = safe(() => ns.corporation.getCorporation());
  if (!corp) return;

  // Mandatory every cycle: keep energy/morale topped up across every office.
  maintainOffices(ns, corp);

  // Found by INDUSTRY, not by the configured name: a division created by hand in
  // the Corporation UI can be called anything, and matching on CO.tobaccoDivision
  // .name would silently skip the product pipeline for it. Mirrors
  // resolveDivision in lib/corp-build.js.
  const tobacco = findDivisionByIndustry(ns, corp, TOBACCO_INDUSTRY);
  if (tobacco) {
    manageProducts(ns, tobacco);
    manageWilsonAdvert(ns, tobacco);
  }

  buyUpgrades(ns);
  manageDividends(ns, corp, round);
  publishState(ns, round, corp);
  logStatus(ns, round, corp);
}

// ── Employee upkeep (tea + party) ────────────────────────────────────────────

/**
 * Buy tea for any office whose average energy has slipped, and throw a party for
 * any office whose average morale has slipped. Guide: this is mandatory every
 * cycle - decayed energy/morale quietly throttle production and, in turn, quality
 * and sales. Cheap relative to profit, so it's not funds-gated.
 * @param {NS} ns @param {any} corp
 */
function maintainOffices(ns, corp) {
  const c = ns.corporation;
  for (const divName of corp.divisions ?? []) {
    const d = safe(() => c.getDivision(divName));
    if (!d) continue;
    for (const city of d.cities ?? []) {
      const office = safe(() => c.getOffice(divName, /** @type {any} */ (city)));
      if (!office || office.numEmployees <= 0) continue;
      if ((office.avgEnergy ?? 100) < CO.teaEnergyThreshold) {
        safe(() => c.buyTea(divName, /** @type {any} */ (city)));
      }
      if ((office.avgMorale ?? 100) < CO.partyMoraleThreshold) {
        safe(() => c.throwParty(divName, /** @type {any} */ (city), CO.partyBudgetPerEmployee));
      }
    }
  }
}

// ── Wilson Analytics + Advert (product division) ─────────────────────────────

/**
 * Drive the product division's advertising, the main profit lever in the product
 * rounds (guide): each cycle buy Wilson Analytics levels while affordable (capped
 * so it never eats more than half our funds), then spend at least
 * advertFundsFraction of funds on Advert. Only called once Tobacco exists, so no
 * Wilson/Advert money is wasted in the early material rounds.
 * @param {NS} ns
 */
function manageWilsonAdvert(ns, div) {
  const c = ns.corporation;

  for (let guard = 0; guard < CO.upgradeSteps; guard++) {
    const cost = safe(() => c.getUpgradeLevelCost(WILSON)) ?? Infinity;
    if (!affordable(ns, cost) || cost > corpFunds(ns) * 0.5) break;
    if (!did(() => c.levelUpgrade(WILSON))) break;
  }

  let budget = corpFunds(ns) * CO.advertFundsFraction;
  for (let guard = 0; guard < CO.upgradeSteps; guard++) {
    const cost = safe(() => c.getHireAdVertCost(div.name)) ?? Infinity;
    if (cost > budget || !affordable(ns, cost)) break;
    if (!did(() => c.hireAdVert(div.name))) break;
    budget -= cost;
  }
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
  // tributeModifier is the dividend-tax penalty; lower is better. Free field on
  // the corp object we already hold.
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
 * the division cap, put finished ones on sale, and recycle the weakest slot once
 * we're at the cap so newer (higher-invested) products can replace it.
 * @param {NS} ns
 */
function manageProducts(ns, div) {
  const c = ns.corporation;
  const info = safe(() => c.getDivision(div.name));
  if (!info || !info.makesProducts) return;

  const products = info.products ?? [];
  const details = products
    .map(p => safe(() => c.getProduct(div.name, PRODUCT_CITY, p)))
    .filter(Boolean);

  const inDevelopment = details.some(p => (p.developmentProgress ?? 0) < 100);
  const hasResearchedTA2 = safe(() => c.hasResearched(div.name, "Market-TA.II"));

  // Put every finished product on sale (idempotent). With Market-TA.II we let the
  // game auto-price for max profit; without it, MP is a safe default.
  for (const p of details) {
    if ((p.developmentProgress ?? 0) < 100) continue;
    safe(() => c.sellProduct(div.name, PRODUCT_CITY, p.name, "MAX", "MP", true));
    if (hasResearchedTA2) safe(() => c.setProductMarketTA2(div.name, p.name, true));
    if (!announcedFinished.has(p.name)) {
      announcedFinished.add(p.name);
      emitEvent(`[corp] Product ${p.name} finished, now on sale ($${ns.format.number(totalInvest(p))} invested)`, "corp");
    }
  }

  // Only ever develop one product at a time (they share design attention).
  if (inDevelopment) return;

  const maxProducts = info.maxProducts ?? CO.maxProductsFallback;

  // Budget for the next product's design + marketing.
  const funds = corpFunds(ns);
  const invest = Math.min(funds * CO.productInvestFraction, CO.productInvestCap);
  if (invest < CO.productInvestMin) return; // too poor to make a worthwhile product yet

  // At the cap with nothing in development: only recycle a slot if the new
  // product would be clearly better-funded than our weakest one.
  if (products.length >= maxProducts) {
    const finished = details.filter(p => (p.developmentProgress ?? 0) >= 100);
    if (!finished.length) return;
    const worst = finished.reduce((a, b) =>
      totalInvest(a) <= totalInvest(b) ? a : b);
    if (invest <= totalInvest(worst) * CO.productRecycleMult) return; // not worth the redevelopment
    if (did(() => c.discontinueProduct(div.name, worst.name))) {
      announcedFinished.delete(worst.name);
      emitEvent(`[corp] Discontinued ${worst.name} to free a product slot`, "corp");
    }
    return; // freed slot; a new product is created next tick
  }
  const idx = nextProductIndex(products);
  const name = `${PRODUCT_PREFIX}${idx}`;
  if (did(() => c.makeProduct(div.name, PRODUCT_CITY, name, invest / 2, invest / 2))) {
    emitEvent(`[corp] Developing product ${name} ($${ns.format.number(invest)} invested)`, "corp");
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
    const m = /(\d+)$/.exec(p);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

// ── Corp-wide upgrades ───────────────────────────────────────────────────────

/**
 * Spend surplus cash leveling corp-wide upgrades, cheapest affordable first,
 * within a per-tick budget so we never drain the reserve or block expansions.
 * @param {NS} ns
 */
function buyUpgrades(ns) {
  const c = ns.corporation;

  // Structure first. lib/corp-build.js publishes gordCorpStructureDone once this
  // round's divisions/cities/warehouses/offices are all built; until then every
  // dollar spent here is one the buildout needed more. These two used to race for
  // the same funds every tick and this side won - it ticks several times a second
  // against corp-build's once-per-daemon-tick one-shot - so a corp that couldn't
  // afford its own warehouses still bought Smart Storage levels for them. Defaults
  // to false, so a fresh corp waits for corp-build's first pass rather than
  // spending its founding stake on upgrades.
  if (!globalThis.gordCorpStructureDone) return;

  let budget = corpFunds(ns) * (1 - FUNDS_RESERVE_FRACTION) * CO.upgradeBudgetFraction;

  for (let guard = 0; guard < CO.upgradeSteps; guard++) {
    let cheapest = null;
    let cheapestCost = Infinity;
    for (const up of UPGRADE_PRIORITY) {
      const cost = safe(() => c.getUpgradeLevelCost(up)) ?? Infinity;
      if (cost < cheapestCost) {
        cheapestCost = cost;
        cheapest = up;
      }
    }
    if (!cheapest || cheapestCost > budget) break;
    if (!did(() => c.levelUpgrade(cheapest))) break;
    budget -= cheapestCost;
  }
}

// ── Dividends ────────────────────────────────────────────────────────────────

/**
 * Once public and past the investment rounds and turning a strong profit, pay the
 * player a dividend. Corp funds are otherwise walled off from personal money.
 * issueDividends is a silent no-op while private, so the public check (set by
 * lib/corp-build.js going public after round 4) is what makes this actually pay.
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

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The division running `industry` as `{ name }`, or null. getDivision is already
 * in this file's RAM closure (maintainOffices calls it), so this costs nothing.
 * @param {NS} ns @param {any} corp
 */
function findDivisionByIndustry(ns, corp, industry) {
  for (const name of corp.divisions ?? []) {
    if (safe(() => ns.corporation.getDivision(name).industry) === industry) return { name };
  }
  return null;
}

/** @param {NS} ns */
function corpFunds(ns) {
  return safe(() => ns.corporation.getCorporation().funds) ?? 0;
}

/** True if a purchase of `cost` leaves the operating reserve intact. */
function affordable(ns, cost) {
  if (!Number.isFinite(cost) || cost < 0) return false;
  const funds = corpFunds(ns);
  return funds - cost >= funds * FUNDS_RESERVE_FRACTION;
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function did(fn) {
  try {
    fn();
    return true;
  } catch {
    return false;
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
