// tests/bn8-logic.test.mjs
// bn8/daemon.js's install batch, the pure half (lib/bn8-logic.js): when a run
// stops trading and buys, and how the batch moves from selling to buying.
// Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  augPriceStep, augsPerHour, batchPhase, expForLevel, hoursToLevel, ratePerHour, recordSample, releaseDecision,
} from "../lib/bn8-logic.js";
import { CONFIG, forNode } from "../lib/config.js";

const RL = forNode(8).stocks.treasury.release;
const H = 3_600_000;

test("augPriceStep: the game's 1.9, less SF11's discount", () => {
  assert.equal(augPriceStep(0), 1.9);
  assert.ok(Math.abs(augPriceStep(1) - 1.824) < 1e-12);
  assert.ok(Math.abs(augPriceStep(3) - 1.767) < 1e-12);
  assert.equal(augPriceStep(9), augPriceStep(3));
});

test("recordSample keeps the window and thins to one sample a gap, newest always last", () => {
  let s = [];
  for (let t = 0; t <= 10 * 60_000; t += 15_000) s = recordSample(s, { t, v: t }, 5 * 60_000, 60_000);
  assert.equal(s[s.length - 1].t, 10 * 60_000, "the newest reading is always kept");
  assert.ok(s[0].t >= 5 * 60_000, "nothing older than keepMs");
  for (let i = 1; i < s.length - 1; i++) assert.ok(s[i].t - s[i - 1].t >= 60_000, "thinned to the gap");
  assert.ok(s.length <= 7);
});

test("augsPerHour: log growth over the window, over the log of the price step", () => {
  const step = augPriceStep(1);
  // Gross wealth doubling every hour: ln 2 / ln 1.824 = 1.15 augs an hour.
  const samples = [];
  for (let m = 0; m <= 90; m += 1) samples.push({ t: m * 60_000, v: 1e12 * Math.pow(2, m / 60) });
  const rate = augsPerHour(samples, 45 * 60_000, step);
  assert.ok(Math.abs(rate - Math.log(2) / Math.log(step)) < 1e-9, `rate ${rate}`);
  // Not a full window yet: no answer, rather than a noisy one.
  assert.equal(augsPerHour(samples.slice(0, 30), 45 * 60_000, step), null);
  assert.equal(augsPerHour([], 45 * 60_000, step), null);
});

test("ratePerHour / expForLevel / hoursToLevel: the game's skill curve", () => {
  const samples = [{ t: 0, v: 0 }, { t: H, v: 5e7 }, { t: 2 * H, v: 1e8 }];
  assert.equal(ratePerHour(samples, H), 5e7);
  assert.equal(ratePerHour(samples.slice(0, 1), H), 0);
  // The 10.3h save: hacking 591 at 1.436e8 exp with a 1.4753 multiplier.
  const level = 1.4753 * (32 * Math.log(1.436e8 + 534.6) - 200);
  assert.ok(Math.abs(level - 591.6) < 1, `level ${level}`);
  assert.ok(Math.abs(expForLevel(591.6, 1.4753) - 1.436e8) / 1.436e8 < 0.01);
  // Hacking 2500 at x5.6 wants ~5.9e8 exp; at 1e8/h from 1e8 that is ~4.9h.
  const h = hoursToLevel({ level: 2500, exp: 1e8, mult: 5.6, expPerHour: 1e8 });
  assert.ok(h > 4 && h < 6, `hours ${h}`);
  assert.equal(hoursToLevel({ level: 10, exp: 1e9, mult: 2, expPerHour: 0 }), 0);
  assert.equal(hoursToLevel({ level: 3000, exp: 0, mult: 2, expPerHour: 0 }), Infinity);
});

const base = {
  elapsedMs: 10 * H, netWorth: 5e12, augsPerHour: 0.9, finalRun: false,
  installedAugs: 25, daedalusJoined: false, redPillOwned: false, hoursToDaedalus: Infinity,
};

test("releaseDecision: trade while waiting pays, release when it stops", () => {
  assert.equal(releaseDecision(base, RL).release, false, "0.9 augs/h still beats an install");
  const sat = releaseDecision({ ...base, augsPerHour: 0.2 }, RL);
  assert.equal(sat.release, true);
  assert.equal(sat.reason, "saturated");
  // Not before minRunMs, nor below minNetWorth (until maxRunMs).
  assert.equal(releaseDecision({ ...base, augsPerHour: 0.2, elapsedMs: RL.minRunMs - 1 }, RL).release, false);
  assert.equal(releaseDecision({ ...base, augsPerHour: 0.2, netWorth: RL.minNetWorth / 2 }, RL).release, false);
  const late = releaseDecision({ ...base, netWorth: RL.minNetWorth / 2, elapsedMs: RL.maxRunMs }, RL);
  assert.deepEqual([late.release, late.reason], [true, "time"]);
  // No window measured yet: hold, unless the run is old.
  assert.equal(releaseDecision({ ...base, augsPerHour: null }, RL).release, false);
});

test("releaseDecision: never in the last run, and the Daedalus run waits for its invite", () => {
  assert.equal(releaseDecision({ ...base, augsPerHour: 0, elapsedMs: 99 * H, finalRun: true }, RL).release, false);
  // 30 installed, hacking 2500 three hours off: hold for the invite (and The Red Pill).
  const d = { ...base, augsPerHour: 0.1, installedAugs: 30, hoursToDaedalus: 3 };
  assert.equal(releaseDecision(d, RL).release, false);
  assert.match(releaseDecision(d, RL).why, /Daedalus/);
  // ...but not past maxRunMs + daedalusWaitMs, nor for a gate out of sight.
  assert.equal(releaseDecision({ ...d, elapsedMs: RL.maxRunMs + RL.daedalusWaitMs }, RL).release, true);
  assert.equal(releaseDecision({ ...d, hoursToDaedalus: 40 }, RL).release, true);
  // Joined: the saturation rule again - and The Red Pill is in that batch.
  assert.equal(releaseDecision({ ...d, daedalusJoined: true }, RL).release, true);
  // Too few installed for Daedalus: no wait.
  assert.equal(releaseDecision({ ...d, installedAugs: 29 }, RL).release, true);
});

test("batchPhase: raise until the book is sold (or the timeout), then buy", () => {
  const b = { phase: "raise", since: 0, lastQueued: -1 };
  assert.equal(batchPhase(null, { now: 1, bookValue: 0, netWorth: 1 }, RL), null);
  assert.equal(batchPhase(b, { now: 5_000, bookValue: 1e12, netWorth: 2e12 }, RL).phase, "raise");
  const sold = batchPhase(b, { now: 6_000, bookValue: 0, netWorth: 2e12 }, RL);
  assert.deepEqual([sold.phase, sold.since], ["buy", 6_000]);
  assert.equal(batchPhase(b, { now: RL.liquidateTimeoutMs, bookValue: 1e12, netWorth: 2e12 }, RL).phase, "buy");
  assert.equal(batchPhase(sold, { now: 9e9, bookValue: 0, netWorth: 2e12 }, RL), sold, "buy is the last phase");
});

test("BN8 config: nothing bought during a run, the batch installs at a threshold of 1", () => {
  const c = forNode(8);
  assert.equal(c.augs.install.queuedThreshold, 1);
  assert.equal(c.econ.homeBeforeFleet, true);
  assert.equal(CONFIG.econ.homeBeforeFleet, false, "every other node keeps the fleet-first gate");
  assert.equal(c.factions.pursueCompanyFactions, true);
  assert.equal(c.stocks.treasury.servers.hardSpendCap, Infinity);
});
