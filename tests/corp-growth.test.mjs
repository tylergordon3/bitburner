// tests/corp-growth.test.mjs
//
// The growth loop (CONFIG.corp.growth) and the dividend policy
// (CONFIG.corp.dividends): what the corp does once the four investment rounds
// are banked. Before it, the corp scripts built toward fixed targets - 160
// Tobacco seats, Agriculture at 18 a city, a $1t cap on product investment -
// and stopped. None of this can be exercised in a live game from here, so the
// tests are of three kinds:
//
//   - the pure planners (the split, the office closed form, the envelopes, the
//     dividend rule) against the manual's numbers and the game's formulas;
//   - whole passes of lib/corp-office.js against a fake corporation that prices
//     offices exactly as the game does - including the one thing that had to be
//     true for "Small town": a division can be taken to 3,000 EMPLOYEES without
//     a ceiling or a stalled pass - and lib/corp-expand.js's warehouse climb
//     against one that prices warehouses the same way;
//   - lib/corp-steady.js's main loop for a few cycles against a fake
//     corporation with the game's upgrade and Advert prices.
// Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG, forNode } from "../lib/config.js";
import {
  growthActive, growthBudget, advertMaxed, officeUpgradeCost, seatsForBudget,
  envelopeBalance, envelopesOutstanding, depositEnvelopes, drawEnvelope, nodeCorp,
} from "../lib/corp-lib.js";
import { pass as officePass, productJobRatios } from "../lib/corp-office.js";
import { main as steadyMain, dividendTarget, productInvestment } from "../lib/corp-steady.js";
import { boostSpendBudget } from "../lib/corp-market.js";
import { warehousesWithBudget } from "../lib/corp-expand.js";

const CO = CONFIG.corp;
const G = CO.growth;
const D = CO.dividends;

const GLOBALS = [
  "gordCorpRound", "gordCorpSavingFor", "gordCorpOfferHold", "gordCorpOfferHoldAt", "gordCorpOfficeDone",
  "gordCorpOfficeNeed", "gordCorpJournalAccum", "gordCorpLogAt", "gordCorpStaffMode", "gordEvents",
  "gordCorpExpandDone", "gordCorpEnvelopes", "gordCorpStaff", "gordCorpState", "gordCorpNode", "gordCorpOffer",
];
function reset() {
  for (const k of GLOBALS) globalThis[k] = undefined;
}
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b), 1);
const sum = o => Object.values(o).reduce((a, b) => a + b, 0);

// ── when it runs ─────────────────────────────────────────────────────────────

test("the growth loop starts once round 4 is banked - rounds 1-4 are untouched", () => {
  for (const round of [1, 2, 3, 4]) assert.equal(growthActive(round, G), false, `round ${round}`);
  assert.equal(growthActive(5, G), true);
  assert.equal(growthActive(99, G), true, "99 is corp-invest's 'no rounds left'");
  assert.equal(growthActive(99, { ...G, enabled: false }), false);
  assert.equal(growthActive(3, { ...G, fromRound: 3 }), true, "opt-in for the rounds");
});

// ── the split ────────────────────────────────────────────────────────────────

test("before the Advert threshold the pool is split in the manual's 23rds", () => {
  const funds = 1e20;
  const b = growthBudget({ funds, saving: 0, outstanding: 0, profit: 1e12, advertMaxed: false }, G, CO);
  const pool = funds * (1 - CO.fundsReserveFraction) * G.spendFraction;
  const core = pool * (1 - G.supportShare);

  assert.ok(near(b.advert, (core * 4) / 23));
  assert.ok(near(b.envelopes.office, (core * 8) / 23));
  assert.ok(near(b.upgrades.employeeStats, (core * 8) / 23));
  assert.ok(near(b.upgrades.salesBot, core / 23));
  assert.ok(near(b.upgrades.projectInsight, core / 23));
  // rawProduction's 23rd is Smart Factories/Storage here + warehouse levels there
  assert.ok(near(b.upgrades.rawProduction + b.envelopes.warehouse, core / 23));
  // support: off the top, 10-90 warehouse-to-office
  assert.ok(near(b.envelopes.supportOffice + b.envelopes.supportWarehouse, pool * G.supportShare));
  assert.ok(near(b.envelopes.supportWarehouse, pool * G.supportShare * 0.1));
  // and all of it adds up to the pool - no share is counted twice or dropped
  assert.ok(near(b.advert + sum(b.upgrades) + sum(b.envelopes), pool));
});

test("the manual's >= 90% goes to the product division and corp upgrades", () => {
  const b = growthBudget({ funds: 1e20, saving: 0, outstanding: 0, profit: 1e12, advertMaxed: false }, G, CO);
  const support = b.envelopes.supportOffice + b.envelopes.supportWarehouse;
  assert.ok(support / (b.advert + sum(b.upgrades) + sum(b.envelopes)) <= 0.1);
});

