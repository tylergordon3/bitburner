// tests/blade-speed.test.mjs
// The 2026-10-25 Bladeburner speed fixes: Raid, the black-op bar priced by what
// a failure costs, skill points by marginal rank rate, no install in the
// finishing stretch, capped infiltration, the sleeves' karma ranking and their
// share of the roster during a gang bootstrap, and BN8's karma-free sleeves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BLACK_OPS,
  ACTION_DATA,
  blackOpBar,
  blackOpDecision,
  holdInstallForFinish,
  neverInstall,
  skillRateGain,
  chooseSkillMarginal,
  gateRaid,
  planSleeveBladeWork,
  SLEEVE_INFILTRATE,
  SLEEVE_GYM,
  SLEEVE_TAKE_CONTRACTS,
} from "../lib/bladeburner-logic.js";
import { crimeMinChanceFor, bladeSleeveCount } from "../lib/sleeves-logic.js";
import { pickBestCrime } from "../lib/crime-logic.js";
import { installReason } from "../lib/daemon-lib.js";
import { CONFIG, forNode } from "../lib/config.js";

const B = CONFIG.bladeburner;
const BAR = { minChance: B.blackOpMinChance, floor: B.blackOpFloor, lossHorizonMs: B.blackOpLossHorizonMs };
const perHour = rankPerHour => rankPerHour / 3_600_000;

test("the black-op table matches v3.0.1: 21 ops, rank gates rising, Daedalus at 400k", () => {
  assert.equal(BLACK_OPS.length, 21);
  assert.equal(BLACK_OPS[0].name, "Operation Typhoon");
  assert.equal(BLACK_OPS[20].name, "Operation Daedalus");
  assert.equal(BLACK_OPS[20].rank, 400_000);
  assert.equal(BLACK_OPS[19].loss, 20_000); // Vindictus
  for (let i = 1; i < BLACK_OPS.length; i++) assert.ok(BLACK_OPS[i].rank > BLACK_OPS[i - 1].rank);
  assert.equal(BLACK_OPS.at(-1).name, B.finalBlackOp);
});

test("REGRESSION: BN13's Typhoon at a real 40% is attempted (a flat 0.55 held it)", () => {
  // BN13 46.6h save: Assassination at level 6 pays ~38 rank per 119s.
  const rate = 38 / 119_000;
  const bar = blackOpBar("Operation Typhoon", rate, BAR);
  assert.equal(bar, B.blackOpFloor);
  const d = blackOpDecision({ name: "Operation Typhoon", rank: 2_500 },
    { rank: 9_331, chanceMin: 0.40, chanceMax: 0.40, finishAllowed: false, finalName: B.finalBlackOp }, { minChance: bar });
  assert.equal(d.go, true);
});

test("the bar rises with what a failure costs against the rank rate", () => {
  // BN15 late: ~5,000 rank an hour; Vindictus loses 20,000 unscaled rank.
  const vind = blackOpBar("Operation Vindictus", perHour(5_000), BAR);
  assert.ok(Math.abs(vind - 0.8) < 1e-9, String(vind));
  // Daedalus loses 10,000: 2/3 at the same rate, lower when rank comes faster.
  assert.ok(Math.abs(blackOpBar("Operation Daedalus", perHour(5_000), BAR) - 2 / 3) < 1e-9);
  assert.ok(blackOpBar("Operation Daedalus", perHour(50_000), BAR) < 0.2);
  // Capped short of certainty; unpriceable (no rate, unknown op) = the flat fallback.
  assert.ok(blackOpBar("Operation Vindictus", perHour(1), BAR) <= 0.95);
  assert.equal(blackOpBar("Operation Vindictus", 0, BAR), B.blackOpMinChance);
  assert.equal(blackOpBar("Operation Nobody", perHour(5_000), BAR), B.blackOpMinChance);
});

