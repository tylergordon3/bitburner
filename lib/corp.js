// lib/corp.js
//
// Standalone Corporation manager for BitNode 3 ("Corporatocracy"). Same design
// philosophy as lib/gang.js:
//   - Self-contained (NO imports): the daemon scp's this single file to whatever
//     server has enough free RAM and exec's it there, because the corporation API
//     is far too RAM-heavy to share a fresh home with the (large) BN3 daemon.
//   - Fully IDEMPOTENT: every tick it inspects the live corp state and nudges it
//     toward the target configuration. It never assumes a linear script order.
//     This matters because a corporation PERSISTS through augmentation installs
//     (a soft reset) - after an install the daemon just relaunches this file and
//     it resumes managing the existing corp mid-stride.
//   - Publishes globalThis.gordCorpState every cycle for ui/dashboard.js.
//
// Strategy (the well-trodden BN3 path): stand up an Agriculture division for
// steady materials income, use it to farm two investment rounds for cash, then
// expand into Tobacco - a product industry whose developed products dwarf any
// material division's profit - and let it snowball. Dividends feed the player's
// wallet (corp funds are separate from personal money) so the daemon can keep
// buying augmentations toward the Red Pill.
//
// Assumes a corporation already exists (bn3/daemon.js creates it, mirroring how
// the BN2 daemon owns gang *creation* while lib/gang.js owns day-to-day play).

// Cast the game-enum string arrays/values to `any`: under JSDoc checkJs a string
// literal is assignable to Bitburner's union types (CorpUnlockName, CityName,
// CorpMaterialName, ...), but a variable inferred as `string` (e.g. a loop var
// over a string[] array) is NOT. Casting here keeps every downstream API call
// clean without a cast at each call site. See [[bitburner-enum-string-casts]].
const CITIES = /** @type {any[]} */ (["Aevum", "Chongqing", "Sector-12", "New Tokyo", "Ishima", "Volhaven"]);
const PRODUCT_CITY = "Aevum"; // where products are designed; also produces + sells

const AGRI = { name: "Agriculture", industry: /** @type {any} */ ("Agriculture") };
const TOBACCO = { name: "Tobacco", industry: /** @type {any} */ ("Tobacco") };

// Materials whose stockpile boosts a division's production multiplier. We keep a
// standing reserve of these in every warehouse, split by each industry's factor.
const BOOST_MATERIALS = /** @type {any[]} */ (["Real Estate", "Hardware", "Robots", "AI Cores"]);
// Warehouse space (per unit) each boost material occupies - static game
// constants, hardcoded to avoid pulling getMaterialData into our RAM cost.
const MATERIAL_SIZE = { "Real Estate": 0.005, Hardware: 0.06, Robots: 0.5, "AI Cores": 0.1 };
// Fraction of a warehouse to fill with boost materials (rest is throughput).
const BOOST_WAREHOUSE_FRACTION = 0.4;

// Corp-wide levelable upgrades, in the order we prefer to spend on them.
const UPGRADE_PRIORITY = /** @type {any[]} */ ([
  "Smart Storage",                        // + warehouse capacity
  "Smart Factories",                      // + production
  "FocusWires",                           // + employee productivity
  "Neural Accelerators",                  // + employee productivity
  "Speech Processor Implants",            // + employee productivity
  "Nuoptimal Nootropic Injector Implants",// + employee productivity
  "ABC SalesBots",                        // + sales
  "Wilson Analytics",                     // + advertising effectiveness (huge for products)
  "Project Insight",                      // + research point generation
]);

// Employee job splits per office type. Keys must be valid CorpEmployeePosition
// values; fractions sum to ~1 (remainder is topped up onto the first roles).
const JOBS_MATERIAL = {
  Operations: 0.32, Engineer: 0.26, Business: 0.20, Management: 0.16, "Research & Development": 0.06,
};
const JOBS_PRODUCT = {
  Operations: 0.24, Engineer: 0.28, Business: 0.16, Management: 0.12, "Research & Development": 0.20,
};

