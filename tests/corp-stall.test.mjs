// tests/corp-stall.test.mjs
//
// Regression tests for the two halves of the "corp freezes at $0 revenue" bug,
// which has now bitten twice. The live shape was: a round-1 Agriculture division
// whose warehouses filled to ~100% (input purchase orders overshot under bonus
// time), which stops production, which stops input consumption, so the overshoot
// never drains - $0 revenue, funds bleeding to -$1b on salaries, and the next
// warehouse level permanently unaffordable.
//
// Two guards keep that from being terminal, and both are tested here:
//
//   lib/corp-invest.js dyingRescue - sells the standing investment round once the
//   stall has persisted. Before the fix it was gated on round > 2, so rounds 1-2
//   had no zero-revenue exit at all and the corp stayed frozen for the life of
//   the save.
//
//   lib/corp-market.js boostOrderTargets - in rounds 1-2, holds boost-material
//   orders while the buildout can still afford its next capacity step, so the
//   money isn't sunk into Real Estate before the warehouses that hold it are
//   bought. It deliberately does NOT wait for the capacity handshake: once
//   capacity spending is blocked (targets met, banking for a founding, next step
//   out of reach) the boosts are the best thing left to buy, and starving them
//   would freeze the production multiplier of exactly the corp that needs it.
//
// Both are importable under Node: these modules' top level never touches ns, and
// the functions take ns as a parameter, so a small fake covers the reads.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../lib/config.js";
import { dyingRescue, pass as investPass } from "../lib/corp-invest.js";
import { boostOrderTargets } from "../lib/corp-market.js";
import { secondsToAfford, affordable } from "../lib/corp-lib.js";
import { pendingCityCost } from "../lib/corp-expand.js";

const CO = CONFIG.corp;
const GRACE = CO.stallRescueGraceMs;

// The globals the corp phases publish to each other. Every test starts from a
// clean slate: dyingRescue's dwell clock lives on globalThis precisely because
// the phases are one-shots, so leakage between tests would be invisible.
const GLOBALS = ["gordCorpOffer", "gordCorpCheapestStep", "gordCorpStallSince", "gordCorpExpandDone", "gordCorpSavingFor"];
function reset() {
  for (const k of GLOBALS) globalThis[k] = undefined;
}

/**
 * Just enough ns for corpFunds() and the round-1 RP gate (divisionByIndustry
 * walks getCorporation().divisions, then reads each one's industry).
 */
function fakeNs({ funds, researchPoints }) {
  const division = { name: "Agriculture", industry: "Agriculture", researchPoints };
  return {
    corporation: {
      getCorporation: () => ({ funds, divisions: [division.name] }),
      getDivision: name => (name === division.name ? division : undefined),
    },
  };
}

/** The frozen corp from the save: producing nothing, paying salaries. */
function frozen({ funds = -1.036e9, researchPoints = 703 } = {}) {
  reset();
  globalThis.gordCorpOffer = 4e9;          // a standing round-1 offer
  globalThis.gordCorpCheapestStep = 1.145e9; // next warehouse level, unaffordable
  return {
    ns: fakeNs({ funds, researchPoints }),
    corp: { revenue: 0, expenses: 3429 },  // $0/s in, $3.4k/s out
  };
}

// ── dyingRescue: the dwell ───────────────────────────────────────────────────

test("a stall is not acted on the first time it is seen - it starts the clock", () => {
  const { ns, corp } = frozen();
  assert.equal(dyingRescue(ns, corp, 1), false);
  assert.equal(typeof globalThis.gordCorpStallSince, "number");
});

test("still inside the grace period, the round is not sold", () => {
  const { ns, corp } = frozen();
  globalThis.gordCorpStallSince = Date.now() - (GRACE - 10_000);
  assert.equal(dyingRescue(ns, corp, 1), false);
});

test("a stall that outlives the grace period IS the frozen corp - rescue fires", () => {
  const { ns, corp } = frozen();
  globalThis.gordCorpStallSince = Date.now() - (GRACE + 1_000);
  assert.equal(dyingRescue(ns, corp, 1), true);
});

