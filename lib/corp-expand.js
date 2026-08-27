// lib/corp-expand.js
//
// Build phase 1 of 4: everything that CREATES capacity - unlocks, divisions,
// cities, warehouses and their levels, export routes. A bounded one-shot: it makes
// one pass and exits, so its ~200GB is only borrowed. The daemon re-runs it in
// rotation with the other phases (see lib/corp-daemon.js), so the corp manager's
// peak footprint is one phase rather than one 490GB monolith.
//
// Everything here is a purchase that permanently enlarges the corp, which is why
// the ORDER in this file is load-bearing rather than cosmetic. A self-funded corp
// is founded with exactly $150b and its funds can NEVER be topped up from personal
// money, so spending them in the wrong order can brick it permanently:
//
//   1. the division itself - the only thing that can ever earn,
//   2. the two API unlocks the scripted buildout cannot function without,
//   3. warehouses in cities we already occupy, then new cities,
//   4. warehouse LEVELS, the manual's most important round-1/2 upgrade,
//   5. optional unlocks, dummy divisions and the tax unlocks, from surplus only.
//
// Unlocks used to be bought first, which on a node without SF3.3 (where Warehouse
// API + Office API cost real money) spent the entire stake before Agriculture's
// startingCost was ever considered - leaving a corp with no division, therefore no
// revenue, therefore permanently stuck.
//
// Divisions are matched by INDUSTRY, not by the name in CONFIG (see resolveDivision
// in lib/corp-lib.js), so a division created by hand in the Corporation UI under any
// name is adopted rather than ignored and then duplicated at full startingCost.

import { CONFIG } from "./config.js";
import { emitEvent } from "./events.js";
import { safe, did, corpFunds, affordable, resolveDivision, currentRound, pctStr, secondsToAfford, accumulateJournal, summariseCounts } from "./corp-lib.js";

const CO = CONFIG.corp;
const CITIES = /** @type {any[]} */ (CO.cities);

const AGRI = { name: CO.agriDivision.name, industry: /** @type {any} */ (CO.agriDivision.industry) };
const CHEM = { name: CO.chemicalDivision.name, industry: /** @type {any} */ (CO.chemicalDivision.industry) };
const TOBACCO = { name: CO.tobaccoDivision.name, industry: /** @type {any} */ (CO.tobaccoDivision.industry) };

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  if (!ns.corporation.hasCorporation()) return;
  try {
    pass(ns);
  } catch (e) {
    ns.print(`corp-expand error: ${String(e)}`);
  }
  // One-shot: exit so the RAM is only held transiently.
}