test("past the threshold Advert takes its share of FUNDS first and the rest is split in 19ths", () => {
  const funds = 1e24;
  const b = growthBudget({ funds, saving: 0, outstanding: 0, profit: CO.advertFocusProfit, advertMaxed: false }, G, CO);
  const advert = funds * CO.advertFocusFraction;
  assert.ok(near(b.advert, advert));
  const core = (funds * (1 - CO.fundsReserveFraction) - advert) * G.spendFraction * (1 - G.supportShare);
  assert.ok(near(b.envelopes.office, (core * 8) / 19));
  assert.ok(near(b.upgrades.employeeStats, (core * 8) / 19));
  assert.ok(near(b.upgrades.salesBot, core / 19));
});

test("once awareness and popularity are at the game's cap, Advert gets nothing", () => {
  assert.equal(advertMaxed({ awareness: Number.MAX_VALUE, popularity: Number.MAX_VALUE }), true);
  assert.equal(advertMaxed({ awareness: Number.MAX_VALUE, popularity: 1e300 }), false, "popularity still climbs");
  assert.equal(advertMaxed(undefined), false);

  const b = growthBudget({ funds: 1e80, saving: 0, outstanding: 0, profit: 1e70, advertMaxed: true }, G, CO);
  assert.equal(b.advert, 0);
  const core = 1e80 * (1 - CO.fundsReserveFraction) * G.spendFraction * (1 - G.supportShare);
  assert.ok(near(b.envelopes.office, (core * 8) / 19), "its share goes to everything else");
});

test("the split never touches the reserve, the banked objective, or money already set aside", () => {
  const all = b => b.advert + sum(b.upgrades) + sum(b.envelopes);
  const base = { funds: 1e15, saving: 0, outstanding: 0, profit: 1e9, advertMaxed: false };
  assert.ok(all(growthBudget(base, G, CO)) <= 1e15 * (1 - CO.fundsReserveFraction));

  // $2q banked for Government Partnership out of $2.1q: nearly nothing left.
  const banking = growthBudget({ ...base, funds: 2.3e15, saving: 2e15 }, G, CO);
  assert.ok(all(banking) <= 2.3e15 * 0.9 - 2e15 + 1);

  // Envelopes the phases haven't drawn yet are not surplus.
  const waiting = growthBudget({ ...base, outstanding: 8e14 }, G, CO);
  assert.ok(all(waiting) <= 1e15 * 0.9 - 8e14 + 1);

  for (const s of [{ ...base, funds: -1e12 }, { ...base, saving: 1e16 }, { ...base, outstanding: 1e16 }]) {
    assert.equal(all(growthBudget(s, G, CO)), 0);
  }
  // Past the threshold too: Advert's share of funds is capped by the surplus.
  const rich = growthBudget({ funds: 1e24, saving: 8e23, outstanding: 0, profit: 1e20, advertMaxed: false }, G, CO);
  assert.ok(all(rich) <= 1e24 * 0.9 - 8e23 + 1);
});

test("boost orders don't read the envelopes as surplus either", () => {
  // corp-market passes saving + envelopes; $1e15 of funds with $8e14 set aside
  // may commit a quarter of what is genuinely left.
  assert.ok(near(boostSpendBudget(1e15, 8e14, 5), (1e15 * 0.9 - 8e14) * CO.boostBudgetFraction));
});

// ── offices: the closed form ─────────────────────────────────────────────────

test("office pricing is the game's: 3 -> 6 seats is $4.36b, and 3 -> 500 is ~$7.7e16", () => {
  // calculateOfficeSizeUpgradeCost(3, 3) = 4e9/0.09 * 1.09 * 0.09 = 4.36e9
  assert.ok(near(officeUpgradeCost(3, 3), 4.36e9, 1e-9));
  const to500 = officeUpgradeCost(3, 497);
  assert.ok(to500 > 7e16 && to500 < 8e16, String(to500));
  // buying in two steps costs what one step does (the game's formula telescopes)
  assert.ok(near(officeUpgradeCost(60, 40) + officeUpgradeCost(100, 400), officeUpgradeCost(60, 440), 1e-9));
});

test("seatsForBudget is the inverse: the most seats the budget pays for, never one more", () => {
  for (const size of [3, 20, 60, 500, 1551]) {
    for (const budget of [1e9, 4.36e9, 1e12, 7.7e16, 1e30, 1e90]) {
      const seats = seatsForBudget(size, budget);
      assert.ok(Number.isInteger(seats) && seats >= 0);
      if (seats > 0) assert.ok(officeUpgradeCost(size, seats) <= budget, `${size}+${seats} for ${budget}`);
      assert.ok(officeUpgradeCost(size, seats + 1) > budget, `${size}: one more seat should not fit ${budget}`);
    }
  }
  assert.equal(seatsForBudget(60, 0), 0);
  assert.equal(seatsForBudget(60, -1e12), 0);
  assert.equal(seatsForBudget(60, Infinity), 0, "an unreadable budget buys nothing");
  // No ceiling: $1e30 takes an office past 1,500 seats, $1e90 past 6,000.
  assert.ok(seatsForBudget(60, 1e30) > 1400);
  assert.ok(seatsForBudget(60, 1e90) > 6000);
});

