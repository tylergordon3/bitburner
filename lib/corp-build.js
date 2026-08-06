// lib/corp-build.js
//
// The bounded "build the corp bigger" half of the corp manager. It carries the
// expensive but occasional STRUCTURAL corporation calls (expand industry/city,
// buy + grow warehouses, grow + staff offices, unlocks, export routes, boost
// materials, material selling, research, investment rounds, going public).
// Because these are needed far less than the per-cycle operations in
// lib/corp-steady.js, this file is a ONE-SHOT: it does a single pass and exits,
// so its large RAM footprint is only borrowed transiently. The daemon relaunches
// it each tick (on the roomiest off-home host) until buildout converges, at which
// point each pass is a quick no-op.
//
// It publishes globalThis.gordCorpRound / gordCorpOffer so corp-steady.js can
// read the investment round without paying for getInvestmentOffer itself.
//
// Strategy (community "Corporation manual"): an Agriculture + Chemical + Tobacco
// supply chain. Agriculture is the material/investment engine; Chemical is a tiny
// support division whose high-quality Chemicals are exported back to Agriculture
// to lift its output quality (the quality loop); Tobacco is the product/profit
// division, created from round 3. All four investment rounds are farmed, then the
// corp goes public and corp-steady starts paying dividends.
//
// Structural milestones (divisions founded, cities opened, unlocks bought,
// investment rounds accepted, going public) are recorded to the JOURNAL via
// lib/events.js. They're one-time events, so unlike the per-cycle operations in
// corp-steady they can all be logged without drowning it.
//
// Its imports are lib/config.js and lib/events.js, neither of which makes any
// Netscript call: the daemon scp's the whole source tree and exec's this file.
//
// Note: hasWarehouse() was dropped in favour of getWarehouse() truthiness (both
// were 10GB; getWarehouse returns undefined via safe() when there's no warehouse),
// trimming one distinct corporation call. getIndustryData is kept (rather than
// hardcoding the per-industry boost factors) so the boost-material split stays
// correct without relying on remembered game constants.

import { CONFIG } from "./config.js";
import { emitEvent } from "./events.js";

// All tuning lives in CONFIG.corp; the `any` casts keep checkJs happy where the
// corporation API wants its own string-union types rather than plain strings
// (see the enum-cast note in the project memory).
const CO = CONFIG.corp;

const CITIES = /** @type {any[]} */ (CO.cities);
const PRODUCT_CITY = /** @type {any} */ (CO.productCity);

const AGRI = { name: CO.agriDivision.name, industry: /** @type {any} */ (CO.agriDivision.industry) };
const CHEM = { name: CO.chemicalDivision.name, industry: /** @type {any} */ (CO.chemicalDivision.industry) };
const TOBACCO = { name: CO.tobaccoDivision.name, industry: /** @type {any} */ (CO.tobaccoDivision.industry) };

