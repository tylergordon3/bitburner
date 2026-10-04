// tools/corp-status.js
//
// One-shot corporation diagnostic: what the corp actually owns, what it can
// afford, and - if it's doing nothing - which purchase it's blocked on.
//
// Written after the BN10 corp bricked itself: the buildout bought every unlock
// before founding a division, and since corp funds can never be topped up from
// personal money, a corp that spends its founding stake without founding a
// division is stuck at $0 revenue permanently. This prints enough to tell that
// state apart from "just slow" at a glance.
//
// Run it off-home (it carries the corporation API, so it's fat):
//   run tools/corp-status.js
//
// Read-only: it buys nothing and changes nothing.

import { CONFIG } from "../lib/config.js";
import { safe, designCity } from "../lib/corp-lib.js";

const CO = CONFIG.corp;

/** @param {NS} ns */
export async function main(ns) {
  const c = ns.corporation;
  const $ = n => `$${ns.format.number(n)}`;

  if (!c.hasCorporation()) {
    ns.tprint("No corporation. Self-funding needs " +
      `${$(CO.selfFundCost * CO.selfFundBuffer)} of personal money (${$(CO.selfFundCost)} cost x ${CO.selfFundBuffer} buffer).`);
    return;
  }

  const corp = c.getCorporation();
  const round = safe(() => c.getInvestmentOffer().round) ?? 99;
  const offer = safe(() => c.getInvestmentOffer().funds) ?? 0;

  ns.tprint("=".repeat(66));
  ns.tprint(`${corp.name} | ${corp.public ? "public" : "private"} | investment round ${round}`);
  ns.tprint(`funds ${$(corp.funds)} | revenue ${$(corp.revenue ?? 0)}/s | expenses ${$(corp.expenses ?? 0)}/s ` +
    `| profit ${$((corp.revenue ?? 0) - (corp.expenses ?? 0))}/s`);
  ns.tprint(`valuation ${$(corp.valuation ?? 0)} | standing offer ${$(offer)}`);

  // ── Unlocks ────────────────────────────────────────────────────────────────
  ns.tprint("-".repeat(66));
  const groups = [
    ["API (buildout can't run without these)", CO.apiUnlocks],
    ["optional", CO.optionalUnlocks],
    ["dividend tax", CO.taxUnlocks],
  ];
  for (const [label, names] of groups) {
    for (const name of /** @type {any[]} */ (names)) {
      const owned = safe(() => c.hasUnlock(name)) ?? false;
      const cost = safe(() => c.getUnlockCost(name)) ?? NaN;
      ns.tprint(`  [${owned ? "x" : " "}] ${name.padEnd(24)} ${owned ? "owned" : $(cost)}   (${label})`);
    }
  }

  // ── Divisions ──────────────────────────────────────────────────────────────
  ns.tprint("-".repeat(66));
  /** @type {string[]} */
  const congestedCities = [];
  if (!corp.divisions.length) {
    ns.tprint("  NO DIVISIONS - the corp cannot earn anything in this state.");
  }
  for (const name of corp.divisions) {
    const d = safe(() => c.getDivision(name));
    if (!d) continue;
    ns.tprint(`  ${name} [${d.industry}] cities ${d.cities.length}/${CO.cities.length} ` +
      `| advert ${d.numAdVerts ?? 0} | research ${ns.format.number(d.researchPoints ?? 0)} ` +
      `| profit ${$((d.lastCycleRevenue ?? 0) - (d.lastCycleExpenses ?? 0))}/s`);
    for (const city of d.cities) {
      const wh = safe(() => c.getWarehouse(name, /** @type {any} */ (city)));
      const off = safe(() => c.getOffice(name, /** @type {any} */ (city)));
      // A warehouse at ~100% can't produce: its output has nowhere to go, so the
      // division stops producing, stops consuming its inputs, and the stock that
      // filled it never drains. Flag it loudly - at a glance it looks identical
      // to a healthy full-of-boost-materials warehouse.
      const full = wh && wh.size > 0 && wh.sizeUsed >= wh.size * CO.warehouseCongestionFraction;
      if (full) congestedCities.push(`${name}/${city}`);
      const whStr = wh
        ? `wh lvl ${wh.level} (${ns.format.number(wh.sizeUsed)}/${ns.format.number(wh.size)})${full ? " CONGESTED" : ""}`
        : "NO WAREHOUSE";
      const offStr = off ? `office ${off.numEmployees}/${off.size}` : "office n/a";
      ns.tprint(`     ${String(city).padEnd(11)} ${whStr.padEnd(44)} ${offStr}`);
    }
  }

  // ── What we're blocked on ──────────────────────────────────────────────────
  ns.tprint("-".repeat(66));
  // Matched by industry, not by CO.agriDivision.name - same rule the buildout
  // uses, so a hand-made division under another name counts.
  const agri = corp.divisions.find(n => safe(() => c.getDivision(n).industry) === CO.agriDivision.industry);
  if (!agri) {
    const cost = safe(() => c.getIndustryData(/** @type {any} */ (CO.agriDivision.industry)).startingCost) ?? NaN;
    const missingApis = /** @type {any[]} */ (CO.apiUnlocks)
      .filter(u => !safe(() => c.hasUnlock(u)))
      .map(u => ({ u, cost: safe(() => c.getUnlockCost(u)) ?? NaN }));
    const apiTotal = missingApis.reduce((s, m) => s + m.cost, 0);
    ns.tprint(`BLOCKED: no ${CO.agriDivision.industry} division. Needs ${$(cost)}; corp holds ${$(corp.funds)}.`);
    if (missingApis.length) {
      ns.tprint(`         plus ${$(apiTotal)} of unbought API unlocks (${missingApis.map(m => m.u).join(", ")}).`);
    }
    ns.tprint(`         Total to a working corp: ${$(cost + apiTotal)}.`);
    if (corp.funds < cost) {
      ns.tprint("         Corp funds can NEVER be topped up from personal money, and with no");
      ns.tprint("         division there is no revenue - so this corp cannot recover on its own.");
    }
  } else {
    const missingApis = /** @type {any[]} */ (CO.apiUnlocks).filter(u => !safe(() => c.hasUnlock(u)));
    if (missingApis.length) {
      const owed = missingApis.reduce((s, u) => s + (safe(() => c.getUnlockCost(u)) ?? NaN), 0);
      ns.tprint(`SAVING: ${agri} exists, but ${missingApis.join(" + ")} (${$(owed)}) is unbought, so the`);
      ns.tprint(`        buildout can't staff or expand it. Corp holds ${$(corp.funds)}. Until then the`);
      ns.tprint("        script only buys input materials and sells output - everything else waits.");
    }
    ns.tprint(`capacity built: ${globalThis.gordCorpExpandDone ? "yes" : "no"} ` +
      `| offices built: ${globalThis.gordCorpOfficeDone ? "yes" : "no"} ` +
      `| round published: ${globalThis.gordCorpRound ?? "(corp-invest not run yet)"}`);
    // The one objective the corp is banking for. Everything cheaper queues behind
    // it - which is the only way a lump (a city, a founding) is ever reached, and
    // also the first thing to check when a spend you expected hasn't happened.
    const saving = globalThis.gordCorpSavingFor ?? 0;
    if (saving > 0) {
      const label = globalThis.gordCorpObjective ?? "a buildout step";
      const profit = (corp.revenue ?? 0) - (corp.expenses ?? 0);
      const eta = profit > 0 && corp.funds < saving
        ? ` (~${(((saving - corp.funds) / profit) / 3600).toFixed(1)}h at this profit)`
        : "";
      ns.tprint(`BANKING for ${label}: ${$(corp.funds)} / ${$(saving)}${eta} - every cheaper`);
      ns.tprint("         purchase (warehouse levels, office seats, advert, upgrades) waits for it.");
    }
    // A ready round being held for its offer to settle stops every spender in
    // the corp - the second thing to check when nothing is being bought.
    const hold = globalThis.gordCorpHoldState;
    if (globalThis.gordCorpOfferHold && hold) {
      ns.tprint(`HOLDING round ${hold.round} for its offer to settle: ${$(hold.last)} after ${hold.passes} pass(es)` +
        ` - all discretionary spending is paused until it is accepted.`);
    }
    // What the offices still need this round; in rounds 1-2 Agriculture's
    // warehouse climb leaves this much alone (lib/corp-expand.js).
    const need = globalThis.gordCorpOfficeNeed;
    if (need && need.cost > 0) {
      ns.tprint(`offices still need ${$(need.cost)} this round (seats + Advert, round ${need.round})`);
    }
  }

  // ── Product pipeline (the round-3+ gate) ───────────────────────────────────
  // Rounds 3 and 4 are only accepted once Tobacco has finished 1 / 2 products
  // (CONFIG.corp.productsBeforeRound), so a product pipeline that never starts
  // freezes the whole corp at round 3 with Agriculture looking perfectly healthy.
  // Nothing else in this tool would show that, hence this section.
  ns.tprint("-".repeat(66));
  const tobacco = corp.divisions.find(n => safe(() => c.getDivision(n).industry) === CO.tobaccoDivision.industry);
  if (!tobacco) {
    if (round >= CO.tobaccoStartRound) {
      const cost = safe(() => c.getIndustryData(/** @type {any} */ (CO.tobaccoDivision.industry)).startingCost) ?? NaN;
      ns.tprint(`PRODUCTS: no ${CO.tobaccoDivision.industry} division yet (round ${round} wants one). ` +
        `Founding costs ${$(cost)}; corp holds ${$(corp.funds)}.`);
    } else {
      ns.tprint(`PRODUCTS: not due until round ${CO.tobaccoStartRound} (currently ${round}).`);
    }
  } else {
    const d = safe(() => c.getDivision(tobacco));
    const city = designCity(ns, tobacco);
    const office = city ? safe(() => c.getOffice(tobacco, city)) : null;
    ns.tprint(`PRODUCTS: ${tobacco} | design city ${city ?? "NONE - the division holds no city"}: ` +
      `office ${office?.numEmployees ?? 0}/${office?.size ?? 0}` +
      ` | slots ${(d?.products ?? []).length}/${d?.maxProducts ?? CO.maxProductsFallback}`);

    for (const p of d?.products ?? []) {
      const pd = safe(() => c.getProduct(tobacco, city, p));
      if (!pd) { ns.tprint(`     ${p.padEnd(14)} (unreadable)`); continue; }
      const pct = pd.developmentProgress ?? 0;
      ns.tprint(`     ${p.padEnd(14)} ${pct >= 100 ? "finished" : `developing ${pct.toFixed(1)}%`}` +
        ` | rating ${ns.format.number(pd.rating ?? 0)}` +
        ` | invested ${$((pd.designInvestment ?? 0) + (pd.advertisingInvestment ?? 0))}`);
    }

    // The gate that actually decides whether a NEW product is ever started:
    // corp-steady spends CO.productInvestFraction of LIQUID funds and refuses
    // anything below CO.productInvestMin, so the pipeline needs
    // productInvestMin / productInvestFraction on hand in a single tick.
    // The FIRST product ignores productInvestMin (it's a round gate, not a
    // quality decision), so the floor - and the funds it implies - only bind
    // once the division already has one.
    const floor = (d?.products ?? []).length ? CO.productInvestMin : 0;
    const invest = Math.min(corp.funds * CO.productInvestFraction, CO.productInvestCap);
    ns.tprint(`     next product spends ${(CO.productInvestFraction * 100).toFixed(0)}% of funds: ` +
      `${$(corp.funds)} -> ${$(invest)}` +
      (floor > 0 ? ` (floor ${$(floor)}, i.e. ${$(floor / CO.productInvestFraction)} liquid)` : " (no floor: first product)") +
      (invest <= floor ? "  <-- BLOCKED, no new product will be started" : ""));

    if (round <= CO.investmentRounds) {
      const need = CO.productsBeforeRound[round] ?? 0;
      if (need) {
        let finished = 0;
        for (const p of d?.products ?? []) {
          const pd = safe(() => c.getProduct(tobacco, city, p));
          if (pd && (pd.developmentProgress ?? 0) >= 100) finished++;
        }
        ns.tprint(`     round ${round} needs ${need} finished product(s); have ${finished}.`);
      }
    }

    // Every per-cycle Tobacco action (products, Wilson, Advert) lives in
    // lib/corp-steady.js. If that script isn't placed, Agriculture still builds
    // out through the rotation phases while Tobacco does literally nothing -
    // which looks identical to a blocked pipeline from the outside.
    const st = globalThis.gordCorpState;
    const age = st?.updatedAt ? (Date.now() - st.updatedAt) / 1000 : Infinity;
    if (!(age < 60)) {
      ns.tprint(`     WARNING: corp-steady has not published state ${
        Number.isFinite(age) ? `for ${age.toFixed(0)}s` : "at all"
      } - the product/Wilson/Advert loop is probably not running.`);
    }
  }

  // ── Frozen? ────────────────────────────────────────────────────────────────
  // The one failure mode that looks exactly like "just slow": no revenue, no
  // affordable next step, so nothing the buildout can do makes the corp any
  // richer, while salaries keep draining it. lib/corp-invest.js's dyingRescue
  // sells the standing round to break out - this says whether that clock is
  // running, since it's the only thing that will ever move.
  const cheapest = globalThis.gordCorpCheapestStep;
  const profit = (corp.revenue ?? 0) - (corp.expenses ?? 0);
  if (profit < 0 && Number.isFinite(cheapest) && cheapest > corp.funds) {
    ns.tprint("-".repeat(66));
    ns.tprint(`STALLED: losing ${$(-profit)}/s with the next buildout step at ${$(cheapest)} ` +
      `against ${$(corp.funds)} - the corp cannot buy its way out of this.`);
    if (congestedCities.length) {
      ns.tprint(`         Warehouses full: ${congestedCities.join(", ")}. A full warehouse produces`);
      ns.tprint("         nothing, so it never consumes its inputs either - corp-market drains the");
      ns.tprint("         input overshoot to reopen headroom.");
    }
    const since = globalThis.gordCorpStallSince;
    ns.tprint(since === undefined
      ? "         Rescue clock: not started (corp-invest hasn't seen the stall yet)."
      : `         Rescue clock: ${((Date.now() - since) / 1000).toFixed(0)}s of ` +
        `${CO.stallRescueGraceMs / 1000}s, then round ${round}'s offer (${$(offer)}) is accepted.`);
  }
  ns.tprint("=".repeat(66));
}