// Structural targets per investment round. `round` is getInvestmentOffer().round
// (1 until the first offer is accepted, then 2, 3, ...). We build Agriculture up
// to the round's targets in every city, then accept that round's offer. Rounds
// beyond 2 reuse the round-2 targets (post-round-2 focus shifts to Tobacco).
const AGRI_TARGETS = {
  1: { office: 4, warehouse: 4 },
  2: { office: 9, warehouse: 10 },
};
const AGRI_TARGETS_MAX = { office: 12, warehouse: 14 };

// Tobacco sizing. The design city runs a big office; support cities stay lean but
// still produce and sell the product.
const TOBACCO_TARGETS = {
  designOffice: 30,
  supportOffice: 9,
  warehouse: 12,
};

// Research to buy (in order) once a division has banked enough research points.
// We keep a reserve so buying research never starves ongoing point generation.
const RESEARCH_PRIORITY = /** @type {any[]} */ (["Hi-Tech R&D Laboratory", "Market-TA.I", "Market-TA.II"]);
const RESEARCH_RESERVE_MULT = 2; // only buy if points >= cost * this

// Product naming prefix; a monotonic index is parsed from existing names so it
// survives script restarts (globalThis is wiped on install).
const PRODUCT_PREFIX = "Tobacco-v";

// Keep this fraction of corp funds untouched so smart-supply purchases and
// operating expenses never bounce for lack of cash mid-cycle.
const FUNDS_RESERVE_FRACTION = 0.1;

// Start paying the player a dividend once the corp is comfortably self-funding
// (post round 2) and turning a solid profit. Corp funds don't reach the player's
// wallet otherwise, and the daemon needs personal money to keep buying augs.
const DIVIDEND_RATE = 0.1;
const DIVIDEND_MIN_PROFIT_PER_SEC = 1e9;

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  if (!ns.corporation.hasCorporation()) {
    ns.tprint("corp.js: no corporation yet - exiting (daemon creates it).");
    return;
  }

  while (true) {
    try {
      tick(ns);
    } catch (e) {
      ns.print(`corp tick error: ${String(e)}`);
    }
    // nextUpdate() sleeps until the next corp state transition (0 RAM, and it
    // rides "bonus time" so an idle/backgrounded game fast-forwards the corp).
    await ns.corporation.nextUpdate();
  }
}

/** @param {NS} ns */
function tick(ns) {
  const c = ns.corporation;

  ensureUnlocks(ns);

  const corp = c.getCorporation();
  const round = safe(() => c.getInvestmentOffer().round) ?? 99; // 99 => past all rounds

  // ── Agriculture: our baseline material income + investment farm ──────────────
  ensureDivision(ns, AGRI);
  const agriTarget = AGRI_TARGETS[round] ?? AGRI_TARGETS_MAX;
  buildMaterialDivision(ns, AGRI, agriTarget);

  // ── Tobacco: unlocked once the two Agriculture-funded rounds are banked ──────
  const wantTobacco = round > 2 || corp.divisions.includes(TOBACCO.name);
  if (wantTobacco) {
    ensureDivision(ns, TOBACCO);
    buildProductDivision(ns, TOBACCO);
    manageProducts(ns, TOBACCO);
  }

  // ── Corp-wide spending: upgrades funded from surplus cash ────────────────────
  buyUpgrades(ns);

  // ── Investment + dividends ───────────────────────────────────────────────────
  manageInvestment(ns, round, agriTarget);
  manageDividends(ns, corp, round);

  publishState(ns, round);
}

// ── Unlocks ────────────────────────────────────────────────────────────────────

/**
 * Buy the one-time API/feature unlocks we depend on, cheapest-first. Office and
 * Warehouse API gate almost every action below, so they come first; Smart Supply
 * (auto-buys production inputs) is next. Everything is guarded, so this is a
 * no-op once they're all owned.
 * @param {NS} ns
 */