/** @param {NS} ns */
function pass(ns) {
  const c = ns.corporation;
  const round = currentRound();

  // Warehouse levels bought this pass, per division - batched into one journal
  // line below (raw, a long climb toward a target would emit every rotation).
  /** @type {Record<string, number>} */
  const built = {};
  const addBuilt = (divName, res) => {
    if (res.levels <= 0) return;
    built[`${divName} warehouse`] = (built[`${divName} warehouse`] ?? 0) + res.levels;
    built.$spend = (built.$spend ?? 0) + res.spend;
  };

  const agri = resolveDivision(ns, AGRI);
  ensureIndustry(ns, agri);
  ensureApiUnlocks(ns);

  // Austerity gate. While an API unlock is still unbought the corp is one purchase
  // away from being scriptable at all, and every other dollar spent delays it.
  const apisOwned = /** @type {any[]} */ (CO.apiUnlocks).every(u => safe(() => c.hasUnlock(u)) ?? false);

  // Found due divisions BEFORE any other spending. Chemical (round 2, the quality
  // loop) and Tobacco (round 3, the product engine) used to be founded LAST, after
  // warehouse levels and unlocks had already drained the surplus - so a corp whose
  // income was modest never accumulated the $70b/$20b startingCost and sat on
  // Agriculture forever while smaller purchases kept the balance pinned near the
  // 10% reserve. ensureIndustry checks raw funds, not affordable(): the founding
  // is exactly what the savings floor below protects.
  const chem = resolveDivision(ns, CHEM);
  const tobacco = resolveDivision(ns, TOBACCO);
  if (apisOwned) {
    if (round >= CO.chemicalStartRound) ensureIndustry(ns, chem);
    if (round >= CO.tobaccoStartRound) ensureIndustry(ns, tobacco);
  }
  const divisions = safe(() => c.getCorporation().divisions) ?? [];

  // Savings floor: while a due founding is still missing, publish its cost so
  // affordable() (lib/corp-lib.js) holds every discretionary spend - seats,
  // advert, warehouse and upgrade levels - until the founding money is banked.
  // The individual costs also feed cheapestPendingStep below, so a pending
  // founding keeps gordCorpExpandDone false and blocks round acceptance.
  const pendingFoundings = [];
  if (apisOwned) {
    if (round >= CO.chemicalStartRound && !divisions.includes(chem.name)) {
      pendingFoundings.push(foundingCost(ns, chem));
    }
    if (round >= CO.tobaccoStartRound && !divisions.includes(tobacco.name)) {
      pendingFoundings.push(foundingCost(ns, tobacco));
    }
  }
  // Save for the CHEAPEST pending founding, not the sum of them, and only while
  // it's actually within reach. Both halves matter, and the BN10 corp proved it:
  // at round 3 with Chemical AND Tobacco unfounded the old sum published a $90b
  // floor, which froze warehouse levels, city expansion, Advert and the optional
  // unlocks alike - against $452m of funds and +$7.4k/s of profit, i.e. 140 days
  // out. Only one founding can be bought at a time, so summing them made the
  // NEARER one ($20b Tobacco) unreachable too; and freezing the capacity that
  // grows profit is self-defeating when profit is the only thing that can ever
  // close the gap. Below the horizon we spend on capacity instead, which raises
  // profit, which brings the founding inside the horizon - then the floor engages
  // and banks it. See secondsToAfford in lib/corp-lib.js.
  const due = pendingFoundings.filter(Number.isFinite);
  const nextFounding = due.length ? Math.min(...due) : 0;
  const corpNow = safe(() => c.getCorporation());
  const wait = secondsToAfford(
    corpNow?.funds ?? 0,
    nextFounding,
    (corpNow?.revenue ?? 0) - (corpNow?.expenses ?? 0),
  );
  const savingFor = wait <= CO.savingHorizonSeconds ? nextFounding : 0;
  globalThis.gordCorpSavingFor = savingFor;
  if (nextFounding > 0 && !savingFor) {
    ns.print(`[corp] Founding ($${ns.format.number(nextFounding)}) is ${
      Number.isFinite(wait) ? `${(wait / 3600).toFixed(1)}h` : "forever"
    } away - growing capacity first instead of banking for it.`);
  }

  ensureCities(ns, agri);
  const agriTarget = CO.agriTargets[round] ?? CO.agriTargetsMax;

  // Warehouse levels vs. the optional unlocks (Smart Supply, Export), which
  // compete for the same money. warehousesToLevel climbs toward the ROUND TARGET
  // in one pass, buying while affordable() says yes, so whichever of the two runs
  // second gets whatever is left above the 10% reserve - which, on a target of
  // "17 across six cities", is nothing. Round 1 wants the levels first (the
  // manual's most important early upgrade, and $25b of a $150b founding stake is
  // most of the buildout). From round 2 the order flips: the investment has
  // landed, and this file's own config says Export is wanted at the START of
  // round 2 - it's what makes the Chemical quality loop possible - while running
  // second guaranteed it was bought last, if ever.
  const buildWarehouses = () => {
    if (apisOwned) addBuilt(agri.name, warehousesToLevel(ns, agri.name, agriTarget.warehouse));
  };
  const buyUnlocks = () => {
    if (apisOwned) ensureOptionalUnlocks(ns, round);
  };
  if (round >= CO.unlocksBeforeWarehousesRound) {
    buyUnlocks();
    buildWarehouses();
  } else {
    buildWarehouses();
    buyUnlocks();
  }

  // Build out divisions that exist (a hand-made one under any name counts - see
  // resolveDivision); founding itself already happened above.
  if (apisOwned && divisions.includes(chem.name)) {
    ensureCities(ns, chem);
    const chemTarget = CO.chemicalTargets[round] ?? CO.chemicalTargetsMax;
    addBuilt(chem.name, warehousesToLevel(ns, chem.name, chemTarget.warehouse));
  }

  if (apisOwned && divisions.includes(tobacco.name)) {
    ensureCities(ns, tobacco);
    addBuilt(tobacco.name, warehousesToLevel(ns, tobacco.name, CO.tobaccoTargets.warehouse));
  }

  ensureExports(ns, { [AGRI.name]: agri.name, [CHEM.name]: chem.name, [TOBACCO.name]: tobacco.name });

  if (apisOwned) {
    ensureDummyDivisions(ns, round);
    if (round > CO.investmentRounds) {
      ensureTaxUnlocks(ns);
      maybeExpandRealEstate(ns);
    }
  }

  // Handshakes. gordCorpExpandDone: corp-steady holds off on corp-wide upgrades
  // while capacity is pending - the two race for the same funds, and steady ticks
  // several times a second against this one-shot's once-per-rotation pass, so
  // steady wins - buying Smart Storage levels for a division with no warehouses to
  // store anything in. gordCorpCheapestStep: lib/corp-invest.js's stalled-corp
  // escape hatch needs "can the buildout afford its next step?", and it reads the
  // number from globalThis rather than importing this file - an import would pull
  // every 20GB action here into ITS RAM closure, undoing the whole phase split.
  // A pending division founding IS a buildout step - before this, the gate only
  // looked at Agriculture, so round 2 could be accepted with Chemical never
  // founded (and round 3 then deadlocks on a product from a Tobacco division
  // that doesn't exist).
  const cheapest = Math.min(
    cheapestPendingStep(ns, agri.name, agriTarget),
    ...pendingFoundings,
  );
  globalThis.gordCorpCheapestStep = cheapest;
  globalThis.gordCorpExpandDone = apisOwned
    && divisions.includes(agri.name)
    && !Number.isFinite(cheapest);

  // One batched journal line for this pass's warehouse levels, at most every
  // journal.buildMs (accumulates across passes while throttled).
  const rec = accumulateJournal("expandBuild", CO.journal.buildMs, built);
  if (rec) emitEvent(`[corp] Built: ${summariseCounts(ns, rec)}`, "corp");

  logSummary(ns, round);
}