test("installs are held in the finishing stretch only when the bot will finish", () => {
  const o = { holdRank: B.installHoldRank, unlockedAhead: B.installHoldBlackOps };
  assert.equal(holdInstallForFinish({ rank: 200_000, done: 15, finishAllowed: false }, o), false);
  assert.equal(holdInstallForFinish({ rank: 200_000, done: 15, finishAllowed: true }, o), true);
  // Early: rank 9k, nothing done - Typhoon/Zero/X unlocked, so held; 6k is not.
  assert.equal(holdInstallForFinish({ rank: 9_000, done: 0, finishAllowed: true }, o), true);
  assert.equal(holdInstallForFinish({ rank: 6_000, done: 0, finishAllowed: true }, o), false);
  // Mid-node: 10 done (Tyrell next, 50k), rank 60k - Wallace (75k) not yet.
  assert.equal(holdInstallForFinish({ rank: 60_000, done: 10, finishAllowed: true }, o), false);
  assert.equal(holdInstallForFinish({ rank: 100_000, done: 10, finishAllowed: true }, o), true);
  assert.equal(holdInstallForFinish({ rank: 0, done: 21, finishAllowed: true }, o), true);
});

test("the held policy gives the core's installReason nothing to install for", () => {
  const policy = neverInstall(CONFIG.augs.install);
  const s = { queued: 40, redPillQueued: false, hasPriorityAug: true, allPriorityDone: true, elapsedMs: 1e12, favor: null };
  assert.equal(installReason(s, policy), null);
  assert.notEqual(installReason(s, CONFIG.augs.install), null);
  // The Red Pill would still go (never queued on these nodes).
  assert.equal(installReason({ ...s, redPillQueued: true }, policy), "red-pill");
  const daemon = readFileSync(new URL("../lib/blade-daemon.js", import.meta.url), "utf8");
  assert.match(daemon, /get augs\(\) \{ return d\.installPolicy\(cfg\.augs\); \}/);
});

test("Raid only in a calm city with known chaos", () => {
  const c = [{ name: "Raid" }, { name: "Assassination" }];
  assert.deepEqual(gateRaid(c, 10, B).map(x => x.name), ["Raid", "Assassination"]);
  assert.deepEqual(gateRaid(c, B.raidMaxChaos + 1, B).map(x => x.name), ["Assassination"]);
  assert.deepEqual(gateRaid(c, null, B).map(x => x.name), ["Assassination"]);
});

test("every configured contract and operation has skill-model data", () => {
  for (const n of [...B.contracts, ...B.operations]) assert.ok(ACTION_DATA[n], n);
});

const RC = { raiseChance: 0.95, sleevesCoverStamina: true };
const assassination = { name: "Assassination", level: 6, maxLevel: 14, chanceMin: 0.85 };

test("skill value: chance skills only for actions they apply to, nothing for money/exp", () => {
  assert.ok(skillRateGain("Cloak", 10, assassination, RC) > 0);
  assert.equal(skillRateGain("Tracer", 0, assassination, RC), 0);          // contracts only
  assert.equal(skillRateGain("Digital Observer", 0, { ...assassination, name: "Tracking" }, RC), 0);
  assert.equal(skillRateGain("Cloak", 0, { ...assassination, name: "Retirement" }, RC), 0);
  for (const s of ["Hands of Midas", "Hyperdrive", "Datamancer"]) assert.equal(skillRateGain(s, 0, assassination, RC), 0);
  // Cyber's Edge only while nothing else covers stamina; Overclock stops at 90.
  assert.equal(skillRateGain("Cyber's Edge", 0, assassination, RC), 0);
  assert.ok(skillRateGain("Cyber's Edge", 0, assassination, { ...RC, sleevesCoverStamina: false }) > 0);
  assert.equal(skillRateGain("Overclock", 90, assassination, RC), 0);
  // Overclock is worth more the higher it goes: 89 -> 90 cuts the time from
  // 11% to 10% of base, +10% attempts.
  assert.ok(Math.abs(skillRateGain("Overclock", 89, assassination, RC) - Math.log(1.1)) < 1e-12);
  // Level-bound (max level, chance capped): chance skills are nearly worthless.
  const capped = { ...assassination, level: 14, chanceMin: 0.99 };
  assert.ok(skillRateGain("Blade's Intuition", 10, capped, RC) < skillRateGain("Blade's Intuition", 10, assassination, RC) / 10);
});

