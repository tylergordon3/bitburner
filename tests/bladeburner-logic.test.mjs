// tests/bladeburner-logic.test.mjs
// Unit tests for the pure Bladeburner decision core. Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nextRestState,
  actionRate,
  chooseAction,
  levelStep,
  blackOpDecision,
  fallbackAction,
  chooseSkill,
  chooseCity,
  restAction,
  planSleeveBladeWork,
  plannedNodeAfterBlade,
  SLEEVE_TAKE_CONTRACTS,
  SLEEVE_INFILTRATE,
} from "../lib/bladeburner-logic.js";
import { CONFIG } from "../lib/config.js";

const REST = { restBelow: 0.55, resumeAbove: 0.95, hpRestBelow: 0.5 };

test("rest hysteresis: start below restBelow, stay until resumeAbove", () => {
  assert.equal(nextRestState(false, { stamina: 60, maxStamina: 100 }, REST), false);
  assert.equal(nextRestState(false, { stamina: 50, maxStamina: 100 }, REST), true);
  assert.equal(nextRestState(true, { stamina: 80, maxStamina: 100 }, REST), true);   // mid-band: keep resting
  assert.equal(nextRestState(true, { stamina: 96, maxStamina: 100 }, REST), false);
  assert.equal(nextRestState(false, { stamina: 80, maxStamina: 100 }, REST), false); // mid-band: keep working
});

test("low HP forces a rest even with full stamina", () => {
  assert.equal(nextRestState(false, { stamina: 100, maxStamina: 100, hpFrac: 0.3 }, REST), true);
  assert.equal(nextRestState(true, { stamina: 100, maxStamina: 100, hpFrac: 0.3 }, REST), true);
});

test("actionRate is chance x rank / time, 0 for a zero duration", () => {
  assert.equal(actionRate({ chanceMin: 0.5, rankGain: 10, timeMs: 1000 }), 0.005);
  assert.equal(actionRate({ chanceMin: 1, rankGain: 10, timeMs: 0 }), 0);
});

const cand = (name, over = {}) => ({
  type: "Contracts", name, chanceMin: 0.9, chanceMax: 0.95, rankGain: 1, timeMs: 10_000, count: 10, ...over,
});
const PICK = { minChance: 0.8, stickyMargin: 0.9 };

test("chooseAction takes the best expected rank rate among viable actions", () => {
  const { pick } = chooseAction([
    cand("Tracking", { rankGain: 1 }),
    cand("Retirement", { rankGain: 3 }),
    cand("Assassination", { type: "Operations", rankGain: 50, chanceMin: 0.5 }), // below the bar
    cand("Undercover Operation", { type: "Operations", rankGain: 50, count: 0 }), // out of attempts
  ], PICK);
  assert.equal(pick.name, "Retirement");
});

test("chooseAction keeps the running action within the sticky margin", () => {
  const list = [cand("Tracking", { rankGain: 1 }), cand("Bounty Hunter", { rankGain: 1.05 })];
  assert.equal(chooseAction(list, { ...PICK, current: { type: "Contracts", name: "Tracking" } }).pick.name, "Tracking");
  const far = [cand("Tracking", { rankGain: 1 }), cand("Bounty Hunter", { rankGain: 2 })];
  assert.equal(chooseAction(far, { ...PICK, current: { type: "Contracts", name: "Tracking" } }).pick.name, "Bounty Hunter");
});

test("chooseAction returns null when nothing clears the bar", () => {
  assert.equal(chooseAction([cand("Tracking", { chanceMin: 0.4 })], PICK).pick, null);
});

test("levelStep lowers a level under the bar, raises one above the raise bar", () => {
  const o = { minChance: 0.8, raiseChance: 0.95 };
  assert.equal(levelStep({ level: 5, maxLevel: 9, chanceMin: 0.6 }, o), 4);
  assert.equal(levelStep({ level: 1, maxLevel: 9, chanceMin: 0.6 }, o), null);  // floor
  assert.equal(levelStep({ level: 5, maxLevel: 9, chanceMin: 0.97 }, o), 6);
  assert.equal(levelStep({ level: 9, maxLevel: 9, chanceMin: 0.97 }, o), null); // not unlocked
  assert.equal(levelStep({ level: 5, maxLevel: 9, chanceMin: 0.85 }, o), null); // in the band
});