test("rescue fires in round 1 at $0 revenue - the case the round > 2 gate missed", () => {
  const { ns, corp } = frozen();
  globalThis.gordCorpStallSince = Date.now() - (GRACE + 1_000);
  assert.equal(corp.revenue, 0, "the whole point: there is no revenue to gate on");
  for (const round of [1, 2, 3, 4]) {
    assert.equal(dyingRescue(ns, corp, round), true, `round ${round}`);
  }
});

// ── dyingRescue: what must NOT sell a round ──────────────────────────────────

test("a profitable corp is not stalled, and seeing one clears the clock", () => {
  const { ns } = frozen();
  globalThis.gordCorpStallSince = Date.now() - (GRACE + 1_000);
  assert.equal(dyingRescue(ns, { revenue: 5e6, expenses: 1e6 }, 1), false);
  assert.equal(globalThis.gordCorpStallSince, undefined, "the dwell must restart, not accumulate");
});

test("a completed buildout (no pending step) is a mid-cycle dip, not a stall", () => {
  const { ns, corp } = frozen();
  globalThis.gordCorpCheapestStep = Infinity;
  globalThis.gordCorpStallSince = Date.now() - (GRACE + 1_000);
  assert.equal(dyingRescue(ns, corp, 1), false);
});

test("an affordable next step is not a stall - the corp can still buy its way on", () => {
  const { ns, corp } = frozen({ funds: 50e9 });
  globalThis.gordCorpStallSince = Date.now() - (GRACE + 1_000);
  assert.equal(dyingRescue(ns, corp, 1), false);
});

test("no standing offer, no rescue", () => {
  const { ns, corp } = frozen();
  globalThis.gordCorpOffer = 0;
  globalThis.gordCorpStallSince = Date.now() - (GRACE + 1_000);
  assert.equal(dyingRescue(ns, corp, 1), false);
});

test("the round-1 RP gate is not skippable, stall or no stall", () => {
  const { ns, corp } = frozen({ researchPoints: CO.round1ResearchPoints - 1 });
  globalThis.gordCorpStallSince = Date.now() - (GRACE + 1_000);
  assert.equal(dyingRescue(ns, corp, 1), false);
});

// ── "Stalled" means unreachable, not unprofitable ────────────────────────────
//
// The BN10 corp's round-3 state, read straight off tools/corp-status.js: funds
// $452.750m, revenue $20.052k/s, expenses $12.638k/s - a PROFIT of $7.414k/s -
// with the next warehouse level $1.145b away. That is 26 hours of saving, and
// nothing in between grows, but a `profit < 0` test calls it healthy. Both the
// $90b savings floor and the round-3 product gate then read as "be patient"
// while the corp was in fact stationary.

const BN10 = { revenue: 20052, expenses: 12638 }; // +$7.414k/s
const BN10_FUNDS = 452.75e6;

test("secondsToAfford: the gap in corp-seconds, or Infinity when not earning", () => {
  assert.equal(secondsToAfford(10, 5, 1), 0, "already affordable");
  assert.equal(secondsToAfford(0, 100, 10), 10);
  assert.equal(secondsToAfford(0, 100, 0), Infinity, "not earning closes no gap");
  assert.equal(secondsToAfford(0, 100, -5), Infinity, "nor does losing money");
  assert.equal(
    Math.round(secondsToAfford(BN10_FUNDS, 1.145e9, BN10.revenue - BN10.expenses)),
    93371, "the save's own 26-hour gap",
  );
});

test("REGRESSION: a profitable corp a day out from its next step is stalled", () => {
  reset();
  globalThis.gordCorpOffer = 3.218e9;         // the standing round-3 offer
  globalThis.gordCorpCheapestStep = 1.145e9;  // Sector-12's next warehouse level
  const ns = fakeNs({ funds: BN10_FUNDS, researchPoints: 2915 });
  assert.ok(BN10.revenue - BN10.expenses > 0, "the whole point: it IS profitable");
  globalThis.gordCorpStallSince = Date.now() - (GRACE + 1_000);
  assert.equal(dyingRescue(ns, BN10, 3), true);
});