const BOOST_MATERIALS = /** @type {any[]} */ (CO.boostMaterials);
const MATERIAL_SIZE = CO.materialSize;
const BOOST_WAREHOUSE_FRACTION = CO.boostWarehouseFraction;

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

  const round = safe(() => c.getInvestmentOffer().round) ?? 99; // 99 => past all rounds

  // Publish the round + current offer so corp-steady.js can read them cheaply.
  globalThis.gordCorpRound = round;
  globalThis.gordCorpOffer = safe(() => c.getInvestmentOffer().funds) ?? 0;

  // ── Bootstrap, in strict "what unbricks the corp" order ─────────────────────
  // A self-funded corp is founded with exactly $150b and its funds can never be
  // topped up from personal money, so this ordering is load-bearing rather than
  // cosmetic. Unlocks used to be bought first, which on a node without SF3.3
  // (where Warehouse API + Office API cost real money) spent the entire stake
  // before Agriculture's startingCost was ever considered - leaving a corp with
  // no division, therefore no revenue, therefore permanently stuck. So:
  //   1. the division itself - the only thing that can ever earn,
  //   2. the two API unlocks the scripted buildout can't function without,
  //   3. warehouses in the cities we already occupy, then new cities.
  // Everything optional (Smart Supply, Export, Chemical, corp-wide upgrades) is
  // held back until the corp is actually earning.
  // Divisions are matched by INDUSTRY, not by the name in CONFIG - see
  // resolveDivisions. A hand-made division under any name is adopted rather than
  // ignored (and then duplicated at full startingCost).
  const AGRI_D = resolveDivision(ns, AGRI);
  ensureIndustry(ns, AGRI_D);
  ensureApiUnlocks(ns);
  ensureCities(ns, AGRI_D);

  const corp = c.getCorporation();

  // Austerity: while an API unlock is still unbought, the corp is one $50b
  // purchase away from being scriptable at all, and every other dollar spent is a
  // dollar that delays it. So we buy nothing but INPUT MATERIALS - the one spend
  // that raises revenue rather than consuming it - and let funds accumulate.
  const apisOwned = /** @type {any[]} */ (CO.apiUnlocks)
    .every(u => safe(() => c.hasUnlock(u)) ?? false);

  // ── Agriculture: baseline material income + investment farm ──────────────────
  const agriTarget = CO.agriTargets[round] ?? CO.agriTargetsMax;
  buildMaterialDivision(ns, AGRI_D, agriTarget, round, apisOwned);

  // ── Optional unlocks, from surplus only ──────────────────────────────────────
  // Deliberately after Agriculture is standing and staffed: on a starved corp
  // every dollar spent here is a dollar the division doesn't get.
  if (apisOwned) ensureOptionalUnlocks(ns, round, corp);

  // ── Chemical: support division feeding the quality loop ──────────────────────
  // From round 2 (chemicalStartRound): its Chemicals are only worth its $70b
  // startingCost once Export exists to feed them back to Agriculture. Kept tiny
  // either way (guide: don't waste funds on it).
  const CHEM_D = resolveDivision(ns, CHEM);
  if (apisOwned && (round >= CO.chemicalStartRound || corp.divisions.includes(CHEM_D.name))) {
    ensureIndustry(ns, CHEM_D);
    ensureCities(ns, CHEM_D);
    const chemTarget = CO.chemicalTargets[round] ?? CO.chemicalTargetsMax;
    buildMaterialDivision(ns, CHEM_D, chemTarget, round, apisOwned);
  }

  // ── Export routes (Plants -> Tobacco/Chemical, Chemicals -> Agriculture) ─────
  const TOBACCO_D = resolveDivision(ns, TOBACCO);
  ensureExports(ns, { [AGRI.name]: AGRI_D.name, [CHEM.name]: CHEM_D.name, [TOBACCO.name]: TOBACCO_D.name });

  // ── Tobacco: the product/profit division, created from round 3 ───────────────
  const wantTobacco = round >= CO.tobaccoStartRound || corp.divisions.includes(TOBACCO_D.name);
  if (apisOwned && wantTobacco) {
    ensureIndustry(ns, TOBACCO_D);
    ensureCities(ns, TOBACCO_D);
    buildProductDivision(ns, TOBACCO_D, round);
  }

  // ── Strategic late-game buys ─────────────────────────────────────────────────
  // Only once past the farmed rounds, so early funds aren't diverted from the
  // buildout. The tax unlocks (Government Partnership grants "Lobbying is great!")
  // and the throwaway Real Estate division ("Own the land") reuse calls already in
  // this file's RAM closure, so they add no RAM. Going public is what actually
  // enables dividends (issueDividends is a no-op on a private corp).
  if (round > CO.investmentRounds) {
    ensureTaxUnlocks(ns);
    maybeExpandRealEstate(ns);
    maybeGoPublic(ns, corp);
  }

  // Tell corp-steady whether this round's structural buildout still has an
  // outstanding step. While it does, corp-steady holds off on corp-wide upgrades:
  // the two used to race for the same funds every tick, and on a starved corp
  // steady's 36%-of-funds upgrade budget won that race - buying Smart Storage
  // levels for a division that had no warehouses to store anything in.
  globalThis.gordCorpStructureDone = apisOwned
    && corp.divisions.includes(AGRI_D.name)
    && !Number.isFinite(cheapestPendingStep(ns, AGRI_D.name, agriTarget));

  // ── Investment ───────────────────────────────────────────────────────────────
  manageInvestment(ns, round, AGRI_D.name, agriTarget);

  logBuildSummary(ns, round);
}

/**
 * The division object to work with for a configured industry: the LIVE name of
 * whichever division already runs that industry, or the configured name when
 * there isn't one yet (i.e. when we're about to found it).
 *
 * Matching on industry rather than name is what lets the buildout adopt a
 * division created by hand in the Corporation UI. The BN10 corp's Agriculture
 * division was made manually as "AgriGord"; the old name-equality check saw no
 * "Agriculture" division at all and would have paid another $40b startingCost for
 * a duplicate right next to it.
 * @param {NS} ns
 */
