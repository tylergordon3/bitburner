// tests/daemon-lib.test.mjs
// The install policy and the next-BitNode memory in lib/daemon-lib.js. Both sit
// on irreversible actions (a reset, a BitNode choice) and both were wrong in
// ways only a long run would show, so they're pinned here.
// Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { installReason, nextBNOverride } from "../lib/daemon-lib.js";
import { CONFIG, forNode } from "../lib/config.js";

const DEFAULT = CONFIG.augs.install;
const st = (over = {}) => ({ queued: 0, redPillQueued: false, hasPriorityAug: false, allPriorityDone: false, elapsedMs: 0, ...over });

test("installReason: the default thresholds", () => {
  assert.equal(installReason(st({ queued: DEFAULT.queuedThreshold }), DEFAULT), "queue");
  assert.equal(installReason(st({ queued: DEFAULT.queuedThreshold - 1 }), DEFAULT), null);
  assert.equal(installReason(st({ queued: DEFAULT.priorityQueuedThreshold, hasPriorityAug: true }), DEFAULT), "priority");
  assert.equal(installReason(st({ queued: 1, allPriorityDone: true }), DEFAULT), "aggressive");
  assert.equal(installReason(st({ queued: 1, elapsedMs: DEFAULT.timeTriggerMs }), DEFAULT), "time");
});

test("REGRESSION: an INSTALLED Red Pill is not a reason to reset", () => {
  // Only a queued one is. With nothing queued there is never a reason - the
  // pre-install NeuroFlux dump must not be what creates the queue.
  assert.equal(installReason(st({ queued: 1, redPillQueued: true }), DEFAULT), "red-pill");
  assert.equal(installReason(st({ queued: 0, redPillQueued: false, allPriorityDone: true, elapsedMs: 1e12 }), DEFAULT), null);
});

test("REGRESSION: BN7 and BN9 really batch their installs", () => {
  for (const node of [7, 9]) {
    const policy = forNode(node).augs.install;
    assert.ok(policy.queuedThreshold > DEFAULT.queuedThreshold, `BN${node} threshold`);
    // The states the default policy resets on must NOT reset here...
    assert.equal(installReason(st({ queued: DEFAULT.queuedThreshold }), policy), null, `BN${node} at the default threshold`);
    assert.equal(installReason(st({ queued: 2, hasPriorityAug: true }), policy), null);
    // ...including the aggressive path, which used to fire on a single aug and
    // made the bigger threshold meaningless once the priority augs were in.
    assert.equal(installReason(st({ queued: 1, allPriorityDone: true }), policy), null, `BN${node} aggressive on one aug`);
    assert.equal(installReason(st({ queued: policy.minQueued, allPriorityDone: true }), policy), "aggressive");
    assert.equal(installReason(st({ queued: policy.queuedThreshold }), policy), "queue");
  }
});

test("REGRESSION: the daemon passes its node's install policy to maybeInstall", async () => {
  const { readFileSync } = await import("node:fs");
  const core = readFileSync(new URL("../lib/daemon-core.js", import.meta.url), "utf8");
  assert.match(core, /maybeInstall\(ns, self, hooks\.beforeInstall \?\? null, cfg\.augs\.install\)/);
});

// ── nextBNOverride ───────────────────────────────────────────────────────────

/** A fake ns with one file system, so a "restart" is a new ns over the same files. */
function fakeNs(files, args, lastNodeReset = 1000) {
  return {
    args,
    getResetInfo: () => ({ lastNodeReset }),
    read: f => files[f] ?? "",
    write: (f, data) => { files[f] = data; },
  };
}

test("REGRESSION: the next-BitNode arg survives an install (the callback has no args)", () => {
  const files = {};
  assert.equal(nextBNOverride(fakeNs(files, [], 1)), null);        // nothing chosen yet
  assert.equal(nextBNOverride(fakeNs(files, [10], 2)), 10);        // `run bn7/daemon.js 10`
  assert.equal(files[CONFIG.paths.nextBnFile], "2 10");
  // Different BitNode entry time between the calls above and below would be a
  // new node; same key = the same node after an aug install, restarted bare.
  assert.equal(nextBNOverride(fakeNs(files, [], 2)), 10);
  // A hold (0) is a real value, not "nothing".
  assert.equal(nextBNOverride(fakeNs(files, [0], 2)), 0);
  assert.equal(nextBNOverride(fakeNs(files, [], 2)), 0);
});

test("the remembered arg never leaks into the next BitNode, and `auto` forgets it", () => {
  const files = {};
  assert.equal(nextBNOverride(fakeNs(files, [12], 5)), 12);
  assert.equal(nextBNOverride(fakeNs(files, [], 6)), null);        // a new node: the plan applies
  assert.equal(nextBNOverride(fakeNs(files, [12], 6)), 12);
  assert.equal(nextBNOverride(fakeNs(files, ["auto"], 6)), null);
  assert.equal(nextBNOverride(fakeNs(files, [], 6)), null);
});

// ── tools/kill-helpers.js ────────────────────────────────────────────────────

test("REGRESSION: `kill-helpers all` covers every helper the daemon can place", async () => {
  const { helperScripts } = await import("../tools/kill-helpers.js");
  const scripts = helperScripts();
  const P = CONFIG.paths;
  for (const key of ["dashboard", "stocks", "contracts", "econ", "hacknet", "manager", "sleeves", "sleeveShop",
    "gang", "grafting", "backdoor", "finishBn", "bladeburner", "bladeUpkeep",
    "corpCreate", "corpExpand", "corpOffice", "corpMarket", "corpInvest", "corpSteady", "corpUpkeep"]) {
    assert.ok(scripts.includes(P[key]), `${key} (${P[key]}) missing`);
  }
  // ...and never the daemons, the driver, or the batcher's own worker legs.
  for (const key of ["driver", "worker", "hack", "grow", "weaken"]) assert.ok(!scripts.includes(P[key]), key);
  assert.ok(scripts.every(s => s.endsWith(".js")));
});
