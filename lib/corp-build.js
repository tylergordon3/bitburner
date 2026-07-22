// lib/corp-build.js
//
// The bounded "build the corp bigger" half of the old lib/corp.js. It carries the
// expensive but occasional STRUCTURAL corporation calls (expand industry/city,
// buy + grow warehouses, grow + staff offices, unlocks, boost materials, material
// selling, research, accept investment rounds). Because these are needed far less
// than the per-cycle operations in lib/corp-steady.js, this file is a ONE-SHOT:
// it does a single pass and exits, so its large RAM footprint is only borrowed
// transiently. The daemon relaunches it each tick (on the roomiest off-home host)
// until buildout converges, at which point each pass is a quick no-op.
//
// It publishes globalThis.gordCorpRound / gordCorpOffer so corp-steady.js can
// read the investment round without paying for getInvestmentOffer itself.
//
// Its only import is lib/config.js, which has no Netscript calls: the daemon
// scp's the whole source tree and exec's this file.
//
// Note: hasWarehouse() was dropped in favour of getWarehouse() truthiness (both
// were 10GB; getWarehouse returns undefined via safe() when there's no warehouse),
// trimming one distinct corporation call. getIndustryData is kept (rather than
// hardcoding the per-industry boost factors) so the boost-material split stays
// correct without relying on remembered game constants.

import { CONFIG } from "./config.js";

// All tuning lives in CONFIG.corp; the `any` casts keep checkJs happy where the
// corporation API wants its own string-union types rather than plain strings
// (see the enum-cast note in the project memory).
const CO = CONFIG.corp;

const CITIES = /** @type {any[]} */ (CO.cities);
const PRODUCT_CITY = /** @type {any} */ (CO.productCity);

const AGRI = { name: CO.agriDivision.name, industry: /** @type {any} */ (CO.agriDivision.industry) };
const TOBACCO = { name: CO.tobaccoDivision.name, industry: /** @type {any} */ (CO.tobaccoDivision.industry) };

const BOOST_MATERIALS = /** @type {any[]} */ (CO.boostMaterials);
const MATERIAL_SIZE = CO.materialSize;
const BOOST_WAREHOUSE_FRACTION = CO.boostWarehouseFraction;

const JOBS_MATERIAL = CO.jobsMaterial;
const JOBS_PRODUCT = CO.jobsProduct;

const AGRI_TARGETS = CO.agriTargets;
const AGRI_TARGETS_MAX = CO.agriTargetsMax;
const TOBACCO_TARGETS = CO.tobaccoTargets;

const RESEARCH_PRIORITY = /** @type {any[]} */ (CO.researchPriority);
const RESEARCH_RESERVE_MULT = CO.researchReserveMult;

const FUNDS_RESERVE_FRACTION = CO.fundsReserveFraction;

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  if (!ns.corporation.hasCorporation()) return; // nothing to build yet

  try {
    buildPass(ns);
  } catch (e) {
    ns.print(`corp-build error: ${String(e)}`);
  }
  // One-shot: exit so this file's large RAM footprint is only held transiently.
}

/** @param {NS} ns */
function buildPass(ns) {
  const c = ns.corporation;

  ensureUnlocks(ns);

  const corp = c.getCorporation();
  const round = safe(() => c.getInvestmentOffer().round) ?? 99; // 99 => past all rounds

  // Publish the round + current offer so corp-steady.js can read them cheaply.
  globalThis.gordCorpRound = round;
  globalThis.gordCorpOffer = safe(() => c.getInvestmentOffer().funds) ?? 0;

  // ── Agriculture: baseline material income + investment farm ──────────────────
  ensureDivision(ns, AGRI);
  const agriTarget = AGRI_TARGETS[round] ?? AGRI_TARGETS_MAX;
  buildMaterialDivision(ns, AGRI, agriTarget);

  // ── Tobacco: unlocked once the two Agriculture-funded rounds are banked ──────
  const wantTobacco = round > CO.investmentRounds || corp.divisions.includes(TOBACCO.name);
  if (wantTobacco) {
    ensureDivision(ns, TOBACCO);
    buildProductDivision(ns, TOBACCO);
  }

  // ── Strategic late-game buys ─────────────────────────────────────────────────
  // Only once the money engine is established (past the farmed rounds), so early
  // funds aren't diverted from the Agriculture/Tobacco buildout. Both are
  // affordability-gated and both reuse calls already in this file's RAM closure,
  // so they add no RAM: the tax unlocks (Government Partnership grants "Lobbying
  // is great!") and the throwaway Real Estate division ("Own the land").
  if (round > CO.investmentRounds) {
    ensureTaxUnlocks(ns);
    maybeExpandRealEstate(ns);
  }

  // ── Investment ───────────────────────────────────────────────────────────────
  manageInvestment(ns, round, agriTarget);

  logBuildSummary(ns, round);
}

