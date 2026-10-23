// tests/sleeves-logic.test.mjs
// Unit tests for lib/sleeves-logic.js, the pure decisions behind lib/sleeves.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assignmentOrder, wantsAugRecovery, nextBatchCost, weakestPlayerStat } from "../lib/sleeves-logic.js";
import { CONFIG } from "../lib/config.js";

test("sleeves giving a contract up are reassigned first", () => {
  // Sleeve 5 holds Retirement; the plan moves it to sleeve 1.
  const plan = new Map([[1, { contract: "Retirement" }], [5, {}], [0, { contract: "Tracking" }]]);
  const order = assignmentOrder(6, { 0: "Tracking", 5: "Retirement" }, plan);
  assert.equal(order[0], 5);
  assert.deepEqual([...order].sort(), [0, 1, 2, 3, 4, 5]);
  // Nobody releasing (or no plan): index order.
  assert.deepEqual(assignmentOrder(3, { 0: "Tracking" }, new Map([[0, { contract: "Tracking" }]])), [0, 1, 2]);
  assert.deepEqual(assignmentOrder(3, {}, null), [0, 1, 2]);
});

const REC = { maxShock: 3, budget: 1e9, money: 6e10, minMoney: 10e6 };

test("REGRESSION: a little shock that blocks an affordable aug batch is recovered", () => {
  // BN14: sleeves 3 and 7 at shock ~0.9, 0 augs, never seen shock-free.
  assert.equal(wantsAugRecovery(0.94, REC), true);
  assert.equal(wantsAugRecovery(0.94, { ...REC, offersLeft: 33, batchCost: 5e8 }), true);
  // Not when nothing is left to buy, the batch is out of reach, or it's broke.
  assert.equal(wantsAugRecovery(0.94, { ...REC, offersLeft: 0 }), false);
  assert.equal(wantsAugRecovery(0.94, { ...REC, offersLeft: 5, batchCost: 5e9 }), false);
  assert.equal(wantsAugRecovery(0.94, { ...REC, money: 1e6 }), false);
  // No shock, or more than a short recovery's worth: not this rule's business.
  assert.equal(wantsAugRecovery(0, REC), false);
  assert.equal(wantsAugRecovery(40, REC), false);
  assert.ok(CONFIG.sleeves.blade.augShockBelow > 0.5, "one casualty's worth at least");
});

test("nextBatchCost: the batchMin cheapest, or all of them", () => {
  assert.equal(nextBatchCost([5, 1, 3, 2, 4], 4), 10);
  assert.equal(nextBatchCost([7, 3], 4), 10);
  assert.equal(nextBatchCost([], 4), 0);
});

test("the gym trains the player's weakest combat stat", () => {
  // BN14's player: agility 1,087 against 1,948-2,314.
  assert.equal(weakestPlayerStat({ strength: 2302, defense: 1948, dexterity: 2314, agility: 1087 }), "agi");
  assert.equal(weakestPlayerStat({ strength: 10, defense: 20, dexterity: 30, agility: 40 }), "str");
  assert.ok(CONFIG.sleeves.gymStats.includes(weakestPlayerStat({ strength: 5, defense: 1, dexterity: 5, agility: 5 })));
});
