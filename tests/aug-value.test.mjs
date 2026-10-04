// tests/aug-value.test.mjs
// Which aug to work toward (lib/aug-value.js), and its wiring into
// lib/aug-targets.js getAllAugCandidates.
// Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { augValue, planningRepRate, rankCandidates, candidateKey } from "../lib/aug-value.js";
import { getAllAugCandidates, holdAugTarget } from "../lib/aug-targets.js";
import { CONFIG, forNode } from "../lib/config.js";

const V = CONFIG.augs.value;
const V7 = forNode(7).augs.value;

// ── Value ────────────────────────────────────────────────────────────────────

test("augValue: weighted log of the multipliers, per node", () => {
  const hack = { hacking: 1.1, hacking_exp: 1.2 };
  const combat = { strength: 1.2, defense: 1.2, dexterity: 1.2, agility: 1.2 };
  // On a hacking node the hacking aug is worth more than twice the combat one...
  assert.ok(augValue("h", hack, V) > 2 * augValue("c", combat, V));
  // ...and on a Bladeburner node it is the other way round.
  assert.ok(augValue("c", combat, V7) > 3 * augValue("h", hack, V7));
  // A multiplier compounds, so two x1.1 are worth one x1.21.
  const once = augValue("a", { hacking: 1.21 }, V) - V.base;
  const twice = 2 * (augValue("a", { hacking: 1.1 }, V) - V.base);
  assert.ok(Math.abs(once - twice) < 1e-9);
});

test("augValue: cost multipliers count when they go DOWN, and nothing is worth less than base", () => {
  const V9 = forNode(9).augs.value;
  assert.ok(augValue("a", { hacknet_node_purchase_cost: 0.85 }, V9) > V9.base);
  assert.equal(augValue("a", {}, V), V.base);
  assert.equal(augValue("a", null, V), V.base);
  // A stat this node gives no weight to adds nothing.
  assert.equal(augValue("a", { bladeburner_success_chance: 1.05 }, V), V.base);
});

test("augValue: the specials are per node too", () => {
  assert.ok(augValue("The Red Pill", {}, V) > 1);
  assert.equal(augValue("The Red Pill", {}, V7), V7.base, "BN7 ends on a black op, not the world daemon");
  assert.ok(augValue("The Blade's Simulacrum", {}, V7) > 1);
  assert.equal(augValue("The Blade's Simulacrum", {}, V), V.base);
});

test("every weight names a real multiplier, and the node overlays keep the rest", () => {
  const known = new Set([
    "hacking", "hacking_exp", "hacking_speed", "hacking_money", "hacking_grow", "hacking_chance",
    "strength", "defense", "dexterity", "agility", "charisma",
    "strength_exp", "defense_exp", "dexterity_exp", "agility_exp", "charisma_exp",
    "faction_rep", "company_rep", "crime_money", "crime_success", "work_money",
    "hacknet_node_money", "hacknet_node_purchase_cost", "hacknet_node_level_cost",
    "hacknet_node_ram_cost", "hacknet_node_core_cost",
    "bladeburner_success_chance", "bladeburner_max_stamina", "bladeburner_stamina_gain", "bladeburner_analysis",
  ]);
  for (const node of [0, 2, 6, 7, 9]) {
    const w = forNode(node).augs.value.weights;
    for (const key of Object.keys(w)) assert.ok(known.has(key), `BN${node}: ${key}`);
    // An overlay replaces single keys; it must not drop the others.
    assert.equal(Object.keys(w).length, known.size, `BN${node} lost weights`);
  }
  assert.equal(forNode(6).augs.value.weights.strength, 1);
  assert.equal(forNode(7).augs.install.minQueued, 4, "the value overlay left BN7's install policy alone");
});

// ── Planning rate ────────────────────────────────────────────────────────────

test("planningRepRate: measured, else another faction's rate scaled by favor, else nominal", () => {
  assert.equal(planningRepRate({ measured: 5, favor: 0, ref: { rate: 1, favor: 0 }, assumed: 9 }), 5);
  // 50 favor here vs 0 there: +50%.
  assert.equal(planningRepRate({ measured: 0, favor: 50, ref: { rate: 2, favor: 0 }, assumed: 9 }), 3);
  // The reference's own favor is divided back out.
  assert.equal(planningRepRate({ measured: 0, favor: 0, ref: { rate: 3, favor: 100 }, assumed: 9 }), 1.5);
  assert.equal(planningRepRate({ measured: 0, favor: 100, ref: null, assumed: 0.5 }), 1);
});

