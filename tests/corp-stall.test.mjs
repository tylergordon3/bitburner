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
import { secondsToAfford } from "../lib/corp-lib.js";

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

test("past round 2 the gate is gone - boosts are ordered regardless", () => {
  reset();
  globalThis.gordCorpCheapestStep = 1.145e9;
  assert.deepEqual(boostOrderTargets(fundsNs(50e9), BOOSTS, CO.boostAfterBuildoutRound + 1), BOOSTS);
});

test("before corp-expand has published a step, boosts hold - the conservative side", () => {
  reset();
  assert.equal(globalThis.gordCorpCheapestStep, undefined);
  assertHeld(boostOrderTargets(fundsNs(50e9), BOOSTS, 1), "no published step yet");
});