test("a profitable corp that can reach its next step soon is left to earn it", () => {
  reset();
  globalThis.gordCorpOffer = 3.218e9;
  globalThis.gordCorpCheapestStep = 1.145e9;
  // Same gap, but 100x the profit: ~934s out, well inside the horizon.
  const ns = fakeNs({ funds: BN10_FUNDS, researchPoints: 2915 });
  globalThis.gordCorpStallSince = Date.now() - (GRACE + 1_000);
  assert.equal(dyingRescue(ns, { revenue: 2005200, expenses: 1263800 }, 3), false);
});

// ── The whole acceptance pass ────────────────────────────────────────────────
//
// The freeze lived in pass()'s gating, not in the predicates it calls: `const
// rescue = round > 2 && dyingRescue(...)` made the rescue false by construction
// in rounds 1-2, and the very next line returned on `revenue <= 0`. Testing the
// predicates alone would have missed that entirely, so these drive the real
// function against a fake ns.

/** A whole fake corporation, plus a record of whether the round was accepted. */
function fakeCorpNs({ round, offer, funds, revenue, expenses, researchPoints }) {
  const accepted = [];
  const division = { name: "Agriculture", industry: "Agriculture", researchPoints, products: [] };
  const ns = {
    print: () => {},
    format: { number: n => String(n) },
    corporation: {
      getInvestmentOffer: () => ({ round, funds: offer }),
      getCorporation: () => ({ funds, divisions: [division.name], revenue, expenses, public: false }),
      getDivision: name => (name === division.name ? division : undefined),
      acceptInvestmentOffer: () => accepted.push(round),
    },
  };
  return { ns, accepted };
}

/** The save's frozen round-1 corp, wired for a full pass(). */
function frozenPass({ researchPoints = 703 } = {}) {
  reset();
  globalThis.gordCorpCheapestStep = 1.145e9;
  // Capacity and offices are BOTH still pending - the corp can't afford either -
  // so earlyRoundReady is false and only the rescue can move.
  globalThis.gordCorpExpandDone = false;
  globalThis.gordCorpOfficeDone = false;
  return fakeCorpNs({
    round: 1, offer: 4e9, funds: -1.036e9, revenue: 0, expenses: 3429, researchPoints,
  });
}

test("REGRESSION: a round-1 corp frozen at $0 revenue eventually sells its round", () => {
  const { ns, accepted } = frozenPass();

  investPass(ns);                       // first sighting: starts the dwell clock
  assert.deepEqual(accepted, [], "must not sell the round on first sight of a stall");

  globalThis.gordCorpStallSince = Date.now() - (GRACE + 1_000);
  investPass(ns);
  assert.deepEqual(accepted, [1], "past the grace period the round must be accepted");
  assert.equal(globalThis.gordCorpStallSince, undefined, "accepting must restart the clock");
});

test("the pass publishes the round and offer for the other phases either way", () => {
  const { ns } = frozenPass();
  investPass(ns);
  assert.equal(globalThis.gordCorpRound, 1);
  assert.equal(globalThis.gordCorpOffer, 4e9);
});

test("a healthy round-1 corp mid-buildout is left alone", () => {
  reset();
  globalThis.gordCorpCheapestStep = 1.145e9;
  const { ns, accepted } = fakeCorpNs({
    round: 1, offer: 4e9, funds: 50e9, revenue: 5e6, expenses: 1e6, researchPoints: 703,
  });
  investPass(ns);
  investPass(ns);
  assert.deepEqual(accepted, [], "it can still afford its next step - nothing to rescue");
});

// ── boostOrderTargets: capacity before boost materials ───────────────────────

const BOOSTS = { "Real Estate": 12000, Hardware: 0, Robots: 0, "AI Cores": 0 };

/** ns for boostOrderTargets: it only needs corpFunds() via affordable(). */
function fundsNs(funds) {
  return { corporation: { getCorporation: () => ({ funds, divisions: [] }) } };
}

function assertHeld(targets, why) {
  assert.deepEqual(Object.keys(targets).sort(), Object.keys(BOOSTS).sort(),
    "every material must still appear - a missing key leaves its order unreviewed");
  for (const [mat, units] of Object.entries(targets)) assert.equal(units, 0, `${mat}: ${why}`);
}