const BO = { minChance: 0.9 };
const boState = (over = {}) => ({ rank: 1000, chanceMin: 0.95, finishAllowed: false, finalName: "Operation Daedalus", ...over });

test("black op waits on rank, then chance", () => {
  const next = { name: "Operation Zero", rank: 2500 };
  assert.equal(blackOpDecision(next, boState(), BO).go, false);
  assert.equal(blackOpDecision(next, boState({ rank: 3000, chanceMin: 0.5 }), BO).go, false);
  assert.equal(blackOpDecision(next, boState({ rank: 3000 }), BO).go, true);
});

test("the final black op is held unless finishing is allowed", () => {
  const next = { name: "Operation Daedalus", rank: 400_000 };
  const held = blackOpDecision(next, boState({ rank: 500_000 }), BO);
  assert.equal(held.go, false);
  assert.equal(held.held, true);
  assert.equal(blackOpDecision(next, boState({ rank: 500_000, finishAllowed: true }), BO).go, true);
  // Not held while something else is the blocker - the hold is only reported when it's the LAST gate.
  assert.equal(blackOpDecision(next, boState({ rank: 10 }), BO).held, undefined);
});

test("no next black op means all done", () => {
  const d = blackOpDecision(null, boState(), BO);
  assert.equal(d.go, false);
  assert.equal(d.done, true);
});

const FB = { chaosDiplomacy: 50, analysisSpread: 0.1, inciteWhenExhausted: true };

test("fallback: diplomacy > incite > field analysis > training", () => {
  assert.equal(fallbackAction({ chaos: 80, exhausted: true, spread: 0.5 }, FB).name, "Diplomacy");
  assert.equal(fallbackAction({ chaos: 10, exhausted: true, spread: 0.5 }, FB).name, "Incite Violence");
  assert.equal(fallbackAction({ chaos: 10, exhausted: false, spread: 0.5 }, FB).name, "Field Analysis");
  assert.equal(fallbackAction({ chaos: null, exhausted: false, spread: 0 }, FB).name, "Training");
  assert.equal(fallbackAction({ chaos: 10, exhausted: true, spread: 0 }, { ...FB, inciteWhenExhausted: false }).name, "Training");
});

const RA = { hpRestBelow: 0.5, chaosDiplomacy: 50, analysisSpread: 0.1, recruitMinChance: 0.5 };
const rest = (over = {}) => ({ hpFrac: 1, chaos: 0, spread: 0, recruitChance: 1, ...over });

test("rest phases use no-stamina actions; the chamber only for HP", () => {
  assert.equal(restAction(rest({ hpFrac: 0.3, chaos: 90 }), RA).name, "Hyperbolic Regeneration Chamber");
  assert.equal(restAction(rest({ chaos: 90, spread: 0.5 }), RA).name, "Diplomacy");
  assert.equal(restAction(rest({ spread: 0.5 }), RA).name, "Field Analysis");
  assert.equal(restAction(rest(), RA).name, "Recruitment");
  assert.equal(restAction(rest({ recruitChance: 0.2 }), RA).name, "Field Analysis");
  assert.equal(restAction(rest({ chaos: null }), RA).name, "Recruitment"); // unknown chaos isn't high chaos
});

test("chooseSkill takes the lowest cost per weight it can afford", () => {
  const weights = { A: { weight: 3 }, B: { weight: 1 }, C: { weight: 1, cap: 2 } };
  const skills = [
    { name: "A", level: 0, cost: 6 },   // 2 per weight
    { name: "B", level: 0, cost: 3 },   // 3 per weight
    { name: "C", level: 2, cost: 1 },   // capped
    { name: "D", level: 0, cost: 1 },   // unweighted
  ];
  assert.equal(chooseSkill(skills, 10, weights).name, "A");
  assert.equal(chooseSkill(skills, 5, weights).name, "B");   // A unaffordable
  assert.equal(chooseSkill(skills, 2, weights), null);
  assert.equal(chooseSkill([{ name: "A", level: 90, cost: Infinity }], 1e9, weights), null); // game cap
});

