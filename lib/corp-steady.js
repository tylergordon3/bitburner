// lib/corp-steady.js
//
// The always-on "operate the corp" half of the old lib/corp.js, split off so the
// permanently-resident corp script is small. It runs forever on the reserved
// cloud-corp host and only touches the corporation calls needed to OPERATE an
// existing corp every cycle:
//   - publish globalThis.gordCorpState for ui/dashboard.js,
//   - spend surplus cash on corp-wide upgrades,
//   - run the product pipeline (develop / sell / recycle products),
//   - pay dividends once we're past the investment rounds.
//
// The heavy, bounded STRUCTURAL work (unlocks, expanding industries/cities,
// growing + staffing offices, warehouses, boost materials, material selling,
// research, investment rounds) lives in lib/corp-build.js, which the daemon
// runs as a periodic one-shot on borrowed off-home RAM. That file publishes the
// current investment round + offer via globalThis so this one doesn't need the
// (10GB) getInvestmentOffer call.
//
// Self-contained (NO imports) like the original: the daemon scp's + exec's it.

const PRODUCT_CITY = "Aevum"; // where products are designed; also produces + sells
const TOBACCO = { name: "Tobacco" };

// Corp-wide levelable upgrades, in the order we prefer to spend on them.
const UPGRADE_PRIORITY = /** @type {any[]} */ ([
  "Smart Storage",
  "Smart Factories",
  "FocusWires",
  "Neural Accelerators",
  "Speech Processor Implants",
  "Nuoptimal Nootropic Injector Implants",
  "ABC SalesBots",
  "Wilson Analytics",
  "Project Insight",
]);

const PRODUCT_PREFIX = "Tobacco-v";
const FUNDS_RESERVE_FRACTION = 0.1;
const DIVIDEND_RATE = 0.1;
const DIVIDEND_MIN_PROFIT_PER_SEC = 1e9;

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

  if (corp.divisions.includes(TOBACCO.name)) {
    manageProducts(ns, TOBACCO);
  }

  buyUpgrades(ns);
  manageDividends(ns, corp, round);
  publishState(ns, round, corp);
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
  }

  // Only ever develop one product at a time (they share design attention).
  if (inDevelopment) return;

  const maxProducts = info.maxProducts ?? 3;

  // Budget for the next product's design + marketing.
  const funds = corpFunds(ns);
  const invest = Math.min(funds * 0.02, 1e12);
  if (invest < 1e9) return; // too poor to make a worthwhile product yet

  // At the cap with nothing in development: only recycle a slot if the new
  // product would be clearly better-funded than our weakest one.
  if (products.length >= maxProducts) {
    const finished = details.filter(p => (p.developmentProgress ?? 0) >= 100);
    if (!finished.length) return;
    const worst = finished.reduce((a, b) =>
      totalInvest(a) <= totalInvest(b) ? a : b);
    if (invest <= totalInvest(worst) * 2) return; // not worth the redevelopment
    safe(() => c.discontinueProduct(div.name, worst.name));
    return; // freed slot; a new product is created next tick
  }
  const idx = nextProductIndex(products);
  const name = `${PRODUCT_PREFIX}${idx}`;
  safe(() => c.makeProduct(div.name, PRODUCT_CITY, name, invest / 2, invest / 2));
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
  let budget = corpFunds(ns) * (1 - FUNDS_RESERVE_FRACTION) * 0.4;

  for (let guard = 0; guard < 200; guard++) {
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
 * Once past the investment rounds and turning a strong profit, pay the player a
 * dividend. Corp funds are otherwise walled off from personal money.
 * @param {NS} ns
 */
function manageDividends(ns, corp, round) {
  if (round <= 2) return; // don't bleed profit while still growing valuation
  const profitPerSec = (corp.revenue ?? 0) - (corp.expenses ?? 0);
  if (profitPerSec < DIVIDEND_MIN_PROFIT_PER_SEC) return;
  if ((corp.dividendRate ?? 0) >= DIVIDEND_RATE) return;
  safe(() => ns.corporation.issueDividends(DIVIDEND_RATE));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** @param {NS} ns */
function corpFunds(ns) {
  return safe(() => ns.corporation.getCorporation().funds) ?? 0;
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
