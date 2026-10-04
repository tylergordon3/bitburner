// tests/capabilities.test.mjs
// Unit tests for the pure capability helpers. Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sourceFileLevel,
  hasApiAccess,
  singularityRamMultiplier,
  capabilitiesFromReset,
  campaignNext,
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

// ── The campaign plan ────────────────────────────────────────────────────────

const ORDER = /** @type {[number, number][]} */ ([[7, 3], [14, 1], [9, 3]]);
const at = (currentNode, owned) => ({ currentNode, ownedSF: new Map(owned) });

test("campaignNext: the run being finished counts toward its own step", () => {
  // In BN7 holding SF7.1: this run awards 7.2, still short of 3 - go round again.
  assert.equal(campaignNext(at(7, [[7, 1]]), ORDER), 7);
  // Holding 7.2: this run awards 7.3, the step is done - on to BN14.
  assert.equal(campaignNext(at(7, [[7, 2]]), ORDER), 14);
  // A first run of a node (no Source-File yet) awards level 1.
  assert.equal(campaignNext(at(14, [[7, 3]]), ORDER), 9);
  assert.equal(campaignNext(at(9, [[7, 3], [14, 1], [9, 1]]), ORDER), 9);
  assert.equal(campaignNext(at(9, [[7, 3], [14, 1], [9, 2]]), ORDER), 0);
});

test("campaignNext: a node off the plan joins it at the first unmet step", () => {
  // Finishing BN5 says nothing about SF7: BN7 is still two levels short.
  assert.equal(campaignNext(at(5, [[5, 1], [7, 1]]), ORDER), 7);
  assert.equal(campaignNext(at(4, [[7, 3], [14, 1], [9, 3]]), ORDER), 0);
  // No plan at all is a halt, not a default node.
  assert.equal(campaignNext(at(4, []), []), 0);
  assert.equal(campaignNext(at(4, []), undefined), 0);
});

test("campaignNext: levels cap at 3, except Source-File 12", () => {
  assert.equal(campaignNext(at(7, [[7, 3]]), [[7, 3]]), 0);
  // A target past the cap is treated as the cap - it must not send the run round
  // BN7 for ever chasing a level the game never awards.
  assert.equal(campaignNext(at(7, [[7, 2]]), [[7, 5]]), 0);
  assert.equal(campaignNext(at(4, [[7, 3]]), [[7, 5], [14, 1]]), 14);
  // BN12 has no cap: [12, 25] really is twenty-five levels.
  assert.equal(campaignNext(at(12, [[12, 23]]), [[12, 25]]), 12);
  assert.equal(campaignNext(at(12, [[12, 24]]), [[12, 25]]), 0);
});

test("the configured campaign is well formed, and every node on it has a daemon", async () => {
  const { CONFIG, forNode } = await import("../lib/config.js");
  const { existsSync } = await import("node:fs");
  for (const [node, level] of CONFIG.campaign.order) {
    assert.ok(Number.isInteger(node) && node >= 1 && node <= 15, `node ${node}`);
    assert.ok(level >= 1 && (node === 12 || level <= 3), `BN${node} target ${level}`);
    const daemon = forNode(node).paths.daemon;
    assert.ok(daemon, `BN${node} has no daemon path`);
    assert.ok(existsSync(new URL(`..${daemon}`, import.meta.url)), `${daemon} does not exist`);
  }
  // BN10 may be a step (the bot can enter it), but its own daemon never leaves.
  assert.equal(forNode(10).backdoor.skipFinalHost, true);
});