function ensureUnlocks(ns) {
  const c = ns.corporation;
  for (const unlock of /** @type {any[]} */ (["Warehouse API", "Office API", "Smart Supply"])) {
    if (safe(() => c.hasUnlock(unlock))) continue;
    const cost = safe(() => c.getUnlockCost(unlock)) ?? Infinity;
    if (affordable(ns, cost)) safe(() => c.purchaseUnlock(unlock));
  }
}

// ── Division scaffolding ─────────────────────────────────────────────────────

/** Create the division and expand it into every city with a warehouse. */
function ensureDivision(ns, div) {
  const c = ns.corporation;

  if (!c.getCorporation().divisions.includes(div.name)) {
    const cost = safe(() => c.getIndustryData(div.industry).startingCost) ?? Infinity;
    if (!affordable(ns, cost)) return;
    if (!did(() => c.expandIndustry(div.industry, div.name))) return;
  }

  const info = safe(() => c.getDivision(div.name));
  if (!info) return;

  for (const city of CITIES) {
    if (!info.cities.includes(city)) {
      // expandCity also needs cash; guard loosely against the warehouse cost.
      safe(() => c.expandCity(div.name, city));
    }
    if (!safe(() => c.hasWarehouse(div.name, city))) {
      safe(() => c.purchaseWarehouse(div.name, city));
    }
  }
}

// ── Material division (Agriculture) ──────────────────────────────────────────

/** @param {NS} ns */
function buildMaterialDivision(ns, div, target) {
  const c = ns.corporation;
  const info = safe(() => c.getDivision(div.name));
  if (!info) return;
  const industryData = safe(() => c.getIndustryData(div.industry));

  for (const city of CITIES) {
    if (!safe(() => c.hasWarehouse(div.name, city))) continue;

    upgradeWarehouseTo(ns, div.name, city, target.warehouse);
    staffOffice(ns, div.name, city, target.office, JOBS_MATERIAL);

    // Smart Supply keeps input materials flowing without micro-management.
    if (safe(() => c.hasUnlock("Smart Supply"))) {
      safe(() => c.setSmartSupply(div.name, city, true));
    }

    // Sell everything this industry produces at market price.
    for (const mat of industryData?.producedMaterials ?? /** @type {any[]} */ (["Plants", "Food"])) {
      safe(() => c.sellMaterial(div.name, city, mat, "MAX", "MP"));
    }

    buyBoostMaterials(ns, div.name, city, industryData);
  }

  hireAdVertIfCheap(ns, div.name);
}

// ── Product division (Tobacco) ───────────────────────────────────────────────

/** @param {NS} ns */
function buildProductDivision(ns, div) {
  const c = ns.corporation;
  const info = safe(() => c.getDivision(div.name));
  if (!info) return;
  const industryData = safe(() => c.getIndustryData(div.industry));

  for (const city of CITIES) {
    if (!safe(() => c.hasWarehouse(div.name, city))) continue;

    upgradeWarehouseTo(ns, div.name, city, TOBACCO_TARGETS.warehouse);

    const isDesign = city === PRODUCT_CITY;
    const officeTarget = isDesign ? TOBACCO_TARGETS.designOffice : TOBACCO_TARGETS.supportOffice;
    staffOffice(ns, div.name, city, officeTarget, isDesign ? JOBS_PRODUCT : JOBS_MATERIAL);

    if (safe(() => c.hasUnlock("Smart Supply"))) {
      safe(() => c.setSmartSupply(div.name, city, true));
    }

    buyBoostMaterials(ns, div.name, city, industryData);
  }

  // Advertising drives product demand far more than it does for materials.
  hireAdVertIfCheap(ns, div.name, 0.25);
  manageResearch(ns, div.name);
}

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
  // product would be clearly better-funded than our weakest one (each product's
  // total investment sets its ceiling). This avoids churning good products once
  // investment plateaus, while still letting early cheap products get replaced.
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