// ── Ranking ──────────────────────────────────────────────────────────────────

const cand = (faction, aug, value, repReq, repMissing, o = {}) => ({
  faction, aug, value, repReq, repMissing,
  moneyMissing: o.moneyMissing ?? 0, price: o.price ?? 1e6,
  canBuy: repMissing <= 0 && !(o.moneyMissing > 0), priorityIndex: o.priorityIndex ?? 0,
});
const RANK = { repRate: () => 1, incomePerMs: 1, floorMs: 600, stickiness: 0 };
const order = list => list.map(c => c.aug);

test("REGRESSION: a near trinket no longer outranks the aug that matters", () => {
  // Soonest-ETA picked the trinket (100 rep away against 2,000).
  const list = [
    cand("A", "trinket", 0.03, 100, 100),
    cand("B", "engine", 0.6, 2000, 2000),
  ];
  assert.deepEqual(order(rankCandidates(list, RANK)), ["engine", "trinket"]);
  // ...but value does not make distance irrelevant: far enough away, the near one wins.
  const far = [cand("A", "trinket", 0.03, 100, 100), cand("B", "engine", 0.6, 1e6, 1e6)];
  assert.deepEqual(order(rankCandidates(far, RANK)), ["trinket", "engine"]);
});

test("a faction is scored on everything its reputation unlocks on the way", () => {
  // One aug worth 0.5 at 3,000 rep, against a faction whose 3,000 rep delivers
  // three augs worth 0.3 each: the bundle wins though no single aug in it does.
  const list = [
    cand("Solo", "big", 0.5, 3000, 3000),
    cand("Many", "m1", 0.3, 1000, 1000),
    cand("Many", "m2", 0.3, 2000, 2000),
    cand("Many", "m3", 0.3, 3000, 3000),
  ];
  rankCandidates(list, RANK);
  assert.equal(list[0].faction, "Many");
  const m3 = list.find(c => c.aug === "m3");
  assert.ok(Math.abs(m3.bundleValue - 0.9) < 1e-9);
  assert.equal(list.find(c => c.aug === "big").bundleValue, 0.5);
});

test("buyable augs lead; unknown waits score zero and fall back to the static order", () => {
  const list = [
    cand("A", "needsCash", 5, 0, 0, { moneyMissing: 1e9, priorityIndex: 3 }),
    cand("B", "alsoCash", 5, 0, 0, { moneyMissing: 1e9, priorityIndex: 1 }),
    cand("C", "ready", 0.01, 0, 0),
    cand("D", "grind", 0.1, 500, 500),
  ];
  // No income measured: the money-gated ones are an unknown wait.
  rankCandidates(list, { ...RANK, incomePerMs: 0 });
  assert.deepEqual(order(list), ["ready", "grind", "alsoCash", "needsCash"]);
  assert.equal(list[2].score, 0);
  assert.equal(list[0].rankMs, 0);
});

test("stickiness: the incumbent survives a rival that is only slightly better", () => {
  const make = () => [cand("A", "held", 1.0, 1000, 1000), cand("B", "rival", 1.1, 1000, 1000)];
  assert.equal(rankCandidates(make(), RANK)[0].aug, "rival");
  const held = new Set([candidateKey({ faction: "A", aug: "held" })]);
  assert.equal(rankCandidates(make(), { ...RANK, stickiness: 0.25, incumbents: held })[0].aug, "held");
  // A clearly better rival still takes over.
  const clear = [cand("A", "held", 1.0, 1000, 1000), cand("B", "rival", 2.0, 1000, 1000)];
  assert.equal(rankCandidates(clear, { ...RANK, stickiness: 0.25, incumbents: held })[0].aug, "rival");
});

// ── Wiring: getAllAugCandidates ──────────────────────────────────────────────