// ── Unlocks ──────────────────────────────────────────────────────────────────

/**
 * Buy the two unlocks the scripted buildout physically needs - Warehouse API and
 * Office API, without which every getWarehouse / upgradeOfficeSize / hireEmployee
 * call throws. Free once you hold SF3.3; otherwise most of a self-funded founding
 * stake. Only ever called AFTER the first division exists, so it can never eat the
 * division's startingCost.
 *
 * Exact affordability rather than affordable(): a 10% operating reserve is
 * meaningless next to "the buildout cannot proceed at all without this".
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
 * startingCost of a division we have yet to found. Infinity when unreadable: the
 * savings target skips non-finite costs (no point freezing spending on a number
 * we don't have), but Infinity still flows into cheapestPendingStep, so
 * gordCorpExpandDone stays false and no round gets accepted on a bad read.
 * @param {NS} ns
 */
function foundingCost(ns, div) {
  return safe(() => ns.corporation.getIndustryData(div.industry).startingCost) ?? Infinity;
}

/**
 * Buy the nice-to-have unlocks out of surplus, once earning and past each unlock's
 * minimum round. Export is the important one and the manual wants it at the START
 * of round 2 - it's what makes the Chemical quality loop possible at all. Smart
 * Supply hands input purchasing back to the game (lib/corp-market.js covers us
 * until then); at $25b it's a big slice of round 1, which is why it waits.
 * @param {NS} ns @param {number} round
 */
function ensureOptionalUnlocks(ns, round) {
  const c = ns.corporation;
  if ((safe(() => c.getCorporation().revenue) ?? 0) <= 0) return;

  for (const unlock of /** @type {any[]} */ (CO.optionalUnlocks)) {
    if (round < (CO.optionalUnlockRound[unlock] ?? 1)) continue;
    if (safe(() => c.hasUnlock(unlock))) continue;
    const cost = safe(() => c.getUnlockCost(unlock)) ?? Infinity;
    if (!affordable(ns, cost)) continue;
    if (did(() => c.purchaseUnlock(unlock))) {
      emitEvent(`[corp] Unlocked ${unlock} ($${ns.format.number(cost)})`, "corp");
    }
  }
}

/**
 * Buy the dividend-tax unlocks once affordable, cheapest-first. DividendTax is
 * (1 - CorporationSoftcap + 0.15); Shady Accounting takes 0.05 off it and
 * Government Partnership 0.1, which also grants the "Lobbying is great!"
 * achievement. Worth relatively more in penalised BitNodes, where the softcap makes
 * the base tax higher.
 * @param {NS} ns
 */
