// tests/finish-bn.test.mjs
// The finisher's two decisions (lib/finish-bn-logic.js): may it end the node,
// and what does the next node get entered with.
// Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { finishPermissionFrom, entryOptionsFor, entryLabel } from "../lib/finish-bn-logic.js";
import { CONFIG, isChallengeRun, forReset, forNode } from "../lib/config.js";
import { capabilitiesFromReset } from "../lib/capabilities.js";

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

// The 2026-10-25 position: finishing BN8.1. The shipped plan's next step is
// BN8's challenge run.
const OWNED = [[1, 3], [2, 1], [3, 3], [4, 3], [5, 3], [6, 1], [7, 3], [9, 3], [10, 3], [11, 1], [13, 1], [14, 1]];

test("entryOptionsFor: the challenge options (a Map of overrides) for exactly the planned challenge node", () => {
  const reset = at(8, OWNED);
  const options = entryOptionsFor(reset, 8, new Set());
  assert.equal(options.disable4SData, true);
  assert.ok(options.sourceFileOverrides instanceof Map, "destroyW0r1dD43m0n insists on a Map");
  assert.deepEqual([...options.sourceFileOverrides], [[1, 3]]);
  assert.equal(entryLabel(8, options), " (challenge run)");
  // An explicit next node that is not the plan's own choice is entered plain.
  assert.equal(entryOptionsFor(reset, 9, new Set()), undefined);
  // Unknown achievements: the plan waits, so nothing is entered as a challenge.
  assert.equal(entryOptionsFor(reset, 8, null), undefined);
  // Later on: with the BN13 challenge next, its marker-only options.
  const later = at(12, [...OWNED, [8, 2], [11, 3]], { sourceFileOverrides: new Map([[12, 0]]) });
  const held = /** @type {any} */ (new Set(["CHALLENGE_BN8"]));
  held.ownedSF = new Map([[12, 49]]);
  assert.deepEqual([...entryOptionsFor(later, 13, held).sourceFileOverrides], [[1, 3]]);
});

test("entryOptionsFor: a plain level step gets the game's defaults", () => {
  // Finishing BN8's challenge run: the plan's next step is BN11.2, a plain run.
  const reset = at(8, [...OWNED, [8, 1]], { disable4SData: true, sourceFileOverrides: new Map([[1, 3]]) });
  assert.equal(entryOptionsFor(reset, 11, new Set()), undefined);
  assert.equal(entryLabel(11, undefined), "");
});

test("entryOptionsFor: BN12 is always entered with Source-File 12 at campaign.recursionLevel", () => {
  assert.equal(CONFIG.campaign.recursionLevel, 0);
  // Finishing BN11.3 (SF12 not owned yet): BN12.1 needs no override.
  const first = at(11, [...OWNED, [8, 2], [11, 2]]);
  assert.equal(entryOptionsFor(first, 12, new Set(["CHALLENGE_BN8"])), undefined);
  // Finishing a BN12 run (it reports SF12 at its override): the next one too,
  // whatever the plan says, and even with the achievements unknown.
  const inBn12 = at(12, OWNED, { sourceFileOverrides: new Map([[12, 0]]) });
  for (const held of [null, new Set()]) {
    const options = entryOptionsFor(inBn12, 12, held);
    assert.ok(options.sourceFileOverrides instanceof Map);
    assert.deepEqual([...options.sourceFileOverrides], [[12, 0]]);
    assert.deepEqual(Object.keys(options), ["sourceFileOverrides"], "no challenge options ride along");
  }
  assert.equal(entryLabel(12, entryOptionsFor(inBn12, 12, null)), " (Source-File 12 at level 0 for the run)");
  // From another node with SF12 owned (e.g. an explicit `run bn13/daemon.js 12`).
  assert.deepEqual([...entryOptionsFor(at(13, [...OWNED, [12, 7]]), 12, new Set()).sourceFileOverrides], [[12, 0]]);
});

test("a BN12 run entered at SF12 0 is not a challenge run, and keeps BN12's own config", () => {
  const reset = at(12, OWNED, { sourceFileOverrides: new Map([[12, 0]]) });
  assert.equal(isChallengeRun(reset), false);
  assert.equal(forReset(reset), forNode(12));
  assert.equal(capabilitiesFromReset(reset).challenge, false);
});