// ── envelopes ────────────────────────────────────────────────────────────────

test("envelopes: deposits add up, a draw takes what was spent, and the total is what's left", () => {
  reset();
  depositEnvelopes({ office: 100, warehouse: 10 }, 1000, 60_000);
  depositEnvelopes({ office: 50, warehouse: 0 }, 2000, 60_000);
  assert.equal(envelopeBalance("office"), 150);
  assert.equal(envelopesOutstanding(), 160);

  drawEnvelope("office", 120, 3000);
  assert.equal(envelopeBalance("office"), 30);
  drawEnvelope("office", 1e9, 4000); // can't go negative
  assert.equal(envelopeBalance("office"), 0);
  assert.equal(envelopesOutstanding(), 10);
  assert.equal(envelopeBalance("never-used"), 0);
  reset();
});

test("an envelope whose phase has stopped running is handed back, not hoarded", () => {
  reset();
  const stale = 60_000;
  depositEnvelopes({ office: 100 }, 0, stale);
  depositEnvelopes({ office: 100 }, 30_000, stale);
  assert.equal(envelopeBalance("office"), 200, "within the grace period it accumulates");

  // Nobody has drawn (or even stamped) it for longer than staleMs.
  const released = depositEnvelopes({ office: 100 }, 61_000, stale);
  assert.deepEqual(released, ["office"]);
  assert.equal(envelopeBalance("office"), 0);
  assert.deepEqual(depositEnvelopes({ office: 100 }, 62_000, stale), [], "stays empty, reported once");
  assert.equal(envelopeBalance("office"), 0);

  // The phase runs again: a zero draw is enough of a stamp for deposits to resume.
  drawEnvelope("office", 0, 63_000);
  depositEnvelopes({ office: 100 }, 64_000, stale);
  assert.equal(envelopeBalance("office"), 100);
  reset();
});

// ── jobs ─────────────────────────────────────────────────────────────────────

test("the job splits: 'progress' through round 4, the manual's after-round-4 setups once growing", () => {
  for (const round of [3, 4]) {
    assert.equal(productJobRatios(true, round, 0, G), CO.jobsProductMain);
    assert.equal(productJobRatios(false, round, 0, G), CO.jobsProductSupport);
  }
  assert.equal(productJobRatios(true, 5, 1e12, null), CO.jobsProductMain, "loop off: as before");
  assert.equal(productJobRatios(true, 5, 1e12, G), G.jobsMain);
  assert.equal(productJobRatios(true, 5, G.mainRichProfit, G), G.jobsMainRich);
  assert.equal(productJobRatios(false, 5, 1e12, G), G.jobsSupport);

  for (const ratios of [G.jobsMain, G.jobsMainRich, G.jobsSupport]) assert.ok(near(sum(ratios), 1, 1e-3));
  // the manual: half of a support office on R&D, the rest in the "profit" setup
  assert.equal(G.jobsSupport["Research & Development"], 0.5);
  assert.ok(G.jobsSupport.Business > G.jobsSupport.Operations && G.jobsSupport.Operations > G.jobsSupport.Engineer);
});

// ── a whole corp-office pass ─────────────────────────────────────────────────

/**
 * A corporation with one Tobacco division in all six cities, offices priced by
 * the game's own formula. `calls` counts every API call by name.
 */
function officeNs({ funds = 1e18, design = 60, support = 20, profit = 1e12 } = {}) {
  const cities = ["Sector-12", ...CO.cities.filter(c => c !== "Sector-12")];
  const offices = Object.fromEntries(cities.map((city, i) => [city, {
    size: i === 0 ? design : support, numEmployees: 0,
    employeeJobs: { Operations: 0, Engineer: 0, Business: 0, Management: 0, "Research & Development": 0, Intern: 0, Unassigned: 0 },
  }]));
  const state = { funds, offices, calls: {} };
  const count = name => { state.calls[name] = (state.calls[name] ?? 0) + 1; };
  const office = city => { if (!offices[city]) throw new Error("no office"); return offices[city]; };
  const division = { name: "Tobacco", industry: "Tobacco", cities, researchPoints: 0, numAdVerts: 0 };
  return {
    state,
    print: () => {},
    format: { number: n => String(n) },
    corporation: {
      getCorporation: () => { count("getCorporation"); return { funds: state.funds, revenue: profit, expenses: 0, divisions: ["Tobacco"] }; },
      getDivision: name => { if (name !== "Tobacco") throw new Error("no division"); return division; },
      getOffice: (div, city) => { count("getOffice"); const o = office(city); return { ...o, employeeJobs: { ...o.employeeJobs } }; },
      getOfficeSizeUpgradeCost: (div, city, n) => { count("getOfficeSizeUpgradeCost"); return officeUpgradeCost(office(city).size, n); },
      // The game: returns silently when the corp can't pay.
      upgradeOfficeSize: (div, city, n) => {
        count("upgradeOfficeSize");
        const cost = officeUpgradeCost(office(city).size, n);
        if (state.funds < cost) return;
        state.funds -= cost;
        office(city).size += n;
      },
      hireEmployee: (div, city) => {
        count("hireEmployee");
        const o = office(city);
        if (o.numEmployees >= o.size) return false;
        o.numEmployees++;
        return true;
      },
      setJobAssignment: (div, city, job, n) => { count("setJobAssignment"); office(city).employeeJobs[job] = n; return true; },
      getHireAdVertCost: () => 1e9,
      hireAdVert: () => {},
    },
  };
}
const headcount = ns => Object.values(ns.state.offices).reduce((s, o) => s + o.numEmployees, 0);
const seatcount = ns => Object.values(ns.state.offices).reduce((s, o) => s + o.size, 0);