function ensureTaxUnlocks(ns) {
  const c = ns.corporation;
  for (const unlock of /** @type {any[]} */ (CO.taxUnlocks)) {
    if (safe(() => c.hasUnlock(unlock))) continue;

    const cost = safe(() => c.getUnlockCost(unlock)) ?? Infinity;
    if (affordable(ns, cost)) {
      if (did(() => c.purchaseUnlock(unlock))) {
        // ASCII only - the journal tail does not decode UTF-8.
        const ach = unlock === CO.lobbyingUnlock ? ' - "Lobbying is great!" achievement' : "";
        emitEvent(`[corp] Unlocked ${unlock}, lower dividend tax${ach}`, "corp");
      }
    } else {
      const ach = unlock === CO.lobbyingUnlock ? ' ("Lobbying is great!" achievement)' : "";
      ns.print(`[corp] Targeting ${unlock}${ach}: $${ns.format.number(corpFunds(ns))} / $${ns.format.number(cost)} (${pctStr(corpFunds(ns), cost)})`);
    }
    // Cheapest-first only: stop at the first unowned unlock so Government
    // Partnership's huge cost never hides progress on Shady Accounting.
    break;
  }
}

// ── Divisions ────────────────────────────────────────────────────────────────

/**
 * Create the division itself, nothing more. Split from the city/warehouse work so
 * founding the industry - the one purchase that turns a corp from "can never earn"
 * into "can earn" - happens before anything else competes for the same funds.
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
 * remaining cities.
 *
 * Occupied cities come FIRST on purpose: expandIndustry drops the division into
 * Sector-12 with a free office, and walking CO.cities in order instead meant a corp
 * with a few billion left bought an Aevum office+warehouse while its free HQ office
 * still had no warehouse at all - i.e. no production.
 */