function resolveDivision(ns, div) {
  const c = ns.corporation;
  for (const name of safe(() => c.getCorporation().divisions) ?? []) {
    if (safe(() => c.getDivision(name).industry) === div.industry) {
      return { name, industry: div.industry };
    }
  }
  return div;
}

// ── Unlocks ────────────────────────────────────────────────────────────────────

/**
 * Buy the two unlocks the scripted buildout physically needs (Warehouse API and
 * Office API - every getWarehouse / upgradeOfficeSize / hireEmployee call throws
 * without them). Only ever called AFTER the first division exists, so it can
 * never eat the division's startingCost.
 *
 * Uses exact affordability rather than affordable(): the 10% operating reserve is
 * meaningless next to "the buildout cannot proceed at all without this", and on a
 * self-funded corp these two are most of the founding stake.
 * @param {NS} ns
 */
function ensureApiUnlocks(ns) {
  const c = ns.corporation;
  for (const unlock of /** @type {any[]} */ (CO.apiUnlocks)) {
    if (safe(() => c.hasUnlock(unlock))) continue;
    const cost = safe(() => c.getUnlockCost(unlock)) ?? Infinity;
    if (!Number.isFinite(cost)) continue;
    if (corpFunds(ns) < cost) {
      ns.print(`[corp] Blocked on ${unlock}: $${ns.format.number(corpFunds(ns))} / $${ns.format.number(cost)} (${pctStr(corpFunds(ns), cost)})`);
      return; // strict order, and nothing later is useful without this one
    }
    if (did(() => c.purchaseUnlock(unlock))) {
      emitEvent(`[corp] Unlocked ${unlock} ($${ns.format.number(cost)})`, "corp");
    }
  }
}

/**
 * Buy the nice-to-have unlocks out of surplus, once the corp is earning and past
 * each unlock's minimum round. Smart Supply hands input-material purchasing back
 * to the game (stockInputMaterials covers us until then); Export is what makes
 * the Chemical quality loop work, so it waits for round 2.
 * @param {NS} ns @param {number} round @param {any} corp
 */
function ensureOptionalUnlocks(ns, round, corp) {
  const c = ns.corporation;
  // Nothing here is worth spending on before the division is actually producing:
  // a starved corp needs every dollar in warehouses, seats and inputs first.
  if ((corp.revenue ?? 0) <= 0) return;

  for (const unlock of /** @type {any[]} */ (CO.optionalUnlocks)) {
    if (round < (CO.optionalUnlockRound[unlock] ?? 1)) continue;
    if (safe(() => c.hasUnlock(unlock))) continue;
    const cost = safe(() => c.getUnlockCost(unlock)) ?? Infinity;
    if (affordable(ns, cost)) {
      if (did(() => c.purchaseUnlock(unlock))) {
        emitEvent(`[corp] Unlocked ${unlock} ($${ns.format.number(cost)})`, "corp");
      }
    }
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
        // ASCII only - the journal tail renders a plain text stream that does not
        // decode UTF-8, so an em dash here would come out as mojibake.
        const ach = unlock === CO.lobbyingUnlock ? ' - "Lobbying is great!" achievement' : "";
        emitEvent(`[corp] Unlocked ${unlock}, lower dividend tax${ach}`, "corp");
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
    emitEvent(`[corp] Expanded into Real Estate ("${re.name}") - "Own the land" achievement`, "corp");
  }
}

/**
 * Take the corp public once past the investment rounds, issuing CO.sharesToIssue
 * new shares (0 per the guide). This is what actually enables dividends -
 * issueDividends (in corp-steady) is a silent no-op while the corp is private.
 * @param {NS} ns @param {any} corp
 */
function maybeGoPublic(ns, corp) {
  if (!CO.goPublic || corp.public) return;
  if (did(() => ns.corporation.goPublic(CO.sharesToIssue))) {
    emitEvent(`[corp] Went public (issued ${CO.sharesToIssue} shares) - dividends can now be paid`, "corp");
  }
}

// ── Division scaffolding ─────────────────────────────────────────────────────

/**
 * Create the division itself, nothing more. Split out of the old ensureDivision
 * so founding the industry - the one purchase that turns a corp from "can never
 * earn" into "can earn" - happens before the API unlocks compete for the same
 * funds. Exact affordability, for the same reason as ensureApiUnlocks.
 */
