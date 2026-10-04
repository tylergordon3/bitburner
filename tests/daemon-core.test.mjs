// tests/daemon-core.test.mjs
// What a daemon run must NOT inherit from the one before it. globalThis outlives
// an aug install and a BitNode change (only a page load clears it), and a daemon
// that starts on the last run's published state makes its first decisions with
// it. Also: when the core re-reads the achievement table the campaign plan needs.
// Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearStaleState, achievementsDue } from "../lib/daemon-core.js";
import { CONFIG } from "../lib/config.js";

/** globalThis as an install (or a node change) leaves it. */
const leftovers = () => ({
  gordState: { action: "Grafting" },
  gordBackdoorState: { finalReady: true, updatedAt: Date.now() },
  gordMoneyFloor: 100e9,
  gordCompanyCity: "New Tokyo",
  _incomeSnap: { time: Date.now() - 20_000, money: 5e12 },
  _incomeRatePerMs: 50_000,
  _repSnaps: { CyberSec: { time: 1, rep: 1e5, rate: 0, lastRate: 3, rateAt: 1 } },
  gordAugHolds: { top: "CyberSec|BitWire" },
  gordAugStats: { stats: {}, count: 0 },
  gordAutoFinish: false,
  gordStanekState: { gate: "accepted", resetAt: 111 },
  gordNodeStamp: 111,
});

test("a new run drops the state that gates decisions, and keeps what is still true", () => {
  const g = leftovers();
  clearStaleState(g, 111); // an aug install: same BitNode
  // Irreversible or blocking decisions never start from the last run's word.
  for (const key of ["gordState", "gordBackdoorState", "gordMoneyFloor"]) assert.ok(!(key in g), key);
  // A stay-city from a graft would pin the player away from the gym and the university.
  assert.ok(!("gordCompanyCity" in g));
  // Income is measured since the install: the old rate is another run's.
  assert.ok(!("_incomeSnap" in g) && !("_incomeRatePerMs" in g));
  // Still true after an install: reputation rates, the aug table, the player's
  // toggles, and the gift's answer for this node.
  assert.equal(g._repSnaps.CyberSec.lastRate, 3);
  assert.equal(g.gordAugHolds.top, "CyberSec|BitWire");
  assert.ok(g.gordAugStats);
  assert.equal(g.gordAutoFinish, false);
  assert.equal(g.gordStanekState.gate, "accepted");
});

test("a new BitNode also drops what was measured under the last node's multipliers", () => {
  const g = leftovers();
  clearStaleState(g, 222);
  assert.ok(!("_repSnaps" in g) && !("gordAugHolds" in g));
  assert.equal(g.gordNodeStamp, 222);
  // ...once: the next run in the same node keeps what it has measured since.
  g._repSnaps = { NiteSec: { lastRate: 1 } };
  clearStaleState(g, 222);
  assert.equal(g._repSnaps.NiteSec.lastRate, 1);
  // The very first run after a page load has no stamp and nothing to drop.
  const fresh = {};
  clearStaleState(fresh, 222);
  assert.deepEqual(fresh, { gordNodeStamp: 222 });
});

test("achievementsDue: the reader runs when the plan could not trust the table, and not every tick", () => {
  const now = 10_000_000;
  const refreshMs = 30 * 60_000;
  const nodeResetAt = now - 5 * 60_000; // this BitNode began five minutes ago
  // Nothing published yet (a page load, or the very first run).
  assert.equal(achievementsDue(undefined, now, refreshMs, nodeResetAt), true);
  assert.equal(achievementsDue({ ids: [] }, now, refreshMs, nodeResetAt), true);
  // Read a minute ago, in this node: good for another half hour.
  assert.equal(achievementsDue({ ids: [], updatedAt: now - 60_000 }, now, refreshMs, nodeResetAt), false);
  assert.equal(achievementsDue({ ids: [], updatedAt: now - refreshMs - 1 }, now, refreshMs, 0), true);
  // Read ten minutes ago - but that was the LAST node, whose finish is what
  // awarded the achievement the plan is about to ask after.
  assert.equal(achievementsDue({ ids: [], updatedAt: now - 10 * 60_000 }, now, refreshMs, nodeResetAt), true);
  // A failed read is stamped too: retried on the interval, not relaunched each tick.
  assert.equal(achievementsDue({ ids: null, error: "x", updatedAt: now - 60_000 }, now, refreshMs, nodeResetAt), false);
});

test("the table achievementsDue lets stand is one the campaign plan will accept", async () => {
  // The two must agree, or the reader is never relaunched while the plan waits.
  const { heldAchievements } = await import("../lib/capabilities.js");
  const now = 10_000_000;
  const reset = { currentNode: 7, lastNodeReset: now - 5 * 60_000 };
  const stale = { ids: ["CHALLENGE_BN7"], updatedAt: now - 10 * 60_000 };
  const fresh = { ids: ["CHALLENGE_BN7"], updatedAt: now - 60_000 };
  assert.equal(heldAchievements(stale, reset), null);
  assert.equal(achievementsDue(stale, now, CONFIG.achievements.refreshMs, reset.lastNodeReset), true);
  assert.ok(heldAchievements(fresh, reset).has("CHALLENGE_BN7"));
  assert.equal(achievementsDue(fresh, now, CONFIG.achievements.refreshMs, reset.lastNodeReset), false);
});
