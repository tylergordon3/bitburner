// tests/batch-logic.test.mjs
// Unit tests for the pure HGW batch planner. Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planBatch, legSchedule, batchDepth, chooseFraction, planCycle, incomeRate,
  prepPlan, allocate, isPrepped, driftDetected, pruneInFlight,
} from "../lib/batch-logic.js";

// Game constants and a plausible grow model: threads to restore from `remaining`
// back to full grow roughly with ln(1/remaining).
const GAME = { securityPerHack: 0.002, securityPerGrow: 0.004, weakenAmount: 0.05 };
const RAM = { hack: 1.7, grow: 1.75, weaken: 1.75 };
const growThreadsFor = remaining => Math.ceil(40 * Math.log(1 / Math.max(remaining, 1e-9)));
const planFor = (f, hackPct = 0.002) =>
  planBatch({ moneyFraction: f, hackPct, growThreadsFor, ramPerThread: RAM, ...GAME });

test("planBatch sizes the four legs and sums their RAM", () => {
  const p = planFor(0.10);
  assert.equal(p.hackThreads, 50);                       // 0.10 / 0.002
  assert.equal(p.hackedFraction, 0.1);
  assert.equal(p.growThreads, growThreadsFor(0.9));
  assert.equal(p.weaken1Threads, Math.ceil((50 * 0.002) / 0.05));           // 2
  assert.equal(p.weaken2Threads, Math.ceil((p.growThreads * 0.004) / 0.05));
  assert.equal(p.ram,
    50 * RAM.hack + p.growThreads * RAM.grow + (p.weaken1Threads + p.weaken2Threads) * RAM.weaken);
  assert.ok(p.securityAdded > 0);
});

test("planBatch caps the HACK at maxHackFraction, not just the grow estimate", () => {
  // One thread steals 30% here, so 0.5 would take 16 threads = way over 0.9.
  const p = planBatch({ moneyFraction: 0.95, hackPct: 0.3, growThreadsFor, ramPerThread: RAM, ...GAME });
  assert.equal(p.hackThreads, 3);                        // floor(0.9 / 0.3)
  assert.ok(p.hackedFraction <= 0.9);
  assert.equal(planBatch({ moneyFraction: 0.1, hackPct: 0, growThreadsFor, ramPerThread: RAM, ...GAME }), null);
});

test("legSchedule lands H, W1, G, W2 in order and spaces launches past the span", () => {
  const s = legSchedule({ hackTime: 10_000, growTime: 32_000, weakenTime: 40_000, spacing: 200 });
  assert.ok(s.landings.hack < s.landings.weaken1);
  assert.ok(s.landings.weaken1 < s.landings.grow);
  assert.ok(s.landings.grow < s.landings.weaken2);
  assert.equal(s.landings.weaken1, 40_000);
  assert.equal(s.landings.hack, 39_600);
  assert.equal(s.landings.weaken2, 40_600);
  assert.equal(s.span, 1000);
  assert.equal(s.launchInterval, 1200);                  // span + default margin (= spacing)
  assert.equal(legSchedule({ hackTime: 10_000, growTime: 32_000, weakenTime: 40_000, spacing: 200, margin: 50 }).launchInterval, 1050);

  // The ordering guarantee: batch N+1 launched one interval later has its FIRST
  // landing after batch N's LAST landing.
  assert.ok(s.launchInterval + s.firstLanding > s.lastLanding);
});

test("legSchedule clamps delays when a leg is longer than its slot", () => {
  // Absurdly fast weaken: hack would need a negative delay, so it lands late
  // instead of exec'ing in the past; the landings stay consistent with delays.
  const s = legSchedule({ hackTime: 900, growTime: 950, weakenTime: 1000, spacing: 200 });
  assert.equal(s.delays.hack, 0);
  assert.equal(s.landings.hack, 900);
  assert.equal(s.lastLanding, Math.max(s.landings.hack, s.landings.weaken1, s.landings.grow, s.landings.weaken2));
});

test("batchDepth is how many batches share the air at once", () => {
  assert.equal(batchDepth(40_600, 1200), 34);            // ceil
  assert.equal(batchDepth(500, 1200), 1);
  assert.equal(batchDepth(1000, 0), 1);
});

test("chooseFraction takes the largest fraction whose batch fits the budget", () => {
  const fractions = [0.01, 0.1, 0.05];                   // order doesn't matter
  const pick = chooseFraction({ fractions, ramBudget: planFor(0.05).ram + 0.1, planFor });
  assert.equal(pick.moneyFraction, 0.05);
  assert.equal(chooseFraction({ fractions, ramBudget: 1, planFor }), null);
});

test("planCycle fills RAM at full depth, or trims depth when even the smallest bite won't fit it", () => {
  const fractions = [0.1, 0.05, 0.01];
  const sched = { lastLanding: 40_600, launchInterval: 1200 };            // depth 34
  const rich = planCycle({ fractions, totalRam: planFor(0.05).ram * 34 + 1, planFor, ...sched });
  assert.equal(rich.depth, 34);
  assert.equal(rich.plan.moneyFraction, 0.05);

  const poor = planCycle({ fractions, totalRam: planFor(0.01).ram * 5 + 1, planFor, ...sched });
  assert.equal(poor.plan.moneyFraction, 0.01);
  assert.equal(poor.depth, 5);

  assert.equal(planCycle({ fractions, totalRam: 1, planFor, ...sched }), null);
});

test("planCycle stretches the launch interval to honour maxDepth", () => {
  const fractions = [0.1, 0.01];
  const c = planCycle({ fractions, totalRam: 1e9, planFor, lastLanding: 120_000, launchInterval: 1200, maxDepth: 10 });
  assert.equal(c.depth, 10);
  assert.equal(c.launchInterval, 12_000);
  // and leaves it alone when the natural depth is already under the cap
  const d = planCycle({ fractions, totalRam: 1e9, planFor, lastLanding: 6_000, launchInterval: 1200, maxDepth: 10 });
  assert.equal(d.launchInterval, 1200);
});