/** A world with two factions, each selling one aug at the same reputation. */
function fakeNs(node) {
  const augs = {
    Hackers: { "Brain Jack": { rep: 50_000, price: 1e6 } },
    Fighters: { "Iron Arm": { rep: 50_000, price: 1e6 } },
  };
  const all = Object.assign({}, ...Object.values(augs));
  return /** @type {any} */ ({
    getResetInfo: () => ({ currentNode: node }),
    getPlayer: () => ({ factions: Object.keys(augs), money: 1e9 }),
    singularity: {
      getOwnedAugmentations: () => [],
      getFactionRep: () => 0,
      getFactionFavor: () => 0,
      getAugmentationsFromFaction: f => Object.keys(augs[f] ?? {}),
      getAugmentationPrereq: () => [],
      getAugmentationRepReq: a => all[a].rep,
      getAugmentationPrice: a => all[a].price,
    },
  });
}

function withGlobals(fn) {
  const keys = ["gordAugStats", "gordAugHolds", "_repSnaps", "_incomeSnap", "_incomeRatePerMs"];
  const saved = Object.fromEntries(keys.map(k => [k, globalThis[k]]));
  for (const k of keys) delete globalThis[k];
  try { fn(); }
  finally { for (const k of keys) { if (saved[k] === undefined) delete globalThis[k]; else globalThis[k] = saved[k]; } }
}

const STATS = {
  "Brain Jack": { hacking: 1.15, hacking_speed: 1.05 },
  "Iron Arm": { strength: 1.3, defense: 1.3 },
};

test("the same two augs are targeted in opposite order on a hacking node and in BN7", () => {
  withGlobals(() => {
    globalThis.gordAugStats = { stats: STATS, count: 2, updatedAt: Date.now() };
    assert.equal(getAllAugCandidates(fakeNs(4))[0].aug, "Brain Jack");
    delete globalThis.gordAugHolds; // a fresh run: no incumbent from the BN4 pass
    assert.equal(getAllAugCandidates(fakeNs(7))[0].aug, "Iron Arm");
  });
});

test("without the stat table every aug is worth the same, and the measured ETA field is untouched", () => {
  withGlobals(() => {
    const list = getAllAugCandidates(fakeNs(7));
    assert.deepEqual(list.map(c => c.value), [1, 1]);
    // No rate was ever measured: the HUD's ETA stays unknown, the ranking still has a number.
    assert.ok(list.every(c => c.estimatedMs === Infinity));
    assert.ok(list.every(c => Number.isFinite(c.rankMs) && c.rankMs > 0));
    // An empty table (the helper could read nothing) is the same as none.
    globalThis.gordAugStats = { stats: {}, count: 0, updatedAt: Date.now() };
    assert.deepEqual(getAllAugCandidates(fakeNs(7)).map(c => c.value), [1, 1]);
  });
});

test("the target is remembered, and a daemon can hold a second one", () => {
  withGlobals(() => {
    globalThis.gordAugStats = { stats: STATS, count: 2, updatedAt: Date.now() };
    getAllAugCandidates(fakeNs(4));
    assert.equal(globalThis.gordAugHolds.top, "Hackers|Brain Jack");
    holdAugTarget("rep", { faction: "Fighters", aug: "Iron Arm" });
    assert.equal(globalThis.gordAugHolds.rep, "Fighters|Iron Arm");
    assert.equal(globalThis.gordAugHolds.top, "Hackers|Brain Jack");
    holdAugTarget("rep", null);
    assert.equal(globalThis.gordAugHolds.rep, null);
  });
});

test("a faction's last positive rate outlives the slot moving elsewhere", () => {
  withGlobals(() => {
    // Fighters was worked for earlier (rate now 0, lastRate kept); Hackers never.
    globalThis._repSnaps = {
      Fighters: { time: Date.now(), rep: 0, rate: 0, lastRate: 10, rateAt: Date.now() - 60_000 },
    };
    const list = getAllAugCandidates(fakeNs(7));
    const by = Object.fromEntries(list.map(c => [c.faction, c]));
    assert.equal(by.Fighters.rankMs, 5_000);
    // The unmeasured faction borrows that rate (equal favor), not the nominal one.
    assert.equal(by.Hackers.rankMs, 5_000);
  });
});