test("round 4: the fixed targets still rule - 60 + 5 x 20 seats and not one more", () => {
  reset();
  globalThis.gordCorpRound = 4;
  depositEnvelopes({ office: 1e17 }, Date.now(), 600_000); // must be ignored before the loop is on
  const ns = officeNs();
  officePass(ns);
  officePass(ns);
  assert.equal(seatcount(ns), 160);
  assert.equal(headcount(ns), 160);
  assert.equal(envelopeBalance("office"), 1e17);
  reset();
});

test("growing: an office grows by its part of the envelope in ONE purchase, and the envelope pays for it", () => {
  reset();
  globalThis.gordCorpRound = 5;
  const ns = officeNs({ funds: 1e16 });
  officePass(ns); // floors: already there; staffs the 160
  const before = { ...ns.state.calls };
  const fundsBefore = ns.state.funds;

  const envelope = 1e14;
  depositEnvelopes({ office: envelope }, Date.now(), 600_000);
  officePass(ns);

  // half to the design office, a tenth to each of the other five
  const main = 60 + seatsForBudget(60, envelope * 0.5);
  const other = 20 + seatsForBudget(20, envelope * 0.1);
  assert.equal(ns.state.offices["Sector-12"].size, main);
  for (const city of CO.cities.filter(c => c !== "Sector-12")) assert.equal(ns.state.offices[city].size, other, city);
  assert.ok(main > 60 && other > 20);

  // six purchases for six offices - not one per three seats
  assert.equal(ns.state.calls.upgradeOfficeSize - (before.upgradeOfficeSize ?? 0), 6);
  const spent = fundsBefore - ns.state.funds;
  assert.ok(spent > 0 && spent <= envelope);
  assert.ok(near(envelopeBalance("office"), envelope - spent, 1e-9), "the envelope is drawn by what was SPENT");
  assert.equal(headcount(ns), seatcount(ns), "and the new seats are staffed in the same pass");
  // the after-round-4 job setups
  const jobs = ns.state.offices["Sector-12"].employeeJobs;
  assert.equal(jobs["Research & Development"], 0);
  assert.ok(jobs.Engineer > jobs.Business && jobs.Management > jobs.Business);
  const sup = ns.state.offices.Aevum.employeeJobs;
  assert.ok(Math.abs(sup["Research & Development"] - other / 2) <= 1);
  assert.ok(sup.Business > sup.Operations);
  assert.equal(globalThis.gordCorpStaff.employees, headcount(ns));
  reset();
});

test("SMALL TOWN: a division reaches 3,000 employees - no ceiling, and no pass hires more than its cap", () => {
  reset();
  globalThis.gordCorpRound = 5;
  // Six offices of 500 are ~$4.6e17 of seats; give the loop that in the split
  // it would arrive in (half to the design office) and funds to cover it.
  const ns = officeNs({ funds: 1e19 });
  depositEnvelopes({ office: 1.6e18 }, Date.now(), 600_000);

  let passes = 0;
  while (headcount(ns) < 3000 && passes < 10) {
    const hiresBefore = ns.state.calls.hireEmployee ?? 0;
    officePass(ns);
    passes++;
    const hires = ns.state.calls.hireEmployee - hiresBefore;
    assert.ok(hires <= G.maxHiresPerPass + 6, `pass ${passes} made ${hires} hire calls`);
  }
  assert.ok(headcount(ns) >= 3000, `${headcount(ns)} employees after ${passes} passes`);
  assert.ok(passes <= 3, `took ${passes} passes`);
  for (const [city, o] of Object.entries(ns.state.offices)) assert.ok(o.size > 400, `${city}: ${o.size} seats`);
  assert.ok(ns.state.offices["Sector-12"].size > 500, "past the old money-run target, not stopped at it");

  // The whole thing in a bounded number of API calls: 3,000+ hires, and
  // otherwise a few dozen calls a pass.
  const total = Object.values(ns.state.calls).reduce((a, b) => a + b, 0);
  assert.ok(total < headcount(ns) + 400 * passes, `${total} API calls for ${headcount(ns)} employees`);
  assert.ok(ns.state.calls.upgradeOfficeSize <= 6 * passes + 6);
  reset();
});

