// tests/bn8-daemon.test.mjs
// bn8/daemon.js's install batch end to end through its hooks, on a fake ns and
// a fake clock: nothing is bought during a run (the aug fence is up only inside
// the daemon's tick, from afterDecide to statusLine), a saturated book is
// released - sold first, fenced - and only then is the fence opened for
// buyAugs, and the install waits for the buying to settle.
// Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTreasury, afterDecide, beforeInstall, statusLine } from "../bn8/daemon.js";
import { forNode } from "../lib/config.js";

const RL = forNode(8).stocks.treasury.release;
const H = 3_600_000;

test("BN8 install batch: fenced run, saturated release, sell, buy, settle", () => {
  const realNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  const epoch = now - 10 * H;
  const g = { cash: 5e11, owned: /** @type {string[]} */ ([]), installed: /** @type {string[]} */ ([]) };
  const ns = /** @type {any} */ ({
    getResetInfo: () => ({ lastAugReset: epoch, ownedSF: new Map([[11, 1]]) }),
    getPlayer: () => ({ money: g.cash, factions: [], exp: { hacking: 1e8 }, mults: { hacking: 2 } }),
    singularity: { getOwnedAugmentations: purchased => (purchased ? g.owned : g.installed) },
    format: { number: n => String(Math.round(n)) },
  });
  // A live trader with a $5t book that has stopped growing: saturated.
  const trader = (totalValue) => {
    globalThis.gordStockState = {
      tier: 2, totalValue, positions: [], cash: g.cash, netWorth: g.cash + totalValue, updatedAt: now,
      startedAt: epoch, outflow: 0, inflow: 0, incomePerMs: 0,
    };
  };
  const tick = (totalValue = 4.5e12) => {
    trader(totalValue);
    // The trader's own floor: cash less the allowance it was asked for.
    globalThis.gordMoneyFloor = Math.max(0, g.cash - (globalThis.gordStockCashWanted?.amount ?? 0));
    return runTreasury(ns, 0);
  };
  try {
    // ── A run in progress: trading, fenced ────────────────────────────────────
    let r = tick();
    assert.equal(r.batch, null);
    // The fence: from afterDecide (just before buyAugs) to statusLine, the floor
    // is all the cash; then the trader's floor is back for the allowance's spenders.
    globalThis.gordMoneyFloor = 123;
    afterDecide(ns, { action: "x" });
    assert.equal(globalThis.gordMoneyFloor, g.cash, "buyAugs sees nothing to spend");
    statusLine(ns);
    assert.equal(globalThis.gordMoneyFloor, 123, "the allowance's spenders see the trader's floor again");

    // ── 45 minutes of a flat book: released ───────────────────────────────────
    for (let i = 0; i < 4 * 50 && !r.batch; i++) { now += 15_000; r = tick(); }
    assert.ok(r.batch, "a saturated book is released");
    assert.equal(r.batch.phase, "raise");
    assert.equal(r.batch.reason, "saturated");
    const ask = globalThis.gordStockCashWanted;
    assert.equal(ask.amount, 0, "no allowance during a batch");
    assert.equal(ask.release, false, "never `release`: the trader would publish a floor of 0 to every spender");
    assert.ok(ask.hoard > 2 * 5e12 - 1, "a hoard over net worth: sell everything, buy nothing");
    // Still selling: the fence stays up inside the tick, and the install cannot happen.
    afterDecide(ns, {});
    assert.ok(globalThis.gordMoneyFloor > 0);
    assert.equal(beforeInstall(ns), false);
    statusLine(ns);
    assert.equal(globalThis.gordMoneyFloor, g.cash, "between ticks a batch's cash is all fenced");

    // ── The book is sold: buy ──────────────────────────────────────────────────
    g.cash = 5e12;
    now += 15_000;
    r = tick(0);
    assert.equal(r.batch.phase, "buy");
    afterDecide(ns, {});
    assert.equal(globalThis.gordMoneyFloor, 0, "the fence opens for buyAugs and maybeInstall");
    // buyAugs queued 14; maybeInstall publishes that and asks: not yet, a chain may follow.
    globalThis.gordAugSnapshot = { queued: 14, updatedAt: now };
    assert.equal(beforeInstall(ns), false);
    globalThis.gordInstallRequested = now;
    statusLine(ns);
    assert.equal(globalThis.gordMoneyFloor, g.cash, "re-fenced between ticks");
    assert.equal(globalThis.gordInstallRequested, 0, "the trader is not told to publish a floor of 0");
    // Next tick queued two more (a prerequisite chain), the one after nothing: install.
    now += 15_000; tick(0);
    globalThis.gordAugSnapshot = { queued: 16, updatedAt: now };
    assert.equal(beforeInstall(ns), false);
    now += 15_000; tick(0);
    globalThis.gordAugSnapshot = { queued: 16, updatedAt: now };
    assert.equal(beforeInstall(ns), true, "settled: install");
  } finally {
    Date.now = realNow;
    for (const k of ["gordStockState", "gordMoneyFloor", "gordStockCashWanted", "gordAugSnapshot", "gordInstallRequested", "_incomeRatePerMs", "gordCompanyCity"]) {
      delete globalThis[k];
    }
  }
});

test("BN8 install batch: never in the run after The Red Pill", () => {
  const realNow = Date.now;
  let now = 1_900_000_000_000;
  Date.now = () => now;
  const epoch = now - 20 * H;
  const ns = /** @type {any} */ ({
    getResetInfo: () => ({ lastAugReset: epoch, ownedSF: new Map() }),
    getPlayer: () => ({ money: 1e12, factions: ["Daedalus"], exp: { hacking: 1e9 }, mults: { hacking: 6 } }),
    singularity: { getOwnedAugmentations: () => ["The Red Pill"] },
    format: { number: n => String(n) },
  });
  try {
    let r = null;
    for (let i = 0; i < 4 * 60; i++) {
      globalThis.gordStockState = { tier: 2, totalValue: 0, positions: [], cash: 1e12, netWorth: 1e12, updatedAt: now, startedAt: epoch, outflow: 0 };
      r = runTreasury(ns, 0);
      now += 15_000;
    }
    assert.equal(r.batch, null);
    assert.ok(RL.maxRunMs < 20 * H, "even past maxRunMs");
  } finally {
    Date.now = realNow;
    for (const k of ["gordStockState", "gordMoneyFloor", "gordStockCashWanted", "_incomeRatePerMs"]) delete globalThis[k];
  }
});
