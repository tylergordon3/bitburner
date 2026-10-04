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
import { safe, did, corpFunds, affordable, resolveDivision, currentRound, roundKnown, offerHoldActive, pctStr, secondsToAfford, accumulateJournal, summariseCounts } from "./corp-lib.js";

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
  // No round published yet (first rotation after a reload): skip the pass rather
  // than build against the round-1 default - see roundKnown. corp-invest runs
  // first in the rotation, so this costs a brand-new corp one daemon tick.
  if (!roundKnown()) {
    ns.print("[corp-expand] waiting for corp-invest to publish the round");
    return;
  }
  const round = currentRound();

  // A ready round is being held for its offer to settle (lib/corp-invest.js):
  // buy NOTHING this pass. Every purchase here is capacity, i.e. money turned
  // into something the valuation doesn't count at cost - the cycle it lands in
  // contributes no AssetDelta to the 10-cycle mean being sold. The pass still
  // runs to the end, because the handshakes it publishes (gordCorpExpandDone,
  // gordCorpCheapestStep) are what corp-invest re-checks readiness against.
  const buying = !offerHoldActive();

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
  if (buying) {
    ensureIndustry(ns, agri);
    ensureApiUnlocks(ns);
  }

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
  if (apisOwned && buying) {
    if (round >= CO.chemicalStartRound) ensureIndustry(ns, chem);
    if (round >= CO.tobaccoStartRound) ensureIndustry(ns, tobacco);
  }
  const divisions = safe(() => c.getCorporation().divisions) ?? [];

  // Foundings that are DUE but unbought. They feed the objective below, and their
  // individual costs also feed cheapestPendingStep, so a pending founding keeps
  // gordCorpExpandDone false and blocks round acceptance.
  const pendingFoundings = [];
  if (apisOwned) {
    if (round >= CO.chemicalStartRound && !divisions.includes(chem.name)) {
      pendingFoundings.push(foundingCost(ns, chem));
    }
    if (round >= CO.tobaccoStartRound && !divisions.includes(tobacco.name)) {
      pendingFoundings.push(foundingCost(ns, tobacco));
    }
  }
  // ── The single buildout OBJECTIVE ───────────────────────────────────────────
  // The corp banks for exactly ONE thing at a time and nothing cheaper may be
  // bought while it's pending. That rule is the whole point: every spender here
  // and in lib/corp-office.js is affordability-gated and spends down to the 10%
  // reserve each pass, so the CHEAPEST pending purchase always wins - and a lump
  // dearer than it is unreachable at ANY income. The BN10 corp is the proof: at
  // round 3, earning steadily, it sat at 2 of 6 cities with offices of 3 and 4
  // and Advert 1 - round-3 targets of 6, 9 and 10 - because a $1.145b warehouse
  // level was always affordable first and a ~$9b city never was. No proportional
  // rule fixes this: any share-of-surplus just parks funds at a multiple of the
  // cheapest purchase and buys that instead.
  //
  // Priority is breadth before depth - this file's documented order and the
  // manual's round-1 plan (all six cities, THEN warehouse level 4 and office 4):
  // the founding that gates the round, then a city.
  //
  // But an objective is only worth banking for if we can GET there: freezing the
  // buildout for a target months away is the deadlock this whole file has now hit
  // twice, once on a $90b founding and once, a fix later, on a $9b city that was
  // 9 days out at $7.4k/s while a $1.145b warehouse level sat affordable and
  // unbought. So each candidate must fall inside savingHorizonSeconds at the
  // current profit rate. When none does we buy the cheap things after all - which
  // raises profit, which pulls the objective inside the horizon, which is the only
  // route to it that exists. Same principle as the boost gate and the stall
  // rescue: a target you cannot reach is not a target.
  const due = pendingFoundings.filter(Number.isFinite);
  const corpNow = safe(() => c.getCorporation());
  const funds = corpNow?.funds ?? 0;
  const profit = (corpNow?.revenue ?? 0) - (corpNow?.expenses ?? 0);

  // Cheapest founding, never the sum: only one can be bought at a time, so the old
  // sum published a $90b floor at round 3 with Chemical AND Tobacco outstanding -
  // making the nearer one ($20b Tobacco) unreachable along with everything else.
  //
  // The PRODUCT division's next city outranks Agriculture's, and that ordering is
  // the manual's, not a preference: from round 3 it wants ">= 90%" of funds in the
  // product division and corporation upgrades, and "only a small amount of funds
  // for support divisions" (150b/30b of an 11t round-3 start). Before this,
  // Tobacco's city step wasn't a candidate at ALL - only Agriculture's was - so
  // nothing ever banked for it and its $9b lost every race to a $3.6b Agriculture
  // warehouse level, to Advert (20% of funds a cycle) and to Wilson. That is how
  // the BN3 corp sat at Tobacco 1/6 cities through the whole of round 3.
  const hasTobacco = apisOwned && divisions.includes(tobacco.name);
  // 0 when the division holds all six cities with warehouses, i.e. nothing pending.
  // Read once: it feeds both the objective and the cheapest-step handshake below.
  const tobaccoCity = hasTobacco ? pendingCityCost(ns, tobacco) : 0;
  const candidates = [
    { kind: "founding", label: "a division founding", cost: due.length ? Math.min(...due) : 0 },
    { kind: "productCity", label: `${tobacco.name}'s next city`, cost: tobaccoCity },
    { kind: "city", label: `${agri.name}'s next city`, cost: apisOwned ? pendingCityCost(ns, agri) : 0 },
  ].filter(o => o.cost > 0);

  const objective = chooseObjective(candidates, funds, profit, CO.savingHorizonSeconds);
  globalThis.gordCorpSavingFor = objective?.cost ?? 0;
  globalThis.gordCorpObjective = objective?.label ?? null;

  if (candidates.length && !objective) {
    const nearest = candidates[candidates.length - 1];
    const eta = secondsToAfford(funds, nearest.cost, profit);
    ns.print(`[corp] ${nearest.label} ($${ns.format.number(nearest.cost)}) is ${
      Number.isFinite(eta) ? `${(eta / 3600).toFixed(1)}h` : "forever"
    } away - growing capacity first instead of banking for it.`);
  }

  // Cities spend the money they are the objective FOR, so they ignore the floor -
  // but only when they ARE it. Behind a founding they queue like everything else.
  if (buying) ensureCities(ns, agri, /* isObjective */ objective?.kind === "city");
  const agriTarget = CO.agriTargets[round] ?? CO.agriTargetsMax;

  // Rounds 1-2: Agriculture's warehouse climb leaves the offices' money alone -
  // see warehouseClimbFloor.
  const officeFloor = warehouseClimbFloor(
    globalThis.gordCorpOfficeNeed, round, Date.now(), CO,
  );

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
    if (apisOwned && buying) {
      addBuilt(agri.name, warehousesToLevel(ns, agri.name, agriTarget.warehouse, officeFloor));
    }
  };
  const buyUnlocks = () => {
    if (apisOwned && buying) ensureOptionalUnlocks(ns, round);
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
  if (apisOwned && buying && divisions.includes(chem.name)) {
    ensureCities(ns, chem);
    const chemTarget = CO.chemicalTargets[round] ?? CO.chemicalTargetsMax;
    addBuilt(chem.name, warehousesToLevel(ns, chem.name, chemTarget.warehouse));
  }

  if (hasTobacco && buying) {
    // Spends the money banked for it when it IS the objective - same exemption
    // Agriculture's city step gets above, and for the same reason.
    ensureCities(ns, tobacco, /* isObjective */ objective?.kind === "productCity");
    addBuilt(tobacco.name, warehousesToLevel(ns, tobacco.name, CO.tobaccoTargets.warehouse));
  }

  // Export routes cost nothing, so they are wired up hold or no hold.
  ensureExports(ns, { [AGRI.name]: agri.name, [CHEM.name]: chem.name, [TOBACCO.name]: tobacco.name });

  if (apisOwned && buying) {
    ensureDummyDivisions(ns, round);
    if (round > CO.investmentRounds) {
      ensureTaxUnlocks(ns);
      maybeExpandRealEstate(ns);
    }
  }

  // Re-publish the objective from what the corp looks like NOW. The figure above
  // was taken before this pass spent anything, and the money banked behind it is
  // a floor under every other spender in the corp (affordable() in corp-office,
  // corp-market and the always-on corp-steady) until the next pass here, a full
  // rotation away. So a pass that BOUGHT its objective - the last city, say -
  // used to leave a $9b floor standing for a minute under nothing at all. Same
  // reads as above, so no RAM; skipped while holding, when nothing was bought
  // and so nothing changed.
  const tobaccoCityNow = buying && hasTobacco ? pendingCityCost(ns, tobacco) : tobaccoCity;
  if (buying) {
    const after = safe(() => c.getCorporation());
    const objectiveNow = chooseObjective(
      [
        { kind: "founding", label: "a division founding", cost: due.length ? Math.min(...due) : 0 },
        { kind: "productCity", label: `${tobacco.name}'s next city`, cost: tobaccoCityNow },
        { kind: "city", label: `${agri.name}'s next city`, cost: apisOwned ? pendingCityCost(ns, agri) : 0 },
      ],
      after?.funds ?? 0,
      (after?.revenue ?? 0) - (after?.expenses ?? 0),
      CO.savingHorizonSeconds,
    );
    globalThis.gordCorpSavingFor = objectiveNow?.cost ?? 0;
    globalThis.gordCorpObjective = objectiveNow?.label ?? null;
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
  //
  // The two therefore measure DIFFERENT things and are computed from different
  // sets:
  //
  // gordCorpCheapestStep answers "is there a buildout step outstanding at all?"
  // for lib/corp-invest.js's rescue, and the product division's next city is very
  // much one. Leaving it out meant that once Agriculture hit its round target the
  // rescue read Infinity - "nothing pending, this is just a mid-cycle dip" - for a
  // corp frozen at Tobacco 1/6 cities with no product and no way to get one.
  // pendingCityCost returns 0 when a division holds all six with warehouses, which
  // is "nothing pending", not "free".
  //
  // gordCorpExpandDone stays on the SUPPORT-side steps (Agriculture + foundings)
  // because its consumer is corp-steady's corp-wide upgrade spending, and the
  // manual wants those bought throughout round 3 (employeeStatUpgrades alone are
  // 8/23 of the round's budget). Tobacco's city expansion doesn't need them
  // switched off - it's the current OBJECTIVE, so affordable() already makes every
  // upgrade queue behind the money banked for it.
  const supportCheapest = Math.min(
    cheapestPendingStep(ns, agri.name, agriTarget),
    ...pendingFoundings,
  );
  globalThis.gordCorpCheapestStep = Math.min(
    supportCheapest,
    tobaccoCityNow > 0 ? tobaccoCityNow : Infinity,
  );
  globalThis.gordCorpExpandDone = apisOwned
    && divisions.includes(agri.name)
    && !Number.isFinite(supportCheapest);

  // One batched journal line for this pass's warehouse levels, at most every
  // journal.buildMs (accumulates across passes while throttled).
  const rec = accumulateJournal("expandBuild", CO.journal.buildMs, built);
  if (rec) emitEvent(`[corp] Built: ${summariseCounts(ns, rec)}`, "corp");

  logSummary(ns, round);
}

// ── The objective, and the office floor ──────────────────────────────────────

/**
 * The one lump the corp banks for: the FIRST candidate (they arrive in priority
 * order) the corp can actually reach inside `horizon` corp-seconds at its
 * current profit, or null when none is - see the long comment in pass().
 * Candidates with nothing pending (cost 0) are skipped. Pure - exported for the
 * tests.
 * @template {{cost: number}} T
 * @param {T[]} candidates @param {number} funds @param {number} profit
 * @param {number} horizon @returns {T | null}
 */
export function chooseObjective(candidates, funds, profit, horizon) {
  return candidates.find(
    o => o.cost > 0 && secondsToAfford(funds, o.cost, profit) <= horizon,
  ) ?? null;
}

/**
 * Extra money Agriculture's warehouse climb must leave untouched: what the
 * material divisions' OFFICES still need this round (seats and Advert to the
 * round target), as published by lib/corp-office.js in gordCorpOfficeNeed.
 *
 * This is the round-2 spend order. The manual's is Export, office 8, Chemical,
 * Advert 8, and only THEN Smart Storage / Factories / warehouse levels with what
 * is left. Ours was whatever the rotation happened to produce: this phase runs
 * before corp-office and climbs toward warehouse 17 - ~$169b across six cities -
 * down to the reserve in a single pass, so on anything short of a full-size
 * round the $36b of seats and $8b of Advert were simply never affordable, and
 * with offices short gordCorpOfficeDone stayed false, which also locks
 * corp-steady out of Smart Storage / Factories. Seats are the cheaper purchase
 * AND the earlier one; they just ran second.
 *
 *   - past officeBeforeWarehouseRound: 0 - support divisions are a side budget
 *     from round 3, and the product division's needs are the objective's job;
 *   - no figure for THIS round yet (corp-office hasn't had its slot since the
 *     round changed - it runs right after this phase): Infinity, i.e. don't
 *     climb this pass. Without that, the pass straight after a round lands
 *     would spend the whole round before corp-office could ask for any of it;
 *   - a figure nobody has refreshed in officeNeedStaleMs: 0, whatever round it
 *     is for. corp-office has stopped being placed, and a floor from a phase
 *     that isn't running must not be allowed to freeze this one.
 * Pure - exported for the tests.
 * @param {{round: number, cost: number, at: number} | undefined | null} need
 * @param {number} round @param {number} now
 * @param {{officeBeforeWarehouseRound: number, officeNeedStaleMs: number}} cfg
 */
export function warehouseClimbFloor(need, round, now, cfg) {
  if (round > cfg.officeBeforeWarehouseRound) return 0;
  if (!need) return Infinity;
  if (!(now - need.at < cfg.officeNeedStaleMs)) return 0;
  if (need.round !== round) return Infinity;
  return need.cost > 0 ? need.cost : 0;
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
 * The order to try the optional unlocks in this round: the latest per-round
 * override at or before `round` (CONFIG.corp.optionalUnlockOrder), else the base
 * list. Order is the whole point - each purchase spends toward the reserve, so on
 * a tight budget only the first one lands. Pure - exported for the tests.
 * @param {number} round @returns {string[]}
 */
export function optionalUnlockOrder(round) {
  const byRound = CO.optionalUnlockOrder ?? {};
  let best = -Infinity;
  for (const key of Object.keys(byRound)) {
    const r = Number(key);
    if (r <= round && r > best) best = r;
  }
  return Number.isFinite(best) ? byRound[best] : CO.optionalUnlocks;
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

  for (const unlock of /** @type {any[]} */ (optionalUnlockOrder(round))) {
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
function ensureCities(ns, div, isObjective = false) {
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
    if (!affordable(ns, warehouseCost, isObjective)) return;
    safe(() => c.purchaseWarehouse(div.name, /** @type {any} */ (city)));
  }

  // An office without a warehouse produces nothing, so only expand when we can pay
  // for both. info.cities is a snapshot, so count as we go.
  let occupied = info.cities.length;
  for (const city of CITIES) {
    if (info.cities.includes(city)) continue;
    if (!affordable(ns, officeCost + warehouseCost, isObjective)) return;
    if (!did(() => c.expandCity(div.name, city))) return;
    safe(() => c.purchaseWarehouse(div.name, city));
    occupied++;
    emitEvent(`[corp] ${div.name} opened in ${city} (${occupied}/${CITIES.length} cities)`, "corp");
  }
}

/**
 * Cost of a division's next CITY step - a warehouse for a city it occupies but
 * hasn't warehoused, otherwise the office+warehouse pair for a city it hasn't
 * entered - or 0 when it already holds all six with warehouses.
 *
 * This is the number the objective banks for, and it is deliberately the whole
 * indivisible lump: expandCity without the warehouse buys an office that produces
 * nothing, so a partial save is worse than none. Reads exactly what ensureCities
 * reads, so it adds no RAM to this phase.
 * Exported for tests only.
 * @param {NS} ns @returns {number}
 */
export function pendingCityCost(ns, div) {
  const c = ns.corporation;
  const info = safe(() => c.getDivision(div.name));
  if (!info) return 0;

  const k = safe(() => c.getConstants());
  const warehouseCost = k?.warehouseInitialCost ?? Infinity;
  const officeCost = k?.officeInitialCost ?? Infinity;
  // An unreadable constant must not become the objective: publishing Infinity as
  // the savings floor would freeze every discretionary spend in the corp.
  if (!Number.isFinite(warehouseCost) || !Number.isFinite(officeCost)) return 0;

  for (const city of info.cities) {
    if (!safe(() => c.getWarehouse(div.name, /** @type {any} */ (city)))) return warehouseCost;
  }
  if (CITIES.some(city => !info.cities.includes(city))) return officeCost + warehouseCost;
  return 0;
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
      // A full dummy costs the industry plus 5 more offices and 5 more
      // warehouses: founding a division already drops an office AND a warehouse
      // into Sector-12 (Division's constructor), so the sixth of each is free.
      const fullCost = startCost + 5 * (officeCost + warehouseCost);
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
 *
 * `floor` is extra money each level must leave untouched on top of the usual
 * reserve and objective (see warehouseClimbFloor); Infinity means "not this
 * pass", which affordable() already answers false to.
 * @returns {{levels: number, spend: number}}
 */
function warehousesToLevel(ns, divName, targetLevel, floor = 0) {
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
    if (!affordable(ns, cost + floor)) break;
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
 * product division draws Plants first, because export is FIFO - and exportPlan
 * is what makes the GAME's order match the config's, not just the route set.
 * @param {NS} ns
 */
function ensureExports(ns, liveNames) {
  const c = ns.corporation;
  if (!safe(() => c.hasUnlock("Export"))) return;

  const divisions = safe(() => c.getCorporation().divisions) ?? [];

  // One source (division, material) at a time, with ALL its routes together:
  // the order between them is the thing being managed.
  const sources = new Map();
  for (const route of CO.exports) {
    const key = `${route.from}|${route.material}`;
    if (!sources.has(key)) sources.set(key, { from: route.from, material: route.material, to: [] });
    sources.get(key).to.push(route.to);
  }

  for (const src of sources.values()) {
    const from = liveNames[src.from] ?? src.from;
    if (!divisions.includes(from)) continue;
    const targets = src.to.map(t => liveNames[t] ?? t).filter(t => divisions.includes(t));
    if (!targets.length) continue;

    for (const city of CITIES) {
      const mat = safe(() => c.getMaterial(from, city, /** @type {any} */ (src.material)));
      if (!mat) continue;
      // Only targets that can actually receive here: exportMaterial throws for a
      // city the importer has no warehouse in, and a route that can never be
      // created must not count as "missing" (it would re-plan every pass).
      const wanted = targets
        .filter(to => safe(() => c.getWarehouse(to, city)))
        .map(to => ({ division: to, city }));
      const plan = exportPlan(mat.exports ?? [], wanted, CO.exportAmount);
      for (const r of plan.cancel) {
        safe(() => c.cancelExportMaterial(from, city, r.division, r.city, /** @type {any} */ (src.material)));
      }
      for (const r of plan.add) {
        safe(() => c.exportMaterial(from, city, r.division, r.city, /** @type {any} */ (src.material), CO.exportAmount));
      }
    }
  }
}

/**
 * What to cancel and what to (re)create so that one material's export routes to
 * `wanted` exist, at `amount`, IN THAT ORDER. Pure - exported for the tests.
 *
 * Exports are served first-come-first-served in the order they were CREATED,
 * and that order is not the config's: Chemical is founded in round 2 and
 * Tobacco in round 3, so adding only the missing route - what this used to do -
 * left Chemical permanently ahead of the product division for Agriculture's
 * Plants, the reverse of what CO.exports asks for (and of the manual: "prioritize
 * Tobacco over Chemical ... export route is FIFO"). The game has no reorder, so
 * the fix is the manual's own: cancel and re-add in the right order.
 *
 * Nothing is touched when the routes we manage are already right, and a route
 * that merely needs APPENDING (the wanted order's tail) is just added. Routes to
 * anything not in `wanted` - set up by hand - are left exactly as they are.
 * @param {{division: string, city: string, amount: any}[]} existing - the
 *   material's current exports, in the game's order
 * @param {{division: string, city: string}[]} wanted - in priority order
 * @param {string} amount
 * @returns {{cancel: {division: string, city: string}[], add: {division: string, city: string}[]}}
 */
export function exportPlan(existing, wanted, amount) {
  const same = (a, b) => a.division === b.division && a.city === b.city;
  const ours = existing.filter(e => wanted.some(w => same(e, w)));

  // Already a correct, in-order prefix of what we want? Then append the rest.
  const prefixOk = ours.length <= wanted.length
    && ours.every((e, i) => same(e, wanted[i]) && String(e.amount) === amount);
  if (prefixOk) return { cancel: [], add: wanted.slice(ours.length) };

  // Wrong order or a stale amount somewhere: rebuild the managed set in order.
  return { cancel: ours.map(e => ({ division: e.division, city: e.city })), add: [...wanted] };
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
 *
 * The office floor on the warehouse climb (warehouseClimbFloor) is deliberately
 * NOT priced in here: this is the bare price of the next step. With the floor
 * added, a corp that is steadily buying seats would read as "next step $45b
 * away" and trip the rescue in lib/corp-invest.js, which sells the round on the
 * spot. The bare price keeps the hatches where they were; and a floored climb
 * can't strand the corp, because funds don't stand still - they rise until a
 * seat is affordable (and the floor shrinks), or fall until the level isn't
 * (and the hatches see a step out of reach, exactly as before).
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