test("boosts stand aside while the buildout can afford its next capacity step", () => {
  reset();
  globalThis.gordCorpCheapestStep = 1.145e9; // next warehouse level
  const ns = fundsNs(50e9);                  // comfortably affordable
  for (const round of [1, 2]) assertHeld(boostOrderTargets(ns, BOOSTS, round), `round ${round}`);
});

test("boosts flow once capacity is out of reach - the money isn't going there anyway", () => {
  reset();
  globalThis.gordCorpCheapestStep = 1.145e9;
  assert.deepEqual(boostOrderTargets(fundsNs(0.2e9), BOOSTS, 1), BOOSTS);
});

test("boosts flow while banking for a division founding, so revenue can still grow", () => {
  reset();
  globalThis.gordCorpCheapestStep = 1.145e9;
  const ns = fundsNs(10e9); // the step alone is affordable...
  assertHeld(boostOrderTargets(ns, BOOSTS, 2), "no savings floor yet");
  globalThis.gordCorpSavingFor = 70e9; // ...until Chemical's founding is due
  assert.deepEqual(boostOrderTargets(ns, BOOSTS, 2), BOOSTS);
  globalThis.gordCorpSavingFor = undefined;
});

test("the capacity handshake opens boost ordering at the round's real optimum", () => {
  reset();
  globalThis.gordCorpExpandDone = true;
  assert.deepEqual(boostOrderTargets(fundsNs(50e9), BOOSTS, 1), BOOSTS);
});

test("past round 2 the capacity gate is gone - surplus is ordered on sight", () => {
  reset();
  globalThis.gordCorpCheapestStep = 1.145e9; // would HOLD boosts in rounds 1-2
  assert.deepEqual(boostOrderTargets(fundsNs(50e9), BOOSTS, CO.boostAfterBuildoutRound + 1), BOOSTS);
});

// Past round 2 the manual's debt allowance ends, and an unconditional order is a
// spender with no ceiling: a BN3 corp holding $3.4b went to -$17.3b in one pass
// when two warehouse levels enlarged its boost targets. That blocked the first
// product outright - its budget is a share of LIQUID funds - and pushed the city
// it was banking for from 15 minutes away to 1.2 hours. Rounds 1-2 are unaffected;
// finishing them in the red is the manual's own plan.
test("past round 2 boosts never dig the corp deeper into debt", () => {
  reset();
  const round = CO.boostAfterBuildoutRound + 1;
  assertHeld(boostOrderTargets(fundsNs(-17.281e9), BOOSTS, round), "already in debt");
  assertHeld(boostOrderTargets(fundsNs(0), BOOSTS, round),
    "at exactly $0 the whole pile would still be bought on credit");
});

test("past round 2 boosts queue behind the buildout objective, not ahead of it", () => {
  reset();
  const round = CO.boostAfterBuildoutRound + 1;
  const ns = fundsNs(3.406e9);
  assert.deepEqual(boostOrderTargets(ns, BOOSTS, round), BOOSTS, "surplus with nothing banked");
  globalThis.gordCorpSavingFor = 9e9; // Tobacco's next city
  assertHeld(boostOrderTargets(ns, BOOSTS, round), "banking for the product division's city");
  // ...and flow again once the corp is genuinely clear of reserve + objective.
  assert.deepEqual(boostOrderTargets(fundsNs(50e9), BOOSTS, round), BOOSTS);
  globalThis.gordCorpSavingFor = undefined;
});

test("before corp-expand has published a step, boosts hold - the conservative side", () => {
  reset();
  assert.equal(globalThis.gordCorpCheapestStep, undefined);
  assertHeld(boostOrderTargets(fundsNs(50e9), BOOSTS, 1), "no published step yet");
});

// ── The buildout objective: one lump at a time ───────────────────────────────
//
// The starvation this prevents: every corp spender is affordability-gated and
// drains to the 10% reserve each pass, so the CHEAPEST pending purchase always
// wins and anything dearer is unreachable at ANY income. The BN10 corp sat at 2
// of 6 cities, offices of 3 and 4, Advert 1 - all round-3 targets of 6, 9 and 10
// - because a $1.145b warehouse level was always affordable first and a ~$9b city
// never was. affordable() is where the queue is enforced, so it's tested here
// against the objective corp-expand publishes.

