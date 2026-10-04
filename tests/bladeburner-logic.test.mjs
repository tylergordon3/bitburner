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
  spendableSkillPoints,
  chooseCity,
  restAction,
  planSleeveBladeWork,
  SLEEVE_TAKE_CONTRACTS,
  SLEEVE_INFILTRATE,
  SLEEVE_DIPLOMACY,
  SLEEVE_SUPPORT,
  REGEN_CHAMBER,
  nextSleeveRegenState,
  nextSleeveSupportState,
  conservePopulation,
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

test("rest phases without restInChamber use no-stamina actions; the chamber only for HP", () => {
  assert.equal(restAction(rest({ hpFrac: 0.3, chaos: 90 }), RA).name, "Hyperbolic Regeneration Chamber");
  assert.equal(restAction(rest({ chaos: 90, spread: 0.5 }), RA).name, "Diplomacy");
  assert.equal(restAction(rest({ spread: 0.5 }), RA).name, "Field Analysis");
  assert.equal(restAction(rest(), RA).name, "Recruitment");
  assert.equal(restAction(rest({ recruitChance: 0.2 }), RA).name, "Field Analysis");
  assert.equal(restAction(rest({ chaos: null }), RA).name, "Recruitment"); // unknown chaos isn't high chaos
});

test("restInChamber: the chamber is the default rest, after chaos and loose estimates", () => {
  const o = { ...RA, restInChamber: true };
  assert.equal(restAction(rest(), o).name, REGEN_CHAMBER);
  assert.equal(restAction(rest({ recruitChance: 0.2 }), o).name, REGEN_CHAMBER);
  assert.equal(restAction(rest({ chaos: 90 }), o).name, "Diplomacy");
  assert.equal(restAction(rest({ spread: 0.5 }), o).name, "Field Analysis");
});