test("the envelope is a claim on funds, not a bank account: no seat is bought the corp can't pay for", () => {
  reset();
  globalThis.gordCorpRound = 5;
  const ns = officeNs({ funds: 1e13 });
  officePass(ns);
  depositEnvelopes({ office: 1e17 }, Date.now(), 600_000); // far more than the corp holds
  const funds = ns.state.funds;
  officePass(ns);
  assert.ok(ns.state.funds >= funds * CO.fundsReserveFraction, "the operating reserve survives");
  assert.ok(ns.state.funds < funds, "but what it can afford, it buys");
  assert.ok(near(envelopeBalance("office"), 1e17 - (funds - ns.state.funds), 1e-9));

  // ...and nothing at all while lib/corp-expand.js is banking more than the corp has.
  globalThis.gordCorpSavingFor = 1e15;
  const seats = seatcount(ns);
  officePass(ns);
  assert.equal(seatcount(ns), seats);
  reset();
});

test("a second growing pass with nothing new in the envelope buys nothing and re-journals nothing", () => {
  reset();
  globalThis.gordCorpRound = 5;
  const ns = officeNs({ funds: 1e16 });
  depositEnvelopes({ office: 1e14 }, Date.now(), 600_000);
  officePass(ns);
  const seats = seatcount(ns);
  const left = envelopeBalance("office");
  globalThis.gordCorpJournalAccum = {};
  officePass(ns);
  officePass(ns);
  assert.equal(seatcount(ns), seats, "the leftover is under one seat's price for every office");
  assert.equal(envelopeBalance("office"), left);
  assert.deepEqual(globalThis.gordCorpJournalAccum.officeBuild ?? {}, {});
  reset();
});

// ── corp-expand: warehouses on a budget ──────────────────────────────────────

/** Six warehouses at the given levels, priced as the game prices them. */
function warehouseNs(levels, funds) {
  const state = { funds, level: Object.fromEntries(CO.cities.map((c, i) => [c, levels[i]])), calls: 0 };
  const cost = city => 1e9 * 1.07 ** (state.level[city] + 1);
  return {
    state,
    corporation: {
      getCorporation: () => { state.calls++; return { funds: state.funds }; },
      getWarehouse: (div, city) => { state.calls++; return { level: state.level[city] }; },
      getUpgradeWarehouseCost: (div, city) => { state.calls++; return cost(city); },
      upgradeWarehouse: (div, city) => {
        state.calls++;
        if (state.funds < cost(city)) return;
        state.funds -= cost(city);
        state.level[city]++;
      },
    },
  };
}

test("warehouses climb on a budget: lowest city first, never past the budget, no target level", () => {
  reset();
  const ns = warehouseNs([24, 24, 30, 24, 26, 24], 1e15);
  const budget = 4e12;
  const res = warehousesWithBudget(ns, "Tobacco", budget, G.maxLevelsPerTick);

  assert.ok(res.levels > 0 && res.spend <= budget);
  assert.ok(near(res.spend, 1e15 - ns.state.funds, 1e-9));
  const lv = Object.values(ns.state.level);
  // the laggards were brought up before anything went past them...
  assert.ok(Math.min(...lv) > 26, String(lv));
  // ...and what is left would not buy the next level of the lowest
  assert.ok(budget - res.spend < 1e9 * 1.07 ** (Math.min(...lv) + 1));
  assert.ok(Math.max(...lv) > 24 + 6, "past the old tobaccoTargets.warehouse ceiling");
  // three calls a level (price, affordable, buy) plus the six opening reads
  assert.ok(ns.state.calls <= res.levels * 3 + 6 + 3, `${ns.state.calls} calls for ${res.levels} levels`);
  reset();
});

test("the warehouse budget is a claim on funds too, and a run-away budget stops at the level cap", () => {
  reset();
  // budget far beyond the corp's funds: stops where the reserve does
  const poor = warehouseNs([24, 24, 24, 24, 24, 24], 5e10);
  warehousesWithBudget(poor, "Tobacco", 1e15, G.maxLevelsPerTick);
  assert.ok(poor.state.funds > 0 && poor.state.funds < 5e10);

  globalThis.gordCorpSavingFor = 1e12; // banking for more than it holds: buy nothing
  const saving = warehouseNs([24, 24, 24, 24, 24, 24], 5e10);
  assert.deepEqual(warehousesWithBudget(saving, "Tobacco", 1e15, G.maxLevelsPerTick), { levels: 0, spend: 0 });
  globalThis.gordCorpSavingFor = undefined;

  const rich = warehouseNs([24, 24, 24, 24, 24, 24], 1e80);
  assert.equal(warehousesWithBudget(rich, "Tobacco", 1e70, 60).levels, 60);
  assert.deepEqual(warehousesWithBudget(rich, "Tobacco", 0, 60), { levels: 0, spend: 0 });
  reset();
});