const CONSTANTS = { officeInitialCost: 4e9, warehouseInitialCost: 5e9 };

/** ns for pendingCityCost: a division holding `cities`, warehoused per `warehoused`. */
function cityNs(cities, warehoused = cities) {
  return {
    corporation: {
      getDivision: () => ({ cities }),
      getConstants: () => CONSTANTS,
      getWarehouse: (_d, city) => {
        if (!warehoused.includes(city)) throw new Error("no warehouse");
        return { level: 1 };
      },
    },
  };
}

test("the next city is priced as the whole indivisible office+warehouse lump", () => {
  const ns = cityNs(["Sector-12", "Aevum"]);
  assert.equal(
    pendingCityCost(ns, { name: "Agriculture" }),
    CONSTANTS.officeInitialCost + CONSTANTS.warehouseInitialCost,
    "an office without a warehouse produces nothing, so half a save is worse than none",
  );
});

test("a city we hold but never warehoused is the cheaper, higher-priority step", () => {
  const ns = cityNs(["Sector-12", "Aevum"], ["Sector-12"]);
  assert.equal(pendingCityCost(ns, { name: "Agriculture" }), CONSTANTS.warehouseInitialCost);
});

test("no objective once every city is held and warehoused", () => {
  const ns = cityNs([...CO.cities]);
  assert.equal(pendingCityCost(ns, { name: "Agriculture" }), 0);
});

test("an unreadable constant must not become the objective", () => {
  const ns = cityNs(["Sector-12"]);
  ns.corporation.getConstants = () => ({});
  assert.equal(pendingCityCost(ns, { name: "Agriculture" }), 0,
    "publishing Infinity as the floor would freeze every spend in the corp");
});

test("REGRESSION: a cheaper purchase cannot preempt the objective it would starve", () => {
  reset();
  const ns = fakeNs({ funds: 3.6e9, researchPoints: 2915 }); // just after a $3.2b round
  const warehouseLevel = 1.145e9;

  assert.equal(affordable(ns, warehouseLevel), true, "with nothing banked it just buys");

  globalThis.gordCorpSavingFor = 9e9; // the next city
  assert.equal(affordable(ns, warehouseLevel), false,
    "the $1.145b level must NOT eat the money the $9b city is banking");
  assert.equal(affordable(ns, 9e9, /* ignoreSaving */ true), false,
    "not yet affordable even for the objective itself - keep banking");
});

test("the objective spends the money banked for it once it lands", () => {
  reset();
  const ns = fakeNs({ funds: 10e9, researchPoints: 2915 });
  globalThis.gordCorpSavingFor = 9e9;
  assert.equal(affordable(ns, 9e9), false, "the floor blocks everything, itself included...");
  assert.equal(affordable(ns, 9e9, /* ignoreSaving */ true), true, "...which is what the exemption is for");
});

test("REGRESSION: an objective out of reach must not freeze the cheap things that fund it", () => {
  // Right after the $3.218b round-3 rescue lands: the next city is $9b, which at
  // +$7.414k/s is 9 days away. Banking for it would buy nothing for 9 days while
  // a $1.145b warehouse level - affordable now, and the thing that RAISES that
  // profit - sat unbought. The corp banks only for what it can reach.
  const funds = 3.67e9;
  const profit = BN10.revenue - BN10.expenses;
  const HORIZON = CO.savingHorizonSeconds;

  assert.ok(secondsToAfford(funds, 9e9, profit) > HORIZON,
    "a 9-day city is outside the horizon, so it must not become the objective");
  assert.ok(secondsToAfford(funds, 1.145e9, profit) <= HORIZON,
    "the warehouse level is already affordable, so nothing blocks it");

  // ...and once profit has grown enough to make the city reachable, it banks.
  assert.ok(secondsToAfford(funds, 9e9, 1e6) <= HORIZON,
    "at $1m/s the same city is inside the horizon - that is the route to it");
});