function ensureIndustry(ns, div) {
  const c = ns.corporation;
  if (safe(() => c.getCorporation().divisions.includes(div.name))) return;

  const cost = safe(() => c.getIndustryData(div.industry).startingCost) ?? Infinity;
  if (!Number.isFinite(cost)) return;
  if (corpFunds(ns) < cost) {
    ns.print(`[corp] Saving for the ${div.name} division: $${ns.format.number(corpFunds(ns))} / $${ns.format.number(cost)} (${pctStr(corpFunds(ns), cost)})`);
    return;
  }
  if (did(() => c.expandIndustry(div.industry, div.name))) {
    emitEvent(`[corp] Founded the ${div.name} division (${div.industry}, $${ns.format.number(cost)})`, "corp");
  }
}

/**
 * Give the division a warehouse in every city it occupies, then expand into the
 * remaining cities. Occupied cities come FIRST on purpose: expandIndustry drops
 * the division into Sector-12 with a free office, and the old code walked
 * CO.cities in order - so a corp with only a few billion left bought an Aevum
 * office+warehouse and left its free HQ office with no warehouse at all, i.e. no
 * production. Both steps are affordability-gated now rather than blind-firing
 * into safe(), so a partial expansion is a deliberate stop rather than a
 * silently swallowed error.
 */
function ensureCities(ns, div) {
  const c = ns.corporation;
  const info = safe(() => c.getDivision(div.name));
  if (!info) return;

  // Both APIs or nothing. With Office API but not Warehouse API we'd happily pay
  // officeInitialCost per city and then be unable to buy a single warehouse -
  // offices that produce nothing, funded out of a stake we can't replace.
  for (const unlock of /** @type {any[]} */ (CO.apiUnlocks)) {
    if (!safe(() => c.hasUnlock(unlock))) return;
  }

  const constants = safe(() => c.getConstants());
  const warehouseCost = constants?.warehouseInitialCost ?? Infinity;
  const officeCost = constants?.officeInitialCost ?? Infinity;

  // 1. Warehouses where we already have an office (the HQ city's is free).
  for (const city of info.cities) {
    if (safe(() => c.getWarehouse(div.name, city))) continue;
    if (!affordable(ns, warehouseCost)) return;
    safe(() => c.purchaseWarehouse(div.name, /** @type {any} */ (city)));
  }

  // 2. New cities, office + warehouse together - an office without a warehouse
  //    produces nothing, so only expand when we can pay for both.
  // `info.cities` is a snapshot from the top of this function, so count as we go
  // rather than re-reading it - several cities can open in a single pass.
  let occupied = info.cities.length;
  for (const city of CITIES) {
    if (info.cities.includes(city)) continue;
    if (!affordable(ns, officeCost + warehouseCost)) return;
    if (!did(() => c.expandCity(div.name, city))) return;
    safe(() => c.purchaseWarehouse(div.name, city));
    occupied++;
    emitEvent(`[corp] ${div.name} opened in ${city} (${occupied}/${CITIES.length} cities)`, "corp");
  }
}

// ── Export routes ────────────────────────────────────────────────────────────

/**
 * Wire up the configured export routes once the "Export" unlock and both ends of
 * each route exist. exportMaterial is additive - calling it again stacks a
 * duplicate order - so we read the material's existing .exports and skip any
 * route that's already present. Each city exports to the same city in the target
 * division. exportMaterial/getMaterial are already used elsewhere in this file's
 * closure, so this adds no RAM beyond exportMaterial itself.
 * @param {NS} ns
 */
function ensureExports(ns, liveNames) {
  const c = ns.corporation;
  if (!safe(() => c.hasUnlock("Export"))) return;

  const divisions = safe(() => c.getCorporation().divisions) ?? [];

  for (const route of CO.exports) {
    // CO.exports names its endpoints by the CONFIG division names; translate to
    // whatever those divisions are actually called in this corp (see
    // resolveDivision - a hand-made division can be named anything).
    const from = liveNames[route.from] ?? route.from;
    const to = liveNames[route.to] ?? route.to;
    if (!divisions.includes(from) || !divisions.includes(to)) continue;

    for (const city of CITIES) {
      const mat = safe(() => c.getMaterial(from, city, /** @type {any} */ (route.material)));
      if (!mat) continue;
      const already = (mat.exports ?? []).some(e => e.division === to && e.city === city);
      if (already) continue;
      safe(() => c.exportMaterial(from, city, to, city, /** @type {any} */ (route.material), CO.exportAmount));
    }
  }
}