function ensureCities(ns, div) {
  const c = ns.corporation;
  const info = safe(() => c.getDivision(div.name));
  if (!info) return;

  // Both APIs or nothing. With Office API but not Warehouse API we'd pay
  // officeInitialCost per city and then be unable to buy a single warehouse.
  for (const unlock of /** @type {any[]} */ (CO.apiUnlocks)) {
    if (!safe(() => c.hasUnlock(unlock))) return;
  }

  const constants = safe(() => c.getConstants());
  const warehouseCost = constants?.warehouseInitialCost ?? Infinity;
  const officeCost = constants?.officeInitialCost ?? Infinity;

  for (const city of info.cities) {
    if (safe(() => c.getWarehouse(div.name, city))) continue;
    if (!affordable(ns, warehouseCost)) return;
    safe(() => c.purchaseWarehouse(div.name, /** @type {any} */ (city)));
  }

  // An office without a warehouse produces nothing, so only expand when we can pay
  // for both. info.cities is a snapshot, so count as we go.
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

/**
 * Dummy divisions: pure valuation inflation, and the cheapest offer boost there is.
 *
 * Valuation carries NumberOfOfficesAndWarehouses as an EXPONENT:
 *   Valuation = (1e10 + Funds/3 + AssetDelta*315000) * (1.1^(1/12))^officesAndWarehouses
 * so a division sitting in all 6 cities with 6 warehouses adds 12 to that exponent -
 * multiplying valuation, and therefore the investment offer, by 1.1^(12/12) = ~1.1x.
 * For a flat $10b Restaurant industry and nothing else, that is an extremely good
 * trade in rounds 3-4 where offers are measured in quadrillions.
 *
 * They are deliberately never developed past 6 cities + 6 warehouses - no office,
 * advert or warehouse upgrades - because none of that affects the exponent.
 * @param {NS} ns @param {number} round
 */
function ensureDummyDivisions(ns, round) {
  const D = CO.dummy;
  if (!D.enabled || round < D.fromRound) return;

  const c = ns.corporation;
  const constants = safe(() => c.getConstants());
  const warehouseCost = constants?.warehouseInitialCost ?? Infinity;
  const officeCost = constants?.officeInitialCost ?? Infinity;
  const startCost = safe(() => c.getIndustryData(/** @type {any} */ (D.industry)).startingCost) ?? Infinity;

  // Strictly surplus: these earn nothing, so they must never compete with the
  // product division for funds.
  const budget = corpFunds(ns) * D.maxSpendFraction;

  for (let i = 0; i < D.count; i++) {
    const name = `${D.namePrefix}${i}`;
    const divisions = safe(() => c.getCorporation().divisions) ?? [];

    if (!divisions.includes(name)) {
      // A full dummy costs the industry plus 5 more offices and 6 warehouses.
      const fullCost = startCost + 5 * (officeCost + warehouseCost) + warehouseCost;
      if (fullCost > budget || !affordable(ns, fullCost)) return;
      if (!did(() => c.expandIndustry(/** @type {any} */ (D.industry), name))) return;
      emitEvent(`[corp] Founded dummy division ${name} (${D.industry}) to raise the investment offer`, "corp");
    }
    // Reuse the real city/warehouse logic - a dummy wants exactly the same 6+6.
    ensureCities(ns, { name, industry: /** @type {any} */ (D.industry) });
  }
}

/**
 * Expand into Real Estate exactly once, purely for the "Own the land" achievement
 * (any division with that industry). Deliberately not built out.
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

// ── Warehouses ───────────────────────────────────────────────────────────────

/**
 * Raise every city's warehouse to `targetLevel`, one affordable step at a time,
 * always growing the LOWEST-level city first. Iterating cities in config order
 * instead meant the money ran out after maxing the first city or two - a real
 * corp ended up with Aevum at level 20 while Sector-12 sat at 4, and the division
 * production multiplier is a PRODUCT over per-warehouse terms, so balanced
 * warehouses beat one tall one. Warehouse level is, with Smart Storage, the
 * manual's most important upgrade in rounds 1-2: storage caps how much boost
 * material a city can hold, and boost materials are what multiply production.
 * Returns what it bought so pass() can batch the journal line.
 * @returns {{levels: number, spend: number}}
 */
function warehousesToLevel(ns, divName, targetLevel) {
  const c = ns.corporation;
  let levels = 0;
  let spend = 0;
  for (let i = 0; i < CO.warehouseUpgradeSteps; i++) {
    let lowest = null;
    let lowestLevel = Infinity;
    for (const city of CITIES) {
      const wh = safe(() => c.getWarehouse(divName, city));
      if (wh && wh.level < targetLevel && wh.level < lowestLevel) {
        lowestLevel = wh.level;
        lowest = city;
      }
    }
    if (lowest === null) break; // every warehouse at target (or absent)
    const cost = safe(() => c.getUpgradeWarehouseCost(divName, lowest, 1)) ?? Infinity;
    if (!affordable(ns, cost)) break;
    if (!did(() => c.upgradeWarehouse(divName, lowest, 1))) break;
    levels++;
    spend += cost;
  }
  return { levels, spend };
}

// ── Export routes ────────────────────────────────────────────────────────────

/**
 * Wire up the configured export routes once "Export" and both ends exist.
 *
 * exportMaterial is ADDITIVE - calling it again stacks a duplicate order - so we
 * read the material's existing .exports and skip routes already present at the
 * configured amount; a route with a STALE amount (an older config's string) is
 * cancelled and re-created rather than left drip-feeding forever. Route order
 * matters and CO.exports encodes it: Tobacco is listed before Chemical so the
 * product division draws Plants first, because export is FIFO.
 * @param {NS} ns
 */
function ensureExports(ns, liveNames) {
  const c = ns.corporation;
  if (!safe(() => c.hasUnlock("Export"))) return;

  const divisions = safe(() => c.getCorporation().divisions) ?? [];

  for (const route of CO.exports) {
    const from = liveNames[route.from] ?? route.from;
    const to = liveNames[route.to] ?? route.to;
    if (!divisions.includes(from) || !divisions.includes(to)) continue;

    for (const city of CITIES) {
      const mat = safe(() => c.getMaterial(from, city, /** @type {any} */ (route.material)));
      if (!mat) continue;
      const existing = (mat.exports ?? []).find(e => e.division === to && e.city === city);
      if (existing && String(existing.amount) === CO.exportAmount) continue;
      if (existing) safe(() => c.cancelExportMaterial(from, city, to, city, /** @type {any} */ (route.material)));
      safe(() => c.exportMaterial(from, city, to, city, /** @type {any} */ (route.material), CO.exportAmount));
    }
  }
}

// ── Readiness ────────────────────────────────────────────────────────────────

/**
 * Cost of the cheapest outstanding Agriculture capacity step (next warehouse level,
 * or the next city's office+warehouse), or Infinity when this round's targets are
 * met. Published as gordCorpCheapestStep (see pass) - NOT exported, so no other
 * corp script is tempted to import it and inherit this file's RAM closure.
 *
 * Office SIZE is deliberately not considered here - that belongs to
 * lib/corp-office.js, which publishes its own readiness flag.
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
  }

  if (CITIES.some(city => !info.cities.includes(city))) {
    const k = safe(() => c.getConstants());
    cheapest = Math.min(cheapest, (k?.officeInitialCost ?? Infinity) + (k?.warehouseInitialCost ?? Infinity));
  }
  return cheapest;
}

/** @param {NS} ns @param {number} round */
function logSummary(ns, round) {
  const c = ns.corporation;
  const corp = safe(() => c.getCorporation());
  if (!corp) return;
  ns.print(
    `[corp-expand] round ${round} | funds $${ns.format.number(corp.funds ?? 0)} | ` +
    `divisions ${(corp.divisions ?? []).length} | capacity ${globalThis.gordCorpExpandDone ? "built" : "pending"}`
  );
}