// ── corp-steady: a few cycles of the loop ────────────────────────────────────

const UPGRADES = {
  "Smart Factories": [2e9, 1.06], "Smart Storage": [2e9, 1.06], "Wilson Analytics": [4e9, 2],
  FocusWires: [1e9, 1.06], "Neural Accelerators": [1e9, 1.06], "Speech Processor Implants": [1e9, 1.06],
  "Nuoptimal Nootropic Injector Implants": [1e9, 1.06], "ABC SalesBots": [1e9, 1.07], "Project Insight": [5e9, 1.07],
};

/**
 * A public corp past round 4 with a Tobacco division; game prices for upgrades
 * and Advert. Levels start where a corp holding `funds` would have them - the
 * next level of everything costs about a thousandth of funds - unless
 * `fromZero`, which prices everything at level 0 (Wilson always starts at 0).
 */
function steadyNs({ funds, profit, cycles = 1, awareness = 1e6, dividendRate = 0, products = [], fromZero = false }) {
  const start = (base, mult) => (fromZero ? 0 : Math.max(0, Math.round(Math.log((funds * 1e-3) / base) / Math.log(mult))));
  const levels = Object.fromEntries(Object.entries(UPGRADES).map(([k, [base, mult]]) => [k, start(base, mult)]));
  levels["Wilson Analytics"] = 0;
  const s = {
    funds, profit, dividendRate, levels, start: { ...levels },
    adverts: start(1e9, 1.06), awareness, popularity: awareness, spentOn: {}, made: [], calls: 0, ticks: 0,
  };
  s.startAdverts = s.adverts;
  const pay = (what, cost) => { s.funds -= cost; s.spentOn[what] = (s.spentOn[what] ?? 0) + cost; };
  const upCost = name => UPGRADES[name][0] * UPGRADES[name][1] ** s.levels[name];
  const adCost = () => 1e9 * 1.06 ** s.adverts;
  const division = () => ({
    name: "Tobacco", industry: "Tobacco", makesProducts: true, cities: ["Sector-12"], maxProducts: 3,
    products: [...products, ...s.made.map(m => m.name)], awareness: s.awareness, popularity: s.popularity,
    numAdVerts: s.adverts, researchPoints: 0,
  });
  const api = {
    hasCorporation: () => true,
    nextUpdate: async () => {
      if (s.ticks++ >= cycles) throw new Error("stop");
      return "START";
    },
    getCorporation: () => ({
      name: "T", funds: s.funds, revenue: s.profit, expenses: 0, divisions: ["Tobacco"], public: true,
      dividendRate: s.dividendRate, valuation: 0, tributeModifier: 0,
    }),
    getDivision: name => { if (name !== "Tobacco") throw new Error("no division"); return division(); },
    getProduct: (div, city, name) => ({ name, developmentProgress: 100, rating: 1, desiredSellPrice: "MP", productionCost: 0 }),
    hasResearched: () => true,
    sellProduct: () => {},
    setProductMarketTA2: () => {},
    discontinueProduct: () => {},
    makeProduct: (div, city, name, design, marketing) => {
      if (s.funds < design + marketing) throw new Error("can't afford");
      pay("product", design + marketing);
      s.made.push({ name, invest: design + marketing });
    },
    getUpgradeLevelCost: upCost,
    levelUpgrade: name => {
      const cost = upCost(name);
      if (s.funds < cost) throw new Error("can't afford");
      pay(name, cost);
      s.levels[name]++;
    },
    getHireAdVertCost: adCost,
    hireAdVert: () => {
      const cost = adCost();
      if (s.funds < cost) return; // the game: silently nothing
      pay("Advert", cost);
      s.adverts++;
    },
    issueDividends: rate => { s.dividendRate = rate; },
  };
  // count every corp API call
  const corporation = Object.fromEntries(Object.entries(api).map(([k, f]) => [k, (...a) => { s.calls++; return f(...a); }]));
  return { s, disableLog: () => {}, print: () => {}, tprint: () => {}, format: { number: n => String(n) }, corporation };
}
async function runSteady(ns) {
  await assert.rejects(steadyMain(ns), /stop/);
}
const spent = (s, names) => names.reduce((a, n) => a + (s.spentOn[n] ?? 0), 0);

