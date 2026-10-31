// tests/corp-bribe.test.mjs
// Corp bribes and the one big install (2026-10-31, from the first BN12 run: $1e80
// by hour 9, then six hours grinding Daedalus and installs five augs at a time).
// Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { bribePlan } from "../lib/corp-lib.js";
import { batchInstallHold, installReason, moneySolved } from "../lib/daemon-lib.js";
import { CONFIG, forNode } from "../lib/config.js";

const POLICY = CONFIG.corp.bribe;
const BATCH = CONFIG.augs.install.batch;
const rich = { public: true, valuation: 1e20, funds: 1e30 };

test("bribes wait for a public corp past the game's valuation line", () => {
  const wish = [{ faction: "CyberSec", rep: 0, repReq: 1000 }];
  assert.deepEqual(bribePlan({ ...rich, public: false }, wish, POLICY), []);
  assert.deepEqual(bribePlan({ ...rich, valuation: 99e12 }, wish, POLICY), []);
  assert.deepEqual(bribePlan(rich, wish, { ...POLICY, enabled: false }), []);
  assert.deepEqual(bribePlan(null, wish, POLICY), []);
  assert.deepEqual(bribePlan(rich, wish, POLICY), [{ faction: "CyberSec", rep: 1000, amount: 1000 * 1e9 }]);
});

test("one call a faction, raised to its highest requirement, paying each point once", () => {
  const plan = bribePlan(rich, [
    { faction: "Daedalus", rep: 100, repReq: 2_500_000 },
    { faction: "Daedalus", rep: 100, repReq: 1000 },
    { faction: "CyberSec", rep: 50, repReq: 500 },
  ], POLICY);
  assert.deepEqual(plan.find(p => p.faction === "Daedalus"), { faction: "Daedalus", rep: 2_499_900, amount: 2_499_900 * 1e9 });
  assert.equal(plan.find(p => p.faction === "CyberSec")?.rep, 450);
  assert.equal(plan.length, 2);
});

test("a short budget buys the cheapest shortfalls and never over the funds fraction", () => {
  const funds = 1e16; // 1% = $1e14 = 100k reputation
  const plan = bribePlan({ ...rich, funds }, [
    { faction: "Daedalus", rep: 0, repReq: 2_500_000 },
    { faction: "CyberSec", rep: 0, repReq: 60_000 },
    { faction: "NiteSec", rep: 0, repReq: 30_000 },
    { faction: "Aevum", rep: 0, repReq: 50_000 },
  ], POLICY);
  assert.deepEqual(plan.map(p => p.faction).sort(), ["Aevum", "NiteSec"]);
  assert.ok(plan.reduce((sum, p) => sum + p.amount, 0) <= funds * POLICY.maxFundsFraction);
});

test("a requirement already met costs nothing", () => {
  assert.deepEqual(bribePlan(rich, [{ faction: "CyberSec", rep: 2000, repReq: 1000 }], POLICY), []);
});

test("money is solved by player money, or by a public corp's profit alone", () => {
  assert.equal(moneySolved(1e30, null, BATCH), true);
  assert.equal(moneySolved(1e12, null, BATCH), false);
  assert.equal(moneySolved(0, { public: true, profit: 1e15 }, BATCH), true);
  assert.equal(moneySolved(0, { public: false, profit: 1e15 }, BATCH), false);
  assert.equal(moneySolved(0, { public: true, profit: 1e9 }, BATCH), false);
});

const hold = over => ({
  hackingFinish: true, solved: true, pillInstalled: false, daedalusJoined: false,
  installed: 14, sinceSolvedMs: 60 * 60_000, sinceLastBuyMs: 60 * 60_000, ...over,
});

test("batch hold: holds while buying, releases the batch once the factions are sold out", () => {
  assert.equal(batchInstallHold(hold({ sinceLastBuyMs: 1000 }), BATCH), true, "still buying");
  assert.equal(batchInstallHold(hold({ sinceSolvedMs: 1000 }), BATCH), true, "bribes need a moment");
  assert.equal(batchInstallHold(hold(), BATCH), false, "sold out: install");
});

test("batch hold: past Daedalus's aug gate, nothing resets the hacking level it needs", () => {
  assert.equal(batchInstallHold(hold({ installed: BATCH.enoughInstalled }), BATCH), true);
  assert.equal(batchInstallHold(hold({ daedalusJoined: true }), BATCH), true);
});

test("batch hold: off where it should be, and it cannot stall a node for ever", () => {
  const stuck = { installed: BATCH.enoughInstalled };
  assert.equal(batchInstallHold(hold({ ...stuck, hackingFinish: false }), BATCH), false);
  assert.equal(batchInstallHold(hold({ ...stuck, solved: false }), BATCH), false);
  assert.equal(batchInstallHold(hold({ ...stuck, pillInstalled: true }), BATCH), false);
  assert.equal(batchInstallHold(hold({ ...stuck, sinceSolvedMs: BATCH.maxHoldMs }), BATCH), false);
  assert.equal(batchInstallHold(hold(stuck), null), false);
});

test("installReason: the batch hold stops every reason but The Red Pill", () => {
  const P = CONFIG.augs.install;
  const busy = { queued: 40, redPillQueued: false, hasPriorityAug: true, allPriorityDone: true, elapsedMs: 100 * 3_600_000, favor: null };
  assert.equal(installReason(busy, P), "queue");
  assert.equal(installReason({ ...busy, batchHold: true }, P), null);
  assert.equal(installReason({ ...busy, batchHold: true, redPillQueued: true }, P), "red-pill");
});

test("the node overlays keep the bribe and batch settings", () => {
  assert.equal(forNode(12).corp.bribe.enabled, true);
  assert.equal(forNode(12).augs.install.batch.enoughInstalled, 31);
  assert.ok(forNode(13).augs.install.batch, "an install override deep-merges");
});