// ── Material division (Agriculture / Chemical) ───────────────────────────────

/**
 * Build a material division toward this round's targets: warehouses, offices
 * (Engineer-heavy from the product rounds, RP-heavy before that), Smart Supply,
 * material selling (with Market-TA.II once researched), boost materials, and
 * Advert (skipped for support divisions whose target advert is 0).
 *
 * With `apisOwned` false we're saving for an API unlock and run in austerity: the
 * only spending allowed is on input materials, because that's the one purchase
 * that raises revenue instead of consuming it. Selling and research still run -
 * they cost nothing. Note the office/warehouse calls would throw without the
 * unlocks anyway; skipping them is about not burning funds on the ones that
 * wouldn't, not about avoiding the exceptions.
 * @param {NS} ns @param {number} round @param {boolean} apisOwned
 */
function buildMaterialDivision(ns, div, target, round, apisOwned) {
  const c = ns.corporation;
  const info = safe(() => c.getDivision(div.name));
  if (!info) return;
  const industryData = safe(() => c.getIndustryData(div.industry));

  // Engineer-heavy "raw production" split from the product rounds; RP-building
  // split before that (guide: quality via RP early, via EngineerProduction later).
  const jobRatios = round < CO.materialProdRound ? CO.jobsMaterialGrow : CO.jobsMaterialProd;
  const hasTA2 = safe(() => c.hasResearched(div.name, /** @type {any} */ ("Market-TA.II")));

  for (const city of CITIES) {
    if (!safe(() => c.getWarehouse(div.name, city))) continue;

    if (apisOwned) {
      upgradeWarehouseTo(ns, div.name, city, target.warehouse);
      staffOffice(ns, div.name, city, target.office, jobRatios);
    }

    if (safe(() => c.hasUnlock("Smart Supply"))) {
      safe(() => c.setSmartSupply(div.name, city, true));
    } else {
      stockInputMaterials(ns, div.name, city, industryData);
    }

    // Sell everything this industry produces. With Market-TA.II the game auto-
    // prices for max profit; without it, MP is a safe default.
    for (const mat of industryData?.producedMaterials ?? /** @type {any[]} */ (CO.defaultProducedMaterials)) {
      safe(() => c.sellMaterial(div.name, city, mat, "MAX", "MP"));
      if (hasTA2) safe(() => c.setMaterialMarketTA2(div.name, city, mat, true));
    }

    buyBoostMaterials(ns, div.name, city, industryData);
  }

  if ((target.advert ?? 0) > 0) hireAdVertToLevel(ns, div.name, target.advert);
  manageResearch(ns, div.name);
}

// ── Product division (Tobacco) ───────────────────────────────────────────────

/**
 * Build the product division: warehouses, the design (main) office on a
 * "progress" split and the support offices on an R&D-heavy split, Smart Supply,
 * boost materials, and research. Advert for the product division is driven
 * aggressively by corp-steady (Wilson + Advert), not here.
 * @param {NS} ns @param {number} round
 */