// ── Unlocks ────────────────────────────────────────────────────────────────────

/** @param {NS} ns */
function ensureUnlocks(ns) {
  const c = ns.corporation;
  for (const unlock of /** @type {any[]} */ (CO.unlocks)) {
    if (safe(() => c.hasUnlock(unlock))) continue;
    const cost = safe(() => c.getUnlockCost(unlock)) ?? Infinity;
    if (affordable(ns, cost)) safe(() => c.purchaseUnlock(unlock));
  }
}

/**
 * Buy the dividend-tax unlocks once affordable, cheapest-first. Purchasing
 * "Government Partnership" also grants the "Lobbying is great!" achievement.
 * Uses only unlock APIs already called above, so it adds no RAM. Logs progress
 * toward the next unlock while we can't yet afford it.
 * @param {NS} ns
 */
function ensureTaxUnlocks(ns) {
  const c = ns.corporation;
  for (const unlock of /** @type {any[]} */ (CO.taxUnlocks)) {
    if (safe(() => c.hasUnlock(unlock))) continue;

    const cost = safe(() => c.getUnlockCost(unlock)) ?? Infinity;
    if (affordable(ns, cost)) {
      if (did(() => c.purchaseUnlock(unlock))) {
        const ach = unlock === CO.lobbyingUnlock ? ' — "Lobbying is great!" achievement' : "";
        ns.tprint(`[corp] Purchased ${unlock} (lower dividend tax)${ach}.`);
      }
    } else {
      const ach = unlock === CO.lobbyingUnlock ? ' ("Lobbying is great!" achievement)' : "";
      ns.print(`[corp] Targeting ${unlock}${ach}: $${ns.format.number(corpFunds(ns))} / $${ns.format.number(cost)} (${pctStr(corpFunds(ns), cost)})`);
    }
    // Cheapest-first only: stop at the first unlock we don't own yet so the huge
    // Government Partnership cost never hides progress on Shady Accounting.
    break;
  }
}

/**
 * Expand into the Real Estate industry exactly once, purely for the "Own the
 * land" achievement (any division with that industry). Deliberately NOT built
 * out - it just has to exist. expandIndustry/getIndustryData are already used
 * here, so this adds no RAM.
 * @param {NS} ns
 */
function maybeExpandRealEstate(ns) {
  const c = ns.corporation;
  const re = CO.realEstate;
  if (safe(() => c.getCorporation().divisions.includes(re.name))) return;

  const cost = safe(() => c.getIndustryData(/** @type {any} */ (re.industry)).startingCost) ?? Infinity;
  if (!affordable(ns, cost)) {
    ns.print(`[corp] Targeting Real Estate division ("Own the land" achievement): $${ns.format.number(corpFunds(ns))} / $${ns.format.number(cost)}`);
    return;
  }
  if (did(() => c.expandIndustry(/** @type {any} */ (re.industry), re.name))) {
    ns.tprint(`[corp] Expanded into Real Estate ("${re.name}") — "Own the land" achievement.`);
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
      safe(() => c.expandCity(div.name, city));
    }
    if (!safe(() => c.getWarehouse(div.name, city))) {
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
    if (!safe(() => c.getWarehouse(div.name, city))) continue;

    upgradeWarehouseTo(ns, div.name, city, target.warehouse);
    staffOffice(ns, div.name, city, target.office, JOBS_MATERIAL);

    if (safe(() => c.hasUnlock("Smart Supply"))) {
      safe(() => c.setSmartSupply(div.name, city, true));
    }

    // Sell everything this industry produces at market price.
    for (const mat of industryData?.producedMaterials ?? /** @type {any[]} */ (CO.defaultProducedMaterials)) {
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
    if (!safe(() => c.getWarehouse(div.name, city))) continue;

    upgradeWarehouseTo(ns, div.name, city, TOBACCO_TARGETS.warehouse);

    const isDesign = city === PRODUCT_CITY;
    const officeTarget = isDesign ? TOBACCO_TARGETS.designOffice : TOBACCO_TARGETS.supportOffice;
    staffOffice(ns, div.name, city, officeTarget, isDesign ? JOBS_PRODUCT : JOBS_MATERIAL);

    if (safe(() => c.hasUnlock("Smart Supply"))) {
      safe(() => c.setSmartSupply(div.name, city, true));
    }

    buyBoostMaterials(ns, div.name, city, industryData);
  }

  hireAdVertIfCheap(ns, div.name, CO.productAdVertMaxFraction);
  manageResearch(ns, div.name);
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
    break; // strict order - don't skip ahead to a cheaper later research
  }
}

