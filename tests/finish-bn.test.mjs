// tests/finish-bn.test.mjs
// The finisher's two decisions (lib/finish-bn-logic.js): may it end the node,
// and what does the next node get entered with.
// Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { finishPermissionFrom, entryOptionsFor } from "../lib/finish-bn-logic.js";

const at = (currentNode, owned, bitNodeOptions = {}) => ({ currentNode, ownedSF: new Map(owned), bitNodeOptions });

test("finishPermissionFrom: the flag wins; unseeded, only home's file answers", () => {
  // The daemon has decided: the file is never consulted.
  assert.equal(finishPermissionFrom(true, "off", true), "on");
  assert.equal(finishPermissionFrom(false, "", true), "off");
  assert.equal(finishPermissionFrom(false, "", false), "off");
  // Not seeded, on home: the file is the truth, and no file means on.
  assert.equal(finishPermissionFrom(undefined, "", true), "on");
  assert.equal(finishPermissionFrom(undefined, "on\n", true), "on");
  assert.equal(finishPermissionFrom(undefined, " off \n", true), "off");
  // Not seeded, off home: an absent file is NO answer - wait, never finish.
  assert.equal(finishPermissionFrom(undefined, "", false), "unknown");
  assert.equal(finishPermissionFrom(undefined, "off", false), "off");
});

// After BN14.1, BN11.1 and BN8.1, finishing BN12.1: the shipped plan's next step
// is BN1's challenge run.
const OWNED = [[1, 3], [2, 1], [3, 3], [4, 3], [5, 3], [6, 1], [7, 3], [8, 1], [9, 3], [10, 3], [11, 1], [13, 1], [14, 1]];

test("entryOptionsFor: the challenge options (a Map of overrides) for exactly the planned challenge node", () => {
  const reset = at(12, OWNED);
  const options = entryOptionsFor(reset, 1, new Set());
  assert.equal(options.restrictHomePCUpgrade, true);
  assert.ok(options.sourceFileOverrides instanceof Map, "destroyW0r1dD43m0n insists on a Map");
  assert.deepEqual([...options.sourceFileOverrides], [[1, 3]]);
  // An explicit next node that is not the plan's own choice is entered plain.
  assert.equal(entryOptionsFor(reset, 9, new Set()), undefined);
  // Unknown achievements: the plan waits, so nothing is entered as a challenge.
  assert.equal(entryOptionsFor(reset, 1, null), undefined);
  // BN1's challenge held: the next challenge in line is BN10's.
  const next = entryOptionsFor(reset, 10, new Set(["CHALLENGE_BN1"]));
  assert.equal(next.disableSleeveExpAndAugmentation, true);
});

test("entryOptionsFor: a plain level step gets the game's defaults", () => {
  // Finishing BN14.1: the plan's next step is BN11.1, a plain run.
  const reset = at(14, OWNED.filter(([n]) => n !== 14 && n !== 11 && n !== 8));
  assert.equal(entryOptionsFor(reset, 11, new Set()), undefined);
});