test("marginal choice: most rank rate per point among allowed, affordable skills", () => {
  const w = forNode(14).bladeburner.skills;
  const skills = [
    { name: "Blade's Intuition", level: 39, cost: 170 },
    { name: "Cloak", level: 48, cost: 110 },
    { name: "Overclock", level: 59, cost: 171 },
    { name: "Hands of Midas", level: 0, cost: 1 },
    { name: "Hyperdrive", level: 0, cost: 1 },
  ];
  const pick = chooseSkillMarginal(skills, 1_000, w, { name: "Assassination", level: 22, maxLevel: 23, chanceMin: 0.85 }, RC);
  assert.ok(pick && !["Hands of Midas", "Hyperdrive"].includes(pick.name), pick?.name);
  // Nothing worth anything affordable: points wait.
  assert.equal(chooseSkillMarginal(skills.slice(3), 1_000, w, assassination, RC), null);
  // Weight 0 in the config: never bought, even at cost 1.
  assert.equal(w["Hands of Midas"].weight, 0);
  assert.equal(B.skillChoice, "marginal");
});

const SLEEVE_OPTS = { minChance: 0.8, maxContractSleeves: 3 };

test("at most maxInfiltrators sleeves infiltrate; the rest train", () => {
  const sleeves = [0, 1, 2, 3, 4, 5].map(index => ({ index, chances: { Tracking: index === 0 ? 0.9 : 0.1 } }));
  const plan = planSleeveBladeWork(sleeves, { Tracking: 10 }, { ...SLEEVE_OPTS, maxInfiltrators: 2 });
  assert.equal(plan.filter(p => p.action === SLEEVE_TAKE_CONTRACTS).length, 1);
  assert.equal(plan.filter(p => p.action === SLEEVE_INFILTRATE).length, 2);
  assert.equal(plan.filter(p => p.action === SLEEVE_GYM).length, 3);
  assert.equal(CONFIG.sleeves.blade.maxInfiltrators, 2);
});

test("REGRESSION: the karma bootstrap commits homicide at 39%, not a certain mug", () => {
  // BN13/BN14 rosters at str ~77: homicide ~39%, mug ~100%.
  const crimes = [
    { crime: "Homicide", chance: 0.39, karma: 3, money: 45_000, timeMs: 3_000 },
    { crime: "Mug", chance: 1, karma: 0.25, money: 36_000, timeMs: 4_000 },
  ];
  const S = CONFIG.sleeves;
  assert.equal(pickBestCrime(crimes, { metric: "karma", minChance: crimeMinChanceFor("karma", S) }).crime, "Homicide");
  // The old bar (crimeMinChance for every metric) left them mugging.
  assert.equal(pickBestCrime(crimes, { metric: "karma", minChance: S.crimeMinChance }).crime, "Mug");
  // Money keeps the gym-graduation bar.
  assert.equal(crimeMinChanceFor("money", S), S.crimeMinChance);
  assert.ok(S.karmaMinChance < 0.1);
});

test("during a gang bootstrap the first sleeves keep working for the division", () => {
  const o = { bladeUp: true, bootstrapSleeves: CONFIG.sleeves.blade.bootstrapSleeves };
  assert.equal(bladeSleeveCount("blade", 8, o), 8);
  assert.equal(bladeSleeveCount("gang", 8, o), 4);
  assert.equal(bladeSleeveCount("gang", 3, o), 3);
  assert.equal(bladeSleeveCount("gang", 8, { ...o, bladeUp: false }), 0);
  assert.equal(bladeSleeveCount("mirror", 8, o), 0);
});

test("BN8: no gang karma for the sleeves; every other node keeps it", () => {
  assert.equal(forNode(8).sleeves.gangKarma, false);
  assert.equal(forNode(2).sleeves.gangKarma, true);
  assert.equal(forNode(13).sleeves.gangKarma, true);
  const src = readFileSync(new URL("../lib/sleeves.js", import.meta.url), "utf8");
  assert.match(src, /ctx\.gangApi && ctx\.gangKarma && !inGangSafe\(ns\)/);
});