test("Incite Violence is off by default: it raises chaos in every city", () => {
  assert.equal(CONFIG.bladeburner.inciteWhenExhausted, false);
  assert.equal(fallbackAction({ chaos: 10, exhausted: true, spread: 0 }, CONFIG.bladeburner).name, "Training");
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

test("spendableSkillPoints: a configured bank is kept once the black ops are settled", () => {
  // No bank configured (the default): every point is spendable, as before.
  assert.equal(spendableSkillPoints(500, undefined, true), 500);
  assert.equal(spendableSkillPoints(500, 0, true), 500);
  // A bank, but a black op still needs skills: nothing is held back.
  assert.equal(spendableSkillPoints(500, 100_000, false), 500);
  // Settled: the first 100,000 stay unspent (the achievement reads skillPoints
  // >= 100000), anything above is spent as usual.
  assert.equal(spendableSkillPoints(500, 100_000, true), 0);
  assert.equal(spendableSkillPoints(100_250, 100_000, true), 250);
  const weights = { A: { weight: 1 } };
  assert.equal(chooseSkill([{ name: "A", level: 0, cost: 3 }], spendableSkillPoints(90_000, 100_000, true), weights), null);
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

test("REGRESSION: the helpers resolve their knobs per node, so BN7's skill weights apply", async () => {
  const { forNode } = await import("../lib/config.js");
  const { readFileSync } = await import("node:fs");
  // BITNODE[7] really does differ from the defaults the helpers used to read...
  assert.notEqual(forNode(7).bladeburner.skills.Datamancer.weight, CONFIG.bladeburner.skills.Datamancer.weight);
  assert.equal(forNode(7).bladeburner.skills.Datamancer.weight, 0);
  assert.equal(forNode(7).bladeburner.skills.Tracer.cap, 10);
  // ...so both helpers must call forNode() on the node the daemon passes them,
  // and the daemon must pass it.
  const read = f => readFileSync(new URL(`../lib/${f}`, import.meta.url), "utf8");
  for (const f of ["bladeburner.js", "blade-upkeep.js"]) {
    assert.match(read(f), /B = forNode\(Number\(ns\.args\[0\] \?\? 0\)\)\.bladeburner/, f);
  }
  const daemon = read("blade-daemon.js");
  assert.match(daemon, /script: cfg\.paths\.bladeburner, optional: false, args: \[node\]/);
  assert.match(daemon, /script: cfg\.paths\.bladeUpkeep, optional: true, args: \[node\]/);
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

test("sleeves off contracts support the division: diplomacy first, then the player's stamina", () => {
  const sleeves = [sl(0, { Tracking: 0.95 }), sl(1, { Tracking: 0.1 }), sl(2, { Tracking: 0.1 })];
  const jobs = o => planSleeveBladeWork(sleeves, COUNTS, { ...SLEEVE_OPTS, ...o }).map(p => p.action);

  // The contract sleeve keeps earning rank either way.
  assert.deepEqual(jobs({ regen: true }), [SLEEVE_TAKE_CONTRACTS, REGEN_CHAMBER, REGEN_CHAMBER]);
  assert.deepEqual(jobs({ diplomacy: true }), [SLEEVE_TAKE_CONTRACTS, SLEEVE_DIPLOMACY, SLEEVE_DIPLOMACY]);
  // Chaos penalises every action, so it outranks stamina.
  assert.deepEqual(jobs({ diplomacy: true, regen: true }), [SLEEVE_TAKE_CONTRACTS, SLEEVE_DIPLOMACY, SLEEVE_DIPLOMACY]);
  assert.deepEqual(jobs({}), [SLEEVE_TAKE_CONTRACTS, SLEEVE_INFILTRATE, SLEEVE_INFILTRATE]);
});

test("support: the whole roster joins the team, contracts included", () => {
  const strong = { Tracking: 0.99, "Bounty Hunter": 0.99, Retirement: 0.99 };
  const plan = planSleeveBladeWork([sl(0, strong), sl(1, {})], COUNTS, { ...SLEEVE_OPTS, support: true, regen: true, diplomacy: true });
  assert.deepEqual(plan.map(p => p.action), [SLEEVE_SUPPORT, SLEEVE_SUPPORT]);
});

const SUP = { minChance: 0.9, graceMs: 45_000, cooldownMs: 600_000 };
const OFF = { on: false, since: 0, cooldownUntil: 0 };
const sup = (over = {}) => ({ now: 1_000_000, eligible: true, running: false, chance: 0.85, humanTeam: 0, sleeves: 6, ...over });

test("sleeve support joins only when the team bonus carries the black op over its bar", () => {
  // 0.85 * 7^0.05 = 0.937: worth joining. 0.7 * 1.102 = 0.77: not.
  assert.equal(nextSleeveSupportState(OFF, sup(), SUP).on, true);
  assert.equal(nextSleeveSupportState(OFF, sup({ chance: 0.7 }), SUP).on, false);
  // An existing team dilutes the bonus: (10+6+1)/(10+1) ^ 0.05 = 1.022.
  assert.equal(nextSleeveSupportState(OFF, sup({ humanTeam: 10 }), SUP).on, false);
  assert.equal(nextSleeveSupportState(OFF, sup({ humanTeam: 10, chance: 0.89 }), SUP).on, true);
  // Not while the op isn't on the table (rank short, held, the player resting).
  assert.equal(nextSleeveSupportState(OFF, sup({ eligible: false, chance: 1 }), SUP).on, false);
  assert.equal(nextSleeveSupportState(OFF, sup({ sleeves: 0, chance: 1 }), SUP).on, false);
});

test("sleeve support holds through the op, and stands down with a cooldown when the bar isn't met", () => {
  const on = { on: true, since: 1_000_000, cooldownUntil: 0 };
  // Within the grace period the op's team size may not be set yet.
  assert.equal(nextSleeveSupportState(on, sup({ now: 1_010_000, chance: 0.85 }), SUP).on, true);
  // Bar met: stay until it runs; running: stay whatever else changed.
  assert.equal(nextSleeveSupportState(on, sup({ now: 1_100_000, chance: 0.93 }), SUP).on, true);
  assert.equal(nextSleeveSupportState(on, sup({ now: 1_100_000, running: true, eligible: false, chance: 0 }), SUP).on, true);
  // Grace over and still short: stand down, and don't flap straight back on.
  const down = nextSleeveSupportState(on, sup({ now: 1_100_000, chance: 0.85 }), SUP);
  assert.equal(down.on, false);
  assert.equal(down.cooldownUntil, 1_700_000);
  assert.equal(nextSleeveSupportState(down, sup({ now: 1_200_000 }), SUP).on, false);
  assert.equal(nextSleeveSupportState(down, sup({ now: 1_800_000 }), SUP).on, true);
  // The op finished (no longer eligible): back to work.
  assert.equal(nextSleeveSupportState(on, sup({ eligible: false }), SUP).on, false);
});

test("population-spending operations only run above the floor", () => {
  const o = { populationOps: ["Sting Operation", "Stealth Retirement Operation"], populationFloor: 1e9 };
  const c = ["Tracking", "Sting Operation", "Stealth Retirement Operation", "Assassination"].map(name => ({ name }));
  assert.equal(conservePopulation(c, 1.4e9, o).length, 4);
  assert.deepEqual(conservePopulation(c, 0.9e9, o).map(x => x.name), ["Tracking", "Assassination"]);
  assert.equal(conservePopulation(c, null, o).length, 4); // unknown population filters nothing
  for (const name of CONFIG.bladeburner.populationOps) assert.ok(CONFIG.bladeburner.operations.includes(name), name);
});

test("sleeve regen hysteresis: on below regenBelow, off above regenAbove", () => {
  const o = { regenBelow: 0.75, regenAbove: 0.95 };
  assert.equal(nextSleeveRegenState(false, 0.8, o), false);
  assert.equal(nextSleeveRegenState(false, 0.7, o), true);
  assert.equal(nextSleeveRegenState(true, 0.9, o), true);   // holds through the band
  assert.equal(nextSleeveRegenState(true, 0.96, o), false);
  // The sleeves must step in before the player's own rest phase would start.
  assert.ok(CONFIG.sleeves.blade.regenBelow > CONFIG.bladeburner.restBelow);
  assert.ok(CONFIG.sleeves.blade.regenBelow < CONFIG.sleeves.blade.regenAbove);
});

test("BN7 config: the same engine with Bladeburner's penalties priced in", async () => {
  const { forNode, BITNODE } = await import("../lib/config.js");
  const c7 = forNode(7);
  assert.equal(c7.paths.daemon, "/bn7/daemon.js");
  // Three runs of BN7 (for SF7.3's free Simulacrum) are the campaign's doing now.
  assert.ok(c7.campaign.order.some(([node, level]) => node === 7 && level === 3));
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