test("chooseCity moves to a clearly more populous calm city only", () => {
  const cities = [
    { city: "Sector-12", population: 1e9, chaos: 0 },
    { city: "Aevum", population: 1.1e9, chaos: 0 },
    { city: "Volhaven", population: 2e9, chaos: 0 },
    { city: "Chongqing", population: 5e9, chaos: 90 },
  ];
  const o = { switchMargin: 0.2, maxChaos: 50 };
  assert.equal(chooseCity(cities, "Sector-12", o), "Volhaven");         // Chongqing too chaotic
  assert.equal(chooseCity(cities.slice(0, 2), "Sector-12", o), "Sector-12"); // +10% isn't worth it
  assert.equal(chooseCity(cities, "Chongqing", o), "Volhaven");         // leave a chaotic city
});

test("every configured skill and action list is well-formed", () => {
  const B = CONFIG.bladeburner;
  assert.ok(B.minChance < B.raiseChance, "level band must be non-empty or levels oscillate");
  assert.ok(B.restBelow < B.resumeAbove, "rest band must be non-empty");
  for (const [name, w] of Object.entries(B.skills)) assert.ok(w.weight >= 0, name);
  assert.ok(!B.operations.includes("Raid"), "Raid fails without Synthoid communities");
  // Under half of max stamina every action is penalised, so rest must start above it.
  assert.ok(B.restBelow > 0.5);
});

test("only the Bladeburner nodes boot into Bladeburner by default", async () => {
  const { forNode } = await import("../lib/config.js");
  assert.equal(forNode(6).bladeburner.enabled, true);
  assert.equal(forNode(7).bladeburner.enabled, true);
  assert.equal(forNode(4).bladeburner.enabled, false);
  assert.equal(forNode(6).bladeburner.minChance, CONFIG.bladeburner.minChance); // deep-merged, not replaced
});

// ── Sleeves ──────────────────────────────────────────────────────────────────

const SLEEVE_OPTS = { minChance: 0.8, maxContractSleeves: 3 };
const sl = (index, chances) => ({ index, chances });
const COUNTS = { Tracking: 10, "Bounty Hunter": 5, Retirement: 2 };

test("sleeves that clear the bar take contracts, the rest infiltrate", () => {
  const plan = planSleeveBladeWork(
    [sl(0, { Tracking: 0.9, "Bounty Hunter": 0.85, Retirement: 0.5 }), sl(1, { Tracking: 0.3 }), sl(2, { Tracking: 0.95 })],
    COUNTS,
    SLEEVE_OPTS,
  );
  // Deepest queue first (Tracking), to the best sleeve at it (#2); Bounty Hunter to #0.
  assert.deepEqual(plan.map(p => [p.index, p.action, p.contract ?? null]), [
    [0, SLEEVE_TAKE_CONTRACTS, "Bounty Hunter"],
    [1, SLEEVE_INFILTRATE, null],
    [2, SLEEVE_TAKE_CONTRACTS, "Tracking"],
  ]);
});

test("one sleeve per contract name, and at most maxContractSleeves", () => {
  const strong = { Tracking: 0.99, "Bounty Hunter": 0.99, Retirement: 0.99 };
  const plan = planSleeveBladeWork([sl(0, strong), sl(1, strong), sl(2, strong), sl(3, strong)], COUNTS, SLEEVE_OPTS);
  const contracts = plan.filter(p => p.action === SLEEVE_TAKE_CONTRACTS).map(p => p.contract);
  assert.equal(contracts.length, 3);
  assert.equal(new Set(contracts).size, 3);
  assert.equal(plan[3].action, SLEEVE_INFILTRATE);

  const one = planSleeveBladeWork([sl(0, strong), sl(1, strong)], COUNTS, { ...SLEEVE_OPTS, maxContractSleeves: 1 });
  assert.equal(one.filter(p => p.action === SLEEVE_TAKE_CONTRACTS).length, 1);
});

