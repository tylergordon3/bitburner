// tests/corp-seed-hold.test.mjs
// BN12's corporation stopped taking off on 2026-11-02: with the karma grind
// gone every dollar went to augs, the $450b cushion corp-create waited for was
// never left over, and the corp was founded too late to matter (runs peaked at
// $2e15 where they had reached $1e79). The fix is a money hold for the seed
// (lib/daemon-core.js corpSeedHold, CONFIG.corp.seedHoard). Run: npm test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG, forNode } from "../lib/config.js";
import { applyInviteHoard, corpSeedHold } from "../lib/daemon-core.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = 1_800_000_000_000;
const bn12 = forNode(12).corp;
// A tick in which the daemon has just asked for a corp, one hour into the node.
const at = (o = {}) => ({ money: 0, incomePerMs: 0, nodeAgeMs: HOUR, wantedAt: NOW - 5_000, now: NOW, ...o });
const perHour = dollars => dollars / HOUR;

test("BN12 holds for the seed and founds without a cushion; no other node does", () => {
  assert.equal(bn12.seedHoard.enabled, true);
  assert.equal(bn12.selfFundBuffer, 1, "corp-create founds at $150b, not $450b");
  assert.equal(CONFIG.corp.seedHoard.enabled, false);
  assert.equal(CONFIG.corp.selfFundBuffer, 3);
  for (const n of [1, 3, 7, 9, 10]) assert.equal(forNode(n).corp.seedHoard.enabled, false, `BN${n}`);
});

test("corpSeedHold: the seed is held once income fills it within the horizon", () => {
  // $150b in an hour is $150b/h: under that it is out of reach, so augs go on.
  assert.equal(corpSeedHold(bn12, at({ incomePerMs: perHour(100e9) })), null);
  assert.deepEqual(corpSeedHold(bn12, at({ incomePerMs: perHour(200e9) })), { money: 150e9, moneyMissing: 150e9 });
  // What is already in hand counts.
  assert.deepEqual(corpSeedHold(bn12, at({ money: 100e9, incomePerMs: perHour(60e9) })), { money: 150e9, moneyMissing: 50e9 });
  // In hand in full: held whatever the income, until corp-create spends it.
  assert.deepEqual(corpSeedHold(bn12, at({ money: 151e9 })), { money: 150e9, moneyMissing: 0 });
  // An unmeasured income reaches nothing.
  assert.equal(corpSeedHold(bn12, at({ incomePerMs: 0 })), null);
});

test("corpSeedHold: a hold that has begun survives a dip in the income estimate", () => {
  const dipped = { incomePerMs: perHour(100e9) };
  assert.equal(corpSeedHold(bn12, at(dipped)), null, "would not start");
  assert.ok(corpSeedHold(bn12, at({ ...dipped, holding: true })), "but keeps going at twice the horizon");
  assert.equal(corpSeedHold(bn12, at({ incomePerMs: perHour(50e9), holding: true })), null, "not for ever");
});

test("corpSeedHold: only while a corp is being asked for, and early enough to pay back", () => {
  const rich = { incomePerMs: perHour(1e12) };
  // The daemon stopped asking (corp exists, CORP toggle off, node without one).
  assert.equal(corpSeedHold(bn12, at({ ...rich, wantedAt: NOW - 10 * MIN })), null);
  assert.equal(corpSeedHold(bn12, at({ ...rich, wantedAt: 0 })), null);
  // Past the window: a corp founded now matures after the run has finished.
  assert.ok(corpSeedHold(bn12, at({ ...rich, nodeAgeMs: bn12.seedHoard.untilNodeMs - MIN })));
  assert.equal(corpSeedHold(bn12, at({ ...rich, nodeAgeMs: bn12.seedHoard.untilNodeMs })), null);
  // Where the node does not ask for it, or runs no corp at all.
  assert.equal(corpSeedHold(CONFIG.corp, at(rich)), null);
  assert.equal(corpSeedHold({ ...bn12, enabled: false }, at(rich)), null);
  assert.equal(corpSeedHold(undefined, at(rich)), null);
});

test("applyInviteHoard raises the money floor to the seed, and drops it when the corp is no longer wanted", () => {
  const saved = { ...globalThis };
  const ns = /** @type {any} */ ({
    getResetInfo: () => ({ currentNode: 12, lastNodeReset: Date.now() - HOUR, lastAugReset: Date.now() - HOUR, ownedSF: new Map(), bitNodeOptions: {} }),
    getServerMoneyAvailable: () => 40e9,
    getPlayer: () => ({ money: 40e9, factions: [], skills: { hacking: 500 }, city: "Sector-12" }),
    singularity: { getOwnedAugmentations: () => [], getFactionInviteRequirements: () => [] },
  });
  // No invite hoard in play: this fake offers no faction with a money gate.
  const cfg = forNode(12);
  try {
    globalThis._incomeRatePerMs = perHour(200e9);
    globalThis.gordCorpSeedWantedAt = Date.now();
    globalThis.gordCorpSeedHold = null;
    globalThis.gordMoneyFloor = 0;
    let invite;
    try { invite = applyInviteHoard(ns, cfg); } catch (e) { assert.fail(`applyInviteHoard threw on the fake ns: ${e}`); }
    assert.equal(invite, null, "no invite hoard on this fake");
    assert.equal(globalThis.gordMoneyFloor, 150e9);
    assert.deepEqual(globalThis.gordCorpSeedHold, { money: 150e9, moneyMissing: 110e9 });

    // The corp is founded: maybeSetupCorp stops stamping, the stamp goes stale.
    globalThis.gordCorpSeedWantedAt = Date.now() - 10 * MIN;
    applyInviteHoard(ns, cfg);
    assert.equal(globalThis.gordMoneyFloor, 0);
    assert.equal(globalThis.gordCorpSeedHold, null);
  } finally {
    for (const k of ["_incomeRatePerMs", "gordCorpSeedWantedAt", "gordCorpSeedHold", "gordMoneyFloor"]) {
      if (k in saved) globalThis[k] = saved[k]; else delete globalThis[k];
    }
  }
});