test("one growing cycle: every category gets its 23rds, to within a level's price", async () => {
  reset();
  globalThis.gordCorpRound = 5;
  const funds = 1e20;
  const ns = steadyNs({ funds, profit: 1e12, products: ["Tobacco-v0", "Tobacco-v1", "Tobacco-v2"] });
  await runSteady(ns);
  const s = ns.s;

  // Wilson came first, out of funds; the split is of what was left after it.
  assert.ok(s.levels["Wilson Analytics"] > 20, "Wilson is bought while it costs under half the funds");
  const afterWilson = funds - s.spentOn["Wilson Analytics"];
  const core = afterWilson * (1 - CO.fundsReserveFraction) * G.spendFraction * (1 - G.supportShare);
  // Each budget is spent down to less than the price of one more level.
  const nextPrice = names => Math.min(...names.map(n => UPGRADES[n][0] * UPGRADES[n][1] ** s.levels[n]));
  const within = (got, want, next, name) =>
    assert.ok(got <= want * (1 + 1e-9) && want - got < next, `${name}: ${got} of ${want} (next level ${next})`);
  const group = (key, want) => within(spent(s, G.upgrades[key]), want, nextPrice(G.upgrades[key]), key);

  group("employeeStats", (core * 8) / 23);
  group("salesBot", core / 23);
  group("projectInsight", core / 23);
  group("rawProduction", (core / 23) * (1 - G.rawWarehouseShare));
  within(s.spentOn.Advert, (core * 4) / 23, 1e9 * 1.06 ** s.adverts, "Advert");
  assert.ok(spent(s, G.upgrades.employeeStats) > 6 * spent(s, G.upgrades.salesBot), "8/23 against 1/23");
  // the four stat upgrades stay level with each other
  const stat = G.upgrades.employeeStats.map(n => s.levels[n]);
  assert.ok(Math.max(...stat) - Math.min(...stat) <= 1, String(stat));

  // The phases' parts are set aside, not spent - and not counted as surplus again.
  assert.ok(near(envelopeBalance("office"), (core * 8) / 23, 1e-6));
  assert.ok(near(envelopeBalance("warehouse"), (core / 23) * G.rawWarehouseShare, 1e-6));
  assert.ok(envelopeBalance("supportOffice") > 0 && envelopeBalance("supportWarehouse") > 0);
  assert.ok(s.funds >= envelopesOutstanding() + funds * 0.01, "the envelopes are still in the bank");
  assert.equal(globalThis.gordCorpState.growing, true);
  reset();
});

test("growth compounds across cycles without double-spending what the phases haven't drawn", async () => {
  reset();
  globalThis.gordCorpRound = 5;
  const ns = steadyNs({ funds: 1e18, profit: 1e12, cycles: 5, products: ["a", "b", "c"] });
  await runSteady(ns);
  // Nobody drew the envelopes: after five cycles they hold more than after one,
  // and the corp still has every dollar of them.
  assert.ok(ns.s.funds >= envelopesOutstanding(), `${ns.s.funds} funds vs ${envelopesOutstanding()} set aside`);
  assert.ok(ns.s.funds > 0);
  reset();
});

test("past the Advert threshold half the funds go to Advert; at the awareness cap, none do", async () => {
  reset();
  globalThis.gordCorpRound = 5;
  const funds = 1e24;
  const focus = steadyNs({ funds, profit: 1e19, products: ["a", "b", "c"] });
  await runSteady(focus);
  const afterWilson = funds - focus.s.spentOn["Wilson Analytics"];
  const advertBudget = afterWilson * CO.advertFocusFraction;
  assert.ok(focus.s.spentOn.Advert <= advertBudget);
  assert.ok(advertBudget - focus.s.spentOn.Advert < 1e9 * 1.06 ** focus.s.adverts, "down to under one more level");

  reset();
  globalThis.gordCorpRound = 5;
  const capped = steadyNs({ funds, profit: 1e19, awareness: Number.MAX_VALUE, products: ["a", "b", "c"] });
  await runSteady(capped);
  assert.equal(capped.s.adverts, capped.s.startAdverts);
  assert.equal(capped.s.levels["Wilson Analytics"], 0, "Wilson only multiplies Advert - nothing left to multiply");
  assert.ok(spent(capped.s, G.upgrades.employeeStats) > 0);
  reset();
});

test("a run-away budget is bounded per cycle: at most maxLevelsPerTick levels of anything", async () => {
  reset();
  globalThis.gordCorpRound = 5;
  // $1e60 against level-0 prices: every budget covers thousands of levels.
  const ns = steadyNs({ funds: 1e60, profit: 1e50, products: ["a", "b", "c"], fromZero: true });
  await runSteady(ns);
  assert.equal(ns.s.adverts, G.maxLevelsPerTick);
  for (const names of Object.values(G.upgrades)) {
    assert.equal(names.reduce((a, n) => a + ns.s.levels[n], 0), G.maxLevelsPerTick, names.join("+"));
  }
  // two calls a level, plus the cycle's fixed overhead
  assert.ok(ns.s.calls < 6 * G.maxLevelsPerTick * 2.2 + 400, `${ns.s.calls} API calls in one cycle`);
  reset();
});

test("the product cap is lifted once growing: 1% of funds, whatever the funds", async () => {
  assert.equal(productInvestment(1e16, false), CO.productInvestCap, "rounds: capped as before");
  assert.equal(productInvestment(1e10, false), 1e8);
  assert.equal(productInvestment(1e30, true), 1e28);

  reset();
  globalThis.gordCorpRound = 5;
  const ns = steadyNs({ funds: 1e30, profit: 1e20, products: ["Tobacco-v3"] });
  await runSteady(ns);
  assert.equal(ns.s.made.length, 1);
  assert.equal(ns.s.made[0].name, "Tobacco-v4");
  assert.ok(ns.s.made[0].invest > 1e27, `invested ${ns.s.made[0].invest}`);
  reset();
});