test("a sleeve keeps a still-viable contract; an exhausted one is dropped", () => {
  const strong = { Tracking: 0.99, "Bounty Hunter": 0.99, Retirement: 0.99 };
  const kept = planSleeveBladeWork([sl(0, strong), sl(1, strong)], COUNTS, { ...SLEEVE_OPTS, current: { 0: "Retirement" } });
  assert.equal(kept[0].contract, "Retirement"); // not re-shuffled onto the deeper Tracking queue
  assert.equal(kept[1].contract, "Tracking");

  const dropped = planSleeveBladeWork([sl(0, strong)], { ...COUNTS, Retirement: 0.4 }, { ...SLEEVE_OPTS, current: { 0: "Retirement" } });
  assert.equal(dropped[0].contract, "Tracking");
});

test("no attempts left anywhere: everyone infiltrates", () => {
  const strong = { Tracking: 0.99, "Bounty Hunter": 0.99, Retirement: 0.99 };
  const plan = planSleeveBladeWork([sl(0, strong), sl(1, strong)], { Tracking: 0, "Bounty Hunter": 0.5, Retirement: 0 }, SLEEVE_OPTS);
  assert.ok(plan.every(p => p.action === SLEEVE_INFILTRATE));
  assert.deepEqual(planSleeveBladeWork([], COUNTS, SLEEVE_OPTS), []);
});

// ── Finishing ────────────────────────────────────────────────────────────────

test("plannedNodeAfterBlade: an arg wins, else re-enter until the SF target, else halt", () => {
  assert.equal(plannedNodeAfterBlade({ override: 8, currentNode: 7, sfLevel: 0, reenterUntilSF: 3 }), 8);
  assert.equal(plannedNodeAfterBlade({ override: 0, currentNode: 7, sfLevel: 0, reenterUntilSF: 3 }), 0); // explicit halt
  // BN7 with reenterUntilSF 3: 7.1 and 7.2 re-enter, the run that awards 7.3 halts.
  assert.equal(plannedNodeAfterBlade({ override: null, currentNode: 7, sfLevel: 0, reenterUntilSF: 3 }), 7);
  assert.equal(plannedNodeAfterBlade({ override: null, currentNode: 7, sfLevel: 1, reenterUntilSF: 3 }), 7);
  assert.equal(plannedNodeAfterBlade({ override: null, currentNode: 7, sfLevel: 2, reenterUntilSF: 3 }), 0);
  // BN6 keeps the halt sentinel.
  assert.equal(plannedNodeAfterBlade({ override: null, currentNode: 6, sfLevel: 0, reenterUntilSF: 0 }), 0);
  assert.equal(plannedNodeAfterBlade({ override: undefined, currentNode: 6, sfLevel: 0, reenterUntilSF: 0 }), 0);
});

test("BN7 config: the same engine with Bladeburner's penalties priced in", async () => {
  const { forNode, BITNODE } = await import("../lib/config.js");
  const c7 = forNode(7);
  assert.equal(c7.paths.daemon, "/bn7/daemon.js");
  assert.equal(c7.bladeburner.reenterUntilSF, 3);
  assert.equal(forNode(6).bladeburner.reenterUntilSF, 0);
  // Skill points cost double: nothing goes to Datamancer, Tracer is capped.
  assert.equal(c7.bladeburner.skills["Datamancer"].weight, 0);
  assert.ok(c7.bladeburner.skills["Tracer"].cap <= 20);
  assert.ok(c7.bladeburner.skills["Blade's Intuition"].weight >= c7.bladeburner.skills["Hands of Midas"].weight);
  // The rest of the Bladeburner block is inherited, not replaced.
  assert.equal(c7.bladeburner.minChance, CONFIG.bladeburner.minChance);
  assert.deepEqual(c7.bladeburner.contracts, CONFIG.bladeburner.contracts);
  // Augs cost triple: installs batch bigger than the default.
  assert.ok(c7.augs.install.queuedThreshold > CONFIG.augs.install.queuedThreshold);
  // Sleeves work for the division on both Bladeburner nodes only.
  for (const n of [6, 7]) assert.ok(forNode(n).bladeburner.enabled && forNode(n).sleeves.blade.enabled);
  assert.equal(forNode(4).bladeburner.enabled, false);
  assert.ok(forNode(7).sleeves.blade.maxContractSleeves <= CONFIG.bladeburner.contracts.length);
  assert.equal(BITNODE[7].name, "Bladeburners 2079");
});