/** Buy division research in priority order, keeping a generation reserve. */
function manageResearch(ns, divName) {
  const c = ns.corporation;
  const info = safe(() => c.getDivision(divName));
  if (!info) return;
  const points = info.researchPoints ?? 0;

  for (const research of RESEARCH_PRIORITY) {
    if (safe(() => c.hasResearched(divName, research))) continue;
    const cost = safe(() => c.getResearchCost(divName, research)) ?? Infinity;
    if (points >= cost * RESEARCH_RESERVE_MULT) {
      safe(() => c.research(divName, research));
    }
    // Buy in strict order - don't skip ahead to a cheaper later research.
    break;
  }
}

// ── Shared building blocks ───────────────────────────────────────────────────

/** Upgrade a warehouse toward a target level, one affordable step at a time. */
function upgradeWarehouseTo(ns, divName, city, targetLevel) {
  const c = ns.corporation;
  for (let i = 0; i < 50; i++) {
    const wh = safe(() => c.getWarehouse(divName, city));
    if (!wh || wh.level >= targetLevel) return;
    const cost = safe(() => c.getUpgradeWarehouseCost(divName, city, 1)) ?? Infinity;
    if (!affordable(ns, cost)) return;
    if (!did(() => c.upgradeWarehouse(divName, city, 1))) return;
  }
}

/**
 * Grow an office to `targetSize`, fill every seat, and assign jobs by the given
 * role split. setJobAssignment sets absolute head-counts, so we assign each role
 * from a distribution that sums exactly to the number of employees.
 * @param {NS} ns
 */
function staffOffice(ns, divName, city, targetSize, jobRatios) {
  const c = ns.corporation;
  let office = safe(() => c.getOffice(divName, city));
  if (!office) return;

  // Grow the office toward the target, one affordable step at a time.
  while (office.size < targetSize) {
    const step = Math.min(3, targetSize - office.size); // buy in small chunks
    const cost = safe(() => c.getOfficeSizeUpgradeCost(divName, city, step)) ?? Infinity;
    if (!affordable(ns, cost)) break;
    if (!did(() => c.upgradeOfficeSize(divName, city, step))) break;
    office = safe(() => c.getOffice(divName, city)) ?? office;
  }

  // Fill any empty seats (hiring is free of corp funds).
  while (office.numEmployees < office.size) {
    if (!safe(() => c.hireEmployee(divName, city))) break;
    office.numEmployees++;
  }

  const counts = distributeJobs(office.numEmployees, jobRatios);
  for (const [role, n] of Object.entries(counts)) {
    safe(() => c.setJobAssignment(divName, city, /** @type {any} */ (role), n));
  }
}

/** Integer head-counts per role that sum exactly to `total`. */
function distributeJobs(total, ratios) {
  const roles = Object.keys(ratios);
  const counts = {};
  let assigned = 0;
  for (const r of roles) {
    counts[r] = Math.floor(total * ratios[r]);
    assigned += counts[r];
  }
  for (let i = 0; assigned < total; i++, assigned++) {
    counts[roles[i % roles.length]]++;
  }
  return counts;
}

/**
 * Top up boost materials toward a per-warehouse target split by the industry's
 * production factors (Real Estate / Hardware / Robots / AI Cores). bulkPurchase
 * buys instantly, so we guard on both free warehouse space and funds.
 * @param {NS} ns
 */