// ── Shared building blocks ───────────────────────────────────────────────────

/** Upgrade a warehouse toward a target level, one affordable step at a time. */
function upgradeWarehouseTo(ns, divName, city, targetLevel) {
  const c = ns.corporation;
  for (let i = 0; i < CO.warehouseUpgradeSteps; i++) {
    const wh = safe(() => c.getWarehouse(divName, city));
    if (!wh || wh.level >= targetLevel) return;
    const cost = safe(() => c.getUpgradeWarehouseCost(divName, city, 1)) ?? Infinity;
    if (!affordable(ns, cost)) return;
    if (!did(() => c.upgradeWarehouse(divName, city, 1))) return;
  }
}

/**
 * Grow an office to `targetSize`, fill every seat, and assign jobs by the given
 * role split.
 * @param {NS} ns
 */
function staffOffice(ns, divName, city, targetSize, jobRatios) {
  const c = ns.corporation;
  let office = safe(() => c.getOffice(divName, city));
  if (!office) return;

  while (office.size < targetSize) {
    const step = Math.min(CO.officeStep, targetSize - office.size);
    const cost = safe(() => c.getOfficeSizeUpgradeCost(divName, city, step)) ?? Infinity;
    if (!affordable(ns, cost)) break;
    if (!did(() => c.upgradeOfficeSize(divName, city, step))) break;
    office = safe(() => c.getOffice(divName, city)) ?? office;
  }

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
 * production factors. bulkPurchase buys instantly, so we guard on both free
 * warehouse space and funds.
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
    if (shortfall <= target * CO.boostShortfallTolerance) continue;

    const qtyBySpace = Math.floor(freeSpace / size);
    const qty = Math.min(shortfall, qtyBySpace);
    if (qty <= 0) continue;

    const price = safe(() => c.getMaterial(divName, city, mat).marketPrice) ?? 0;
    if (price <= 0 || !affordable(ns, qty * price)) continue;

    safe(() => c.bulkPurchase(divName, city, mat, qty));
    freeSpace -= qty * size;
  }
}

/** Hire AdVert while its cost is a small slice of funds (default 15%). */
function hireAdVertIfCheap(ns, divName, maxFraction = CO.adVertMaxFraction) {
  const c = ns.corporation;
  const cost = safe(() => c.getHireAdVertCost(divName)) ?? Infinity;
  if (cost <= corpFunds(ns) * maxFraction && affordable(ns, cost)) {
    safe(() => c.hireAdVert(divName));
  }
}

// ── Investment ───────────────────────────────────────────────────────────────

/**
 * Accept an investment offer once Agriculture has grown to the round's targets.
 * Only rounds 1 and 2 are farmed.
 * @param {NS} ns
 */
function manageInvestment(ns, round, agriTarget) {
  if (round > CO.investmentRounds) return;
  if (!agricultureReady(ns, agriTarget)) return;
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

// ── Logging (ns.print / ns.tprint are 0 RAM) ─────────────────────────────────

/**
 * One concise summary per build pass, printed to this script's own tail log.
 * Reuses getCorporation/getDivision/hasUnlock (all already called this pass), so
 * it costs no extra RAM. Also republishes achievement status on globalThis so
 * corp-steady.js / the dashboard can show it without paying for hasUnlock.
 * @param {NS} ns @param {number} round
 */
function logBuildSummary(ns, round) {
  const c = ns.corporation;
  const corp = safe(() => c.getCorporation());
  if (!corp) return;

  const profit = (corp.revenue ?? 0) - (corp.expenses ?? 0);
  ns.print(
    `[corp-build] round ${round} | funds $${ns.format.number(corp.funds)} | ` +
    `rev $${ns.format.number(corp.revenue ?? 0)}/s | profit $${ns.format.number(profit)}/s | ` +
    `valuation $${ns.format.number(corp.valuation ?? 0)}`
  );

  for (const name of corp.divisions ?? []) {
    const d = safe(() => c.getDivision(name));
    if (!d) continue;
    const dp = (d.lastCycleRevenue ?? 0) - (d.lastCycleExpenses ?? 0);
    ns.print(
      `  ${name} [${d.industry}] profit $${ns.format.number(dp)}/s | ` +
      `research ${ns.format.number(d.researchPoints ?? 0)} | ` +
      `products ${d.products?.length ?? 0}/${d.maxProducts ?? 0}`
    );
  }
}

function pctStr(have, need) {
  if (!Number.isFinite(need) || need <= 0) return "—";
  return `${Math.min(100, (have / need) * 100).toFixed(0)}%`;
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