test("before round 5 corp-steady spends exactly as it did: no envelopes, capped product", async () => {
  reset();
  globalThis.gordCorpRound = 4;
  globalThis.gordCorpExpandDone = true;
  globalThis.gordCorpOfficeDone = true;
  const ns = steadyNs({ funds: 1e16, profit: 1e10, products: ["Tobacco-v0"] });
  await runSteady(ns);
  assert.equal(envelopesOutstanding(), 0);
  assert.equal(ns.s.made[0].invest, CO.productInvestCap);
  assert.equal(globalThis.gordCorpState.growing, false);
  // the old cheapest-first scan levels all eight upgrades together
  for (const up of ["ABC SalesBots", "Project Insight", "FocusWires"]) assert.ok(ns.s.levels[up] > ns.s.start[up], up);
  assert.equal(ns.s.dividendRate, 0, "no dividends while a round is open");
  reset();
});

// ── dividends ────────────────────────────────────────────────────────────────

test("adaptive dividends: reinvest while profit multiplies, pay out once it stops", () => {
  const s = (current, growth, saving = 0) => ({ current, growth, saving });
  // unknown growth (a fresh window, or no profit a window ago) counts as growing
  assert.equal(dividendTarget(s(0, null), D, CO.dividendRate), D.reinvestRate);
  assert.equal(dividendTarget(s(D.reinvestRate, null), D, CO.dividendRate), null, "already there: leave it");
  // doubled in the window: still growing
  assert.equal(dividendTarget(s(D.reinvestRate, D.growthFactor), D, CO.dividendRate), null);
  // stopped multiplying: pay out
  assert.equal(dividendTarget(s(D.reinvestRate, 1.3), D, CO.dividendRate), D.payoutRate);
  assert.equal(dividendTarget(s(D.payoutRate, 1.3), D, CO.dividendRate), null);
  // hysteresis: just over the line is not enough to flip back
  assert.equal(dividendTarget(s(D.payoutRate, D.growthFactor * 1.1), D, CO.dividendRate), null);
  assert.equal(dividendTarget(s(D.payoutRate, D.growthFactor * D.hysteresis), D, CO.dividendRate), D.reinvestRate);
  // banking for an objective (the tax unlocks): keep the money in the corp
  assert.equal(dividendTarget(s(D.payoutRate, 1, 5e14), D, CO.dividendRate), D.reinvestRate);
  assert.ok(D.reinvestRate < D.payoutRate && D.payoutRate <= 1 && D.hysteresis > 1);
});

test("fixed dividends are the old behaviour: raised once, never lowered", () => {
  const fixed = { ...D, mode: "fixed" };
  assert.equal(dividendTarget({ current: 0, growth: 1, saving: 0 }, fixed, 0.1), 0.1);
  assert.equal(dividendTarget({ current: 0.1, growth: 1, saving: 0 }, fixed, 0.1), null);
  assert.equal(dividendTarget({ current: 0.4, growth: 100, saving: 0 }, fixed, 0.1), null, "a hand-set rate stays");
});

test("corp-steady pays the reinvest rate at first, and the payout rate once profit has been flat for a window", async () => {
  reset();
  globalThis.gordCorpRound = 5;
  const ns = steadyNs({ funds: 1e15, profit: 1e12, cycles: 3, products: ["a", "b", "c"] });
  await runSteady(ns);
  assert.equal(ns.s.dividendRate, D.reinvestRate);

  reset();
  globalThis.gordCorpRound = 5;
  const flat = steadyNs({ funds: 1e15, profit: 1e12, cycles: D.growthWindowCycles + 3, products: ["a", "b", "c"] });
  await runSteady(flat);
  assert.equal(flat.s.dividendRate, D.payoutRate);
  assert.ok((globalThis.gordEvents ?? []).some(e => /paying out/.test(e.text)));

  // Below dividendMinProfitPerSec nothing is paid at all.
  reset();
  globalThis.gordCorpRound = 5;
  const poor = steadyNs({ funds: 1e12, profit: CO.dividendMinProfitPerSec / 2, cycles: 3, products: ["a", "b", "c"] });
  await runSteady(poor);
  assert.equal(poor.s.dividendRate, 0);
  reset();
});

// ── the node overlay ─────────────────────────────────────────────────────────

test("growth and dividend settings resolve per node, so the MONEY_RUN overlay reaches them", () => {
  reset();
  assert.deepEqual(nodeCorp().growth, G, "no node published yet: the defaults");
  globalThis.gordCorpNode = 3;
  assert.equal(nodeCorp(), forNode(3).corp);
  assert.equal(nodeCorp().growth.enabled, true);
  reset();
});