test("incomeRate is $ per ms and prefers the target that pays more, not the cheaper one", () => {
  const plan = planFor(0.05);
  assert.equal(incomeRate({ maxMoney: 1e9, hackChance: 1, plan, launchInterval: 1200 }),
    (plan.hackedFraction * 1e9 * 1) / 1200);

  // The bug this metric replaces: a small server whose batches are a fraction of
  // the cost still cannot out-EARN a rich one, however efficient it is per GB.
  // (Same bite, same cadence; only the money differs.)
  const rich = incomeRate({ maxMoney: 1e9, hackChance: 1, plan, launchInterval: 1200 });
  const cheap = incomeRate({ maxMoney: 2e6, hackChance: 1, plan, launchInterval: 1200 });
  assert.ok(rich > cheap);

  // Halving the hack's success chance halves the expected income.
  assert.equal(incomeRate({ maxMoney: 1e9, hackChance: 0.5, plan, launchInterval: 1200 }), rich / 2);

  assert.equal(incomeRate({ maxMoney: 1e9, hackChance: 1, plan: null, launchInterval: 1200 }), 0);
  assert.equal(incomeRate({ maxMoney: 0, hackChance: 1, plan, launchInterval: 1200 }), 0);
  assert.equal(incomeRate({ maxMoney: 1e9, hackChance: 1, plan, launchInterval: 0 }), 0);
});

test("prepPlan sizes weaken to cover the grow it launches alongside", () => {
  // 10 security over min, 500 grow threads needed, plenty of threads.
  const p = prepPlan({ excessSecurity: 10, growNeeded: 500, totalThreads: 10_000, weakenAmount: 0.05, securityPerGrow: 0.004 });
  assert.equal(p.grow, 500);
  assert.equal(p.weaken, Math.ceil((10 + 500 * 0.004) / 0.05));          // 240, not 200
  assert.equal(p.complete, true);
  assert.ok(p.weaken + p.grow <= 10_000);
});

test("prepPlan splits a tight budget so the weaken still covers the grow", () => {
  const p = prepPlan({ excessSecurity: 10, growNeeded: 5000, totalThreads: 1000, weakenAmount: 0.05, securityPerGrow: 0.004 });
  assert.ok(p.weaken + p.grow <= 1000);
  assert.ok(p.weaken * 0.05 >= 10 + p.grow * 0.004 - 1e-9);
  assert.equal(p.complete, false);
  assert.ok(p.grow > 0);
});

test("prepPlan with only enough for part of the weaken spends it all on weaken", () => {
  const p = prepPlan({ excessSecurity: 100, growNeeded: 500, totalThreads: 50, weakenAmount: 0.05, securityPerGrow: 0.004 });
  assert.equal(p.grow, 0);
  assert.equal(p.weaken, 50);
  assert.equal(p.complete, false);
  assert.deepEqual(prepPlan({ excessSecurity: 0, growNeeded: 0, totalThreads: 0, weakenAmount: 0.05, securityPerGrow: 0.004 }),
    { weaken: 0, grow: 0, complete: true });
});

test("allocate places every leg or reports the shortfall, without mutating hosts", () => {
  const hosts = [{ host: "a", free: 10 }, { host: "b", free: 4 }];
  const legs = [{ script: "h", threads: 5, ram: 1.7 }, { script: "g", threads: 2, ram: 1.75 }];
  const r = allocate(hosts, legs);
  assert.equal(r.ok, true);
  assert.equal(r.unplaced, 0);
  const placed = s => r.assignments.filter(a => a.script === s).reduce((n, a) => n + a.threads, 0);
  assert.equal(placed("h"), 5);
  assert.equal(placed("g"), 2);
  assert.deepEqual(hosts, [{ host: "a", free: 10 }, { host: "b", free: 4 }]);
  for (const [h, free] of r.freeAfter) assert.ok(free >= 0, h);

  const tooBig = allocate(hosts, [{ script: "h", threads: 9, ram: 1.7 }]);   // 5 fit on a, 2 on b
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.unplaced, 2);
});

test("isPrepped and driftDetected", () => {
  const base = { maxMoney: 1000, minSecurity: 5 };
  assert.equal(isPrepped({ ...base, money: 960, security: 5.5, moneyThreshold: 0.95, securityTolerance: 1 }), true);
  assert.equal(isPrepped({ ...base, money: 900, security: 5.5, moneyThreshold: 0.95, securityTolerance: 1 }), false);
  assert.equal(isPrepped({ ...base, money: 1000, security: 7, moneyThreshold: 0.95, securityTolerance: 1 }), false);

  // One batch open that hacks 10% and adds 1 security: those readings are fine...
  const tol = { openMoneyFraction: 0.1, openSecurity: 1, moneyTolerance: 0.05, securityTolerance: 1 };
  assert.equal(driftDetected({ ...base, money: 900, security: 6, ...tol }), false);
  // ...but a second hack's worth of loss, or security past the open batch's share, is drift.
  assert.equal(driftDetected({ ...base, money: 800, security: 6, ...tol }), true);
  assert.equal(driftDetected({ ...base, money: 900, security: 7.5, ...tol }), true);
});

test("pruneInFlight drops batches that have fully landed", () => {
  const list = [{ id: 1, doneAt: 100 }, { id: 2, doneAt: 300 }];
  assert.deepEqual(pruneInFlight(list, 200).map(b => b.id), [2]);
  assert.deepEqual(pruneInFlight(list, 50).map(b => b.id), [1, 2]);
});
