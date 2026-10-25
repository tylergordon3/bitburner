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
    // A challenge step is checked against CHALLENGE in tests/achievements.test.mjs.
    assert.ok(level === "challenge" || (level >= 1 && (node === 12 || level <= 3)), `BN${node} target ${level}`);
    const daemon = forNode(node).paths.daemon;
    assert.ok(daemon, `BN${node} has no daemon path`);
    assert.ok(existsSync(new URL(`..${daemon}`, import.meta.url)), `${daemon} does not exist`);
  }
  // BN10 may be a step (the bot can enter it), but its own daemon never leaves.
  assert.equal(forNode(10).backdoor.skipFinalHost, true);
});

// ── Owned vs active Source-File levels (every BN12 run is entered at SF12 0) ──

test("levelMap reads every shape a Source-File list arrives in", async () => {
  const { levelMap } = await import("../lib/capabilities.js");
  const want = [[12, 0], [1, 3]];
  assert.deepEqual([...levelMap(new Map(want))], want);
  assert.deepEqual([...levelMap(want)], want);
  assert.deepEqual([...levelMap({ ctor: "JSONMap", data: want })], want);
  assert.deepEqual([...levelMap({ 1: 3 })], [[1, 3]]);
  assert.deepEqual([...levelMap(null)], []);
});

test("ownedLevelOf sees through an override, and answers null rather than guess", async () => {
  const { ownedLevelOf } = await import("../lib/capabilities.js");
  const plain = { currentNode: 5, ownedSF: new Map([[12, 9], [4, 3]]), bitNodeOptions: {} };
  assert.equal(ownedLevelOf(plain, 12), 9, "no override: active IS owned");
  assert.equal(ownedLevelOf(plain, 2), 0);
  // A BN12 run at SF12 0: ownedSF has no 12 at all (the game drops zero levels).
  const bn12 = { currentNode: 12, ownedSF: new Map([[4, 3], [1, 3]]), bitNodeOptions: { sourceFileOverrides: new Map([[12, 0]]) } };
  assert.equal(ownedLevelOf(bn12, 12), null);
  assert.equal(ownedLevelOf(bn12, 12, new Map([[12, 23]])), 23);
  assert.equal(ownedLevelOf(bn12, 12, new Map([[4, 3]])), null, "a save list without SF12 is no answer");
  assert.equal(ownedLevelOf(bn12, 12, null, new Set(["CHALLENGE_BN12"])), 50);
  assert.equal(ownedLevelOf(bn12, 4), 3, "files the run does not override");
  // The challenge marker (a level-3 file set to 3) is known without the save.
  const marked = { currentNode: 13, ownedSF: new Map([[1, 3]]), bitNodeOptions: { sourceFileOverrides: new Map([[1, 3]]) } };
  assert.equal(ownedLevelOf(marked, 1), 3);
});

test("heldAchievements carries the save's owned Source-Files, only when read in this node", async () => {
  const { heldAchievements } = await import("../lib/capabilities.js");
  const reset = { lastNodeReset: 1000 };
  const held = heldAchievements({ ids: ["X"], ownedSF: [[12, 4]], updatedAt: 2000 }, reset);
  assert.ok(held?.has("X"));
  assert.deepEqual([...(held?.ownedSF ?? [])], [[12, 4]]);
  assert.equal(heldAchievements({ ids: ["X"], updatedAt: 2000 }, reset)?.ownedSF, null);
  assert.equal(heldAchievements({ ids: ["X"], ownedSF: [[12, 4]], updatedAt: 500 }, reset), null, "stale: from the node before");
});

test("recursionEntryOptions: SF12 overridden once there is an SF12 to override", async () => {
  const { recursionEntryOptions } = await import("../lib/capabilities.js");
  assert.deepEqual(recursionEntryOptions({ currentNode: 12, ownedSF: new Map() }), { sourceFileOverrides: [[12, 0]] });
  assert.deepEqual(recursionEntryOptions({ currentNode: 5, ownedSF: new Map([[12, 3]]) }), { sourceFileOverrides: [[12, 0]] });
  assert.equal(recursionEntryOptions({ currentNode: 5, ownedSF: new Map() }), null, "BN12.1 is level 1 already");
  assert.equal(recursionEntryOptions({ currentNode: 12, ownedSF: new Map() }, null), null, "switched off");
  assert.deepEqual(recursionEntryOptions({ currentNode: 12, ownedSF: new Map() }, 2), { sourceFileOverrides: [[12, 2]] });
});