function buildProductDivision(ns, div, round) {
  const c = ns.corporation;
  const info = safe(() => c.getDivision(div.name));
  if (!info) return;
  const industryData = safe(() => c.getIndustryData(div.industry));

  for (const city of CITIES) {
    if (!safe(() => c.getWarehouse(div.name, city))) continue;

    upgradeWarehouseTo(ns, div.name, city, CO.tobaccoTargets.warehouse);

    const isDesign = city === PRODUCT_CITY;
    const officeTarget = isDesign ? CO.tobaccoTargets.designOffice : CO.tobaccoTargets.supportOffice;
    const jobRatios = isDesign ? CO.jobsProductMain : CO.jobsProductSupport;
    staffOffice(ns, div.name, city, officeTarget, jobRatios);

    if (safe(() => c.hasUnlock("Smart Supply"))) {
      safe(() => c.setSmartSupply(div.name, city, true));
    } else {
      stockInputMaterials(ns, div.name, city, industryData);
    }

    buyBoostMaterials(ns, div.name, city, industryData);
  }

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
 * Keep the industry's INPUT materials stocked while we don't own Smart Supply.
 *
 * Production is min(stored / ratio) across requiredMaterials, so a division with
 * no Water in the warehouse produces literally nothing - which is how a corp that
 * couldn't afford the $25b Smart Supply unlock sat at $0 revenue forever and
 * never earned its way to the unlock. Inputs are cheap (a few dollars a unit),
 * so a small buffer costs almost nothing and is the difference between a dead
 * corp and a growing one. Once Smart Supply is bought the game does this for us
 * and this stops being called.
 *
 * Deliberately a bounded top-up via bulkPurchase rather than a buyMaterial rate:
 * it's instant, it's clamped by both funds and free warehouse space, and it can't
 * run away and choke the warehouse the output needs.
 * @param {NS} ns
 */
function stockInputMaterials(ns, divName, city, industryData) {
  const c = ns.corporation;
  const required = industryData?.requiredMaterials ?? {};
  const entries = Object.entries(required).filter(([, ratio]) => ratio > 0);
  if (!entries.length) return;

  const wh = safe(() => c.getWarehouse(divName, city));
  if (!wh) return;

  const totalRatio = entries.reduce((sum, [, ratio]) => sum + ratio, 0);
  // Inputs share the slice of the warehouse the boost materials don't reserve.
  const budgetSpace = wh.size * CO.inputWarehouseFraction;
  let freeSpace = wh.size - wh.sizeUsed;

  for (const [mat, ratio] of entries) {
    const size = MATERIAL_SIZE[mat];
    if (!size) continue; // unknown footprint - don't guess at warehouse space
    const target = Math.floor((budgetSpace * (ratio / totalRatio)) / size);
    const stored = safe(() => c.getMaterial(divName, city, /** @type {any} */ (mat)).stored) ?? 0;
    const shortfall = target - stored;
    // Same hysteresis as the boost materials: don't re-buy for a rounding error.
    if (shortfall <= target * CO.boostShortfallTolerance) continue;

    const qty = Math.min(shortfall, Math.floor(freeSpace / size));
    if (qty <= 0) continue;

    const price = safe(() => c.getMaterial(divName, city, /** @type {any} */ (mat)).marketPrice) ?? 0;
    if (price <= 0 || !affordable(ns, qty * price)) continue;

    safe(() => c.bulkPurchase(divName, city, /** @type {any} */ (mat), qty));
    freeSpace -= qty * size;
  }
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

/** Hire Advert toward a target level, one affordable step at a time. */
function hireAdVertToLevel(ns, divName, targetLevel) {
  const c = ns.corporation;
  for (let i = 0; i < CO.warehouseUpgradeSteps; i++) {
    const level = safe(() => c.getDivision(divName).numAdVerts) ?? 0;
    if (level >= targetLevel) return;
    const cost = safe(() => c.getHireAdVertCost(divName)) ?? Infinity;
    if (!affordable(ns, cost)) return;
    if (!did(() => c.hireAdVert(divName))) return;
  }
}

// ── Investment ───────────────────────────────────────────────────────────────

/**
 * Accept an investment offer once we're ready for the current round. Rounds 1-2
 * gate on Agriculture reaching the round's warehouse/office targets; rounds 3-4
 * gate on Tobacco having developed the required number of finished products (the
 * "1P/2P" cadence). All four rounds are farmed.
 * @param {NS} ns
 */
function manageInvestment(ns, round, agriName, agriTarget) {
  if (round > CO.investmentRounds) return;

  if (round <= 2) {
    if (!agricultureReady(ns, agriName, agriTarget) && !stalledOnGoodOffer(ns, agriName, agriTarget)) return;
  } else {
    const need = CO.productsBeforeRound[round] ?? 1;
    if (!tobaccoProductsReady(ns, need)) return;
  }

  if ((safe(() => ns.corporation.getCorporation().revenue) ?? 0) <= 0) return;
  // Read the offer BEFORE accepting - afterwards getInvestmentOffer describes the
  // next round, so the journal would report the wrong figure.
  const funds = safe(() => ns.corporation.getInvestmentOffer().funds) ?? 0;
  if (did(() => ns.corporation.acceptInvestmentOffer())) {
    emitEvent(`[corp] Accepted investment round ${round} (+$${ns.format.number(funds)})`, "corp");
  }
}

/**
 * True when the Agriculture buildout can't take another step it can afford AND
 * the standing offer would be transformative (investStallOfferMult x our funds).
 *
 * The agriTargets ladder assumes a BN3 seed-funded start. A self-funded $150b
 * corp that also had to buy Warehouse API + Office API can be several cities and
 * many warehouse levels short of round 1's targets with no way to close the gap
 * from its own revenue in any reasonable time - so gating purely on the targets
 * left it profitable-but-tiny forever. Taking a large early offer instead buys
 * the entire rest of the buildout. The multiple is what keeps this from being a
 * cheap sellout: a stalled corp with a trivial offer just keeps grinding.
 * @param {NS} ns
 */
function stalledOnGoodOffer(ns, agriName, target) {
  const funds = corpFunds(ns);
  const offer = safe(() => ns.corporation.getInvestmentOffer().funds) ?? 0;
  if (offer < funds * CO.investStallOfferMult) return false;
  return cheapestPendingStep(ns, agriName, target) > funds;
}

/**
 * Cost of the cheapest outstanding Agriculture buildout step (next warehouse
 * level, next office seats, or the next city's office+warehouse), or Infinity
 * when everything this round wanted is already built. Also published for
 * corp-steady, which holds off on corp-wide upgrades while structure is pending.
 * @param {NS} ns
 */
function cheapestPendingStep(ns, agriName, target) {
  const c = ns.corporation;
  const info = safe(() => c.getDivision(agriName));
  if (!info) return Infinity;

  let cheapest = Infinity;
  for (const city of info.cities) {
    const wh = safe(() => c.getWarehouse(agriName, /** @type {any} */ (city)));
    if (!wh) {
      cheapest = Math.min(cheapest, safe(() => c.getConstants().warehouseInitialCost) ?? Infinity);
    } else if (wh.level < target.warehouse) {
      cheapest = Math.min(cheapest, safe(() => c.getUpgradeWarehouseCost(agriName, /** @type {any} */ (city), 1)) ?? Infinity);
    }
    const office = safe(() => c.getOffice(agriName, /** @type {any} */ (city)));
    if (office && office.size < target.office) {
      cheapest = Math.min(cheapest, safe(() => c.getOfficeSizeUpgradeCost(agriName, /** @type {any} */ (city), 1)) ?? Infinity);
    }
  }

  const missingCities = CITIES.filter(city => !info.cities.includes(city));
  if (missingCities.length) {
    const k = safe(() => c.getConstants());
    cheapest = Math.min(cheapest, (k?.officeInitialCost ?? Infinity) + (k?.warehouseInitialCost ?? Infinity));
  }
  return cheapest;
}

/** True once every Agriculture city meets this round's warehouse+office targets. */
function agricultureReady(ns, agriName, target) {
  const c = ns.corporation;
  for (const city of CITIES) {
    const wh = safe(() => c.getWarehouse(agriName, city));
    const office = safe(() => c.getOffice(agriName, city));
    if (!wh || !office) return false;
    if (wh.level < target.warehouse) return false;
    if (office.size < target.office || office.numEmployees < office.size) return false;
  }
  return true;
}

/** True once Tobacco has at least `need` finished (100% developed) products. */
function tobaccoProductsReady(ns, need) {
  const c = ns.corporation;
  const name = resolveDivision(ns, TOBACCO).name;
  const info = safe(() => c.getDivision(name));
  if (!info) return false;
  let finished = 0;
  for (const p of info.products ?? []) {
    const d = safe(() => c.getProduct(name, PRODUCT_CITY, p));
    if (d && (d.developmentProgress ?? 0) >= 100) finished++;
  }
  return finished >= need;
}

// ── Logging (ns.print / ns.tprint are 0 RAM) ─────────────────────────────────

/**
 * One concise summary per build pass, printed to this script's own tail log.
 * Reuses getCorporation/getDivision/hasUnlock (all already called this pass), so
 * it costs no extra RAM.
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
    `valuation $${ns.format.number(corp.valuation ?? 0)}${corp.public ? " | public" : ""}`
  );

  for (const name of corp.divisions ?? []) {
    const d = safe(() => c.getDivision(name));
    if (!d) continue;
    const dp = (d.lastCycleRevenue ?? 0) - (d.lastCycleExpenses ?? 0);
    ns.print(
      `  ${name} [${d.industry}] profit $${ns.format.number(dp)}/s | ` +
      `research ${ns.format.number(d.researchPoints ?? 0)} | ` +
      `advert ${d.numAdVerts ?? 0} | products ${d.products?.length ?? 0}/${d.maxProducts ?? 0}`
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