function buyBoostMaterials(ns, divName, city, industryData) {
  const c = ns.corporation;
  const wh = safe(() => c.getWarehouse(divName, city));
  if (!wh || !industryData) return;

  const factors = {
    "Real Estate": industryData.realEstateFactor ?? 0,
    Hardware: industryData.hardwareFactor ?? 0,
    Robots: industryData.robotFactor ?? 0,
    "AI Cores": industryData.aiCoreFactor ?? 0,
  };
  const totalFactor = Object.values(factors).reduce((a, b) => a + b, 0);
  if (totalFactor <= 0) return;

  const budgetSpace = wh.size * BOOST_WAREHOUSE_FRACTION;
  let freeSpace = wh.size - wh.sizeUsed;

  for (const mat of BOOST_MATERIALS) {
    const factor = factors[mat];
    if (factor <= 0) continue;

    const size = MATERIAL_SIZE[mat];
    const target = Math.floor((budgetSpace * (factor / totalFactor)) / size);
    const stored = safe(() => c.getMaterial(divName, city, mat).stored) ?? 0;
    const shortfall = target - stored;
    if (shortfall <= target * 0.02) continue; // already stocked

    const qtyBySpace = Math.floor(freeSpace / size);
    const qty = Math.min(shortfall, qtyBySpace);
    if (qty <= 0) continue;

    const price = safe(() => c.getMaterial(divName, city, mat).marketPrice) ?? 0;
    if (price <= 0 || !affordable(ns, qty * price)) continue;

    safe(() => c.bulkPurchase(divName, city, mat, qty));
    freeSpace -= qty * size; // reserve space for the remaining boost materials
  }
}

/** Hire AdVert while its cost is a small slice of funds (default 15%). */
function hireAdVertIfCheap(ns, divName, maxFraction = 0.15) {
  const c = ns.corporation;
  const cost = safe(() => c.getHireAdVertCost(divName)) ?? Infinity;
  if (cost <= corpFunds(ns) * maxFraction && affordable(ns, cost)) {
    safe(() => c.hireAdVert(divName));
  }
}

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

// ── Investment + dividends ───────────────────────────────────────────────────

/**
 * Accept an investment offer once Agriculture has actually grown to the round's
 * structural targets - tying the offer to real production value rather than a
 * magic valuation number. Only rounds 1 and 2 are farmed; later rounds cost too
 * much equity relative to what Tobacco earns on its own.
 * @param {NS} ns
 */
function manageInvestment(ns, round, agriTarget) {
  if (round > 2) return;
  if (!agricultureReady(ns, agriTarget)) return;
  // Don't accept until Agriculture is actually selling - a pre-revenue corp is
  // valued near zero, so an early offer would sell equity for almost nothing.
  if ((safe(() => ns.corporation.getCorporation().revenue) ?? 0) <= 0) return;
  safe(() => ns.corporation.acceptInvestmentOffer());
}

/** True once every Agriculture city meets this round's warehouse+office targets. */
function agricultureReady(ns, target) {
  const c = ns.corporation;
  for (const city of CITIES) {
    const wh = safe(() => c.getWarehouse(AGRI.name, city));
    const office = safe(() => c.getOffice(AGRI.name, city));
    if (!wh || !office) return false;
    if (wh.level < target.warehouse) return false;
    if (office.size < target.office || office.numEmployees < office.size) return false;
  }
  return true;
}

/**
 * Once past the investment rounds and turning a strong profit, pay the player a
 * dividend. Corp funds are otherwise walled off from personal money, and the
 * daemon needs cash to keep buying augmentations.
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

/** True if a purchase of `cost` leaves the operating reserve intact. */
function affordable(ns, cost) {
  if (!Number.isFinite(cost) || cost < 0) return false;
  const funds = corpFunds(ns);
  return funds - cost >= funds * FUNDS_RESERVE_FRACTION;
}

/**
 * Run a corp API call, swallowing the exceptions the API throws on invalid ops
 * (expanding to an existing city, buying an unaffordable upgrade, etc.). Returns
 * the call's result, or undefined if it threw. Treating a thrown call as "did
 * nothing" is exactly what the idempotent tick wants.
 */
function safe(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/**
 * Like safe(), but for the many corp mutators that return void: reports whether
 * the call *succeeded* (didn't throw). Needed wherever we branch on the outcome,
 * since a void call's return value can't distinguish success from a swallowed
 * throw.
 */
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
function publishState(ns, round) {
  const c = ns.corporation;
  const corp = safe(() => c.getCorporation());
  if (!corp) return;

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

  const offer = safe(() => c.getInvestmentOffer());

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
    offerFunds: offer?.funds ?? 0,
    divisions,
    updatedAt: Date.now(),
  };
}
