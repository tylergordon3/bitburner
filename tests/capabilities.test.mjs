// tests/capabilities.test.mjs
// Unit tests for the pure capability helpers. Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sourceFileLevel,
  hasApiAccess,
  singularityRamMultiplier,
  capabilitiesFromReset,
} from "../lib/capabilities.js";

test("sourceFileLevel reads a Map (the current API shape)", () => {
  const reset = { ownedSF: new Map([[4, 3], [10, 1]]) };
  assert.equal(sourceFileLevel(reset, 4), 3);
  assert.equal(sourceFileLevel(reset, 10), 1);
  assert.equal(sourceFileLevel(reset, 2), 0);
});

test("sourceFileLevel tolerates array + object fallbacks", () => {
  assert.equal(sourceFileLevel({ ownedSF: [[4, 2]] }, 4), 2);
  assert.equal(sourceFileLevel({ ownedSF: [{ n: 3, lvl: 1 }] }, 3), 1);
  assert.equal(sourceFileLevel({ ownedSF: { 6: 2 } }, 6), 2);
  assert.equal(sourceFileLevel({}, 4), 0);
});

test("hasApiAccess is true in-node or when the SF is owned", () => {
  assert.equal(hasApiAccess({ currentNode: 4, ownedSF: new Map() }, [4], [4]), true); // in BN4
  assert.equal(hasApiAccess({ currentNode: 1, ownedSF: new Map([[4, 1]]) }, [4], [4]), true); // owns SF4
  assert.equal(hasApiAccess({ currentNode: 1, ownedSF: new Map() }, [4], [4]), false);
  // Bladeburner: either of two nodes/SFs qualifies.
  assert.equal(hasApiAccess({ currentNode: 7, ownedSF: new Map() }, [6, 7], [6, 7]), true);
});

test("singularityRamMultiplier follows SF4 level", () => {
  assert.equal(singularityRamMultiplier({ currentNode: 1, ownedSF: new Map([[4, 3]]) }), 1);
  assert.equal(singularityRamMultiplier({ currentNode: 1, ownedSF: new Map([[4, 2]]) }), 4);
  assert.equal(singularityRamMultiplier({ currentNode: 1, ownedSF: new Map([[4, 1]]) }), 16);
  // Inside BN4 it is 1x whatever the SF level (RamCostGenerator.ts SF4Cost).
  assert.equal(singularityRamMultiplier({ currentNode: 4, ownedSF: new Map() }), 1);
  assert.equal(singularityRamMultiplier({ currentNode: 4, ownedSF: new Map([[4, 1]]) }), 1);
  assert.equal(singularityRamMultiplier({ currentNode: 1, ownedSF: new Map() }), Infinity); // unavailable
});

test("capabilitiesFromReset exposes booleans + accessors", () => {
  const caps = capabilitiesFromReset({ currentNode: 10, ownedSF: new Map([[4, 3]]) });
  assert.equal(caps.currentNode, 10);
  assert.equal(caps.sleeves, true);     // in BN10
  assert.equal(caps.grafting, true);    // SF10-gated, in BN10
  assert.equal(caps.singularity, true); // owns SF4
  assert.equal(caps.gang, false);
  assert.equal(caps.singularityRamMultiplier, 1);
  assert.equal(caps.sourceFileLevel(4), 3);
});
