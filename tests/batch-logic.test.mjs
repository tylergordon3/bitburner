// tests/batch-logic.test.mjs
// Unit tests for the pure HGW batch planner. Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planBatch, legSchedule, landingDelays, batchDepth, maxHackThreads, largestBatch, planCycle, incomeRate,
  prepPlan, allocate, splitGrowPadding, isPrepped, driftDetected, stillDraining, preppedScale,
  shareBonus, shareThreadsFor, shareTopUp, pruneInFlight,
} from "../lib/batch-logic.js";

// Game constants and a plausible grow model: threads to restore from `remaining`
// back to full grow roughly with ln(1/remaining).
const GAME = { securityPerHack: 0.002, securityPerGrow: 0.004, weakenAmount: 0.05 };
const RAM = { hack: 1.7, grow: 1.75, weaken: 1.75 };
const growThreadsFor = remaining => Math.ceil(40 * Math.log(1 / Math.max(remaining, 1e-9)));
const planFor = (f, hackPct = 0.002) =>
  planBatch({ moneyFraction: f, hackPct, growThreadsFor, ramPerThread: RAM, ...GAME });
// The same plan sized by hack threads - what largestBatch / planCycle search over.
const planThreads = (hackThreads, hackPct = 0.002) =>
  planBatch({ hackThreads, hackPct, growThreadsFor, ramPerThread: RAM, ...GAME });

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

test("planBatch sized by hack threads matches the same batch sized by fraction", () => {
  const byThreads = planThreads(50);
  const byFraction = planFor(0.10);
  assert.equal(byThreads.hackThreads, 50);
  assert.equal(byThreads.ram, byFraction.ram);
  assert.equal(byThreads.growThreads, byFraction.growThreads);
  assert.equal(byThreads.moneyFraction, byThreads.hackedFraction);   // nothing was "requested"
  // Still capped at maxHackFraction, and still never zero threads.
  assert.equal(planBatch({ hackThreads: 1000, hackPct: 0.002, maxHackFraction: 0.5, growThreadsFor, ramPerThread: RAM, ...GAME }).hackThreads, 250);
  assert.equal(planBatch({ hackThreads: 0.4, hackPct: 0.002, growThreadsFor, ramPerThread: RAM, ...GAME }), null);
  assert.equal(maxHackThreads(0.002, 0.5), 250);
  assert.equal(maxHackThreads(0.9, 0.5), 1);             // one thread already over the cap: still one
  assert.equal(maxHackThreads(0, 0.5), 1);
});

test("planBatch pads the grow (growPadding) and sizes the weaken behind it for the padded count", () => {
  const exact = planThreads(100);
  const padded = planBatch({ hackThreads: 100, hackPct: 0.002, growPadding: 0.05, growThreadsFor, ramPerThread: RAM, ...GAME });
  assert.equal(padded.growThreads, Math.ceil(growThreadsFor(0.8) * 1.05));
  assert.ok(padded.growThreads > exact.growThreads);
  assert.equal(padded.weaken2Threads, Math.ceil((padded.growThreads * 0.004) / 0.05));
  assert.equal(padded.hackThreads, exact.hackThreads);   // the bite is unchanged...
  assert.ok(padded.ram > exact.ram);                     // ...the batch just costs a little more
});

test("largestBatch fills the budget to within one hack thread", () => {
  // A budget between the old ladder's 5% and 10% rungs: the ladder dropped to
  // 5% (25 threads) and left almost half the RAM idle; the search lands on the
  // last thread count that fits.
  const budget = (planFor(0.05).ram + planFor(0.10).ram) / 2;
  const pick = largestBatch({ ramBudget: budget, maxThreads: 250, planFor: planThreads });
  assert.ok(pick.hackThreads > 25 && pick.hackThreads < 50, `threads ${pick.hackThreads}`);
  assert.ok(pick.ram <= budget);
  assert.ok(planThreads(pick.hackThreads + 1).ram > budget, "one more thread would not have fit");

  // More RAM than the cap can use: stop at maxThreads.
  assert.equal(largestBatch({ ramBudget: 1e9, maxThreads: 250, planFor: planThreads }).hackThreads, 250);
  // Exactly enough for one thread; not enough for any.
  assert.equal(largestBatch({ ramBudget: planThreads(1).ram, maxThreads: 250, planFor: planThreads }).hackThreads, 1);
  assert.equal(largestBatch({ ramBudget: 1, maxThreads: 250, planFor: planThreads }), null);
});

test("planCycle fills RAM at full depth, or trims depth when even a one-thread batch won't fit it", () => {
  const sched = { lastLanding: 40_600, launchInterval: 1200, maxThreads: 250, planFor: planThreads };  // depth 34
  const rich = planCycle({ totalRam: planThreads(25).ram * 34 + 1, ...sched });
  assert.equal(rich.depth, 34);
  assert.equal(rich.plan.hackThreads, 25);
  assert.ok(rich.depth * rich.plan.ram <= planThreads(25).ram * 34 + 1);

  const poor = planCycle({ totalRam: planThreads(1).ram * 5 + 1, ...sched });
  assert.equal(poor.plan.hackThreads, 1);
  assert.equal(poor.depth, 5);

  assert.equal(planCycle({ totalRam: 1, ...sched }), null);
});

test("planCycle stretches the launch interval to honour maxDepth", () => {
  const base = { totalRam: 1e9, maxThreads: 250, planFor: planThreads };
  const c = planCycle({ ...base, lastLanding: 120_000, launchInterval: 1200, maxDepth: 10 });
  assert.equal(c.depth, 10);
  assert.equal(c.launchInterval, 12_000);
  // and leaves it alone when the natural depth is already under the cap
  const d = planCycle({ ...base, lastLanding: 6_000, launchInterval: 1200, maxDepth: 10 });
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

test("allocate keeps a leg whole on the tightest host that fits it, and splits only when none does", () => {
  const hosts = [{ host: "big", free: 100 }, { host: "mid", free: 40 }, { host: "small", free: 10 }];
  // 20 grow threads = 35GB: fits big and mid - mid is the tighter fit, and big
  // stays free for a leg only it can hold.
  const one = allocate(hosts, [{ script: "g", threads: 20, ram: 1.75 }]);
  assert.deepEqual(one.assignments.map(a => [a.host, a.threads]), [["mid", 20]]);

  // Largest-first used to put the first leg on big whatever its size, so a
  // second leg that needed big's room found it taken and straddled two hosts.
  const two = allocate(hosts, [{ script: "h", threads: 20, ram: 1.7 }, { script: "g", threads: 50, ram: 1.75 }]);
  assert.deepEqual(two.assignments.map(a => [a.script, a.host, a.threads]), [["h", "mid", 20], ["g", "big", 50]]);

  // No single host holds 70 threads (122.5GB): only then is it split, largest first.
  const split = allocate(hosts, [{ script: "g", threads: 70, ram: 1.75 }]);
  assert.equal(split.ok, true);
  assert.deepEqual(split.assignments.map(a => [a.host, a.threads]), [["big", 57], ["mid", 13]]);
});

test("splitGrowPadding covers a grow whose later parts land at the security the earlier ones raised", () => {
  // The game's grow: log-growth per thread = k * min(log1p(0.03 / security), cap),
  // evaluated at the security the part LANDS on; each thread then adds 0.004.
  const cap = 0.00349388925425578;
  const growLog = sec => Math.min(Math.log1p(0.03 / sec), cap);
  const landed = (parts, minSec) => {            // total log-growth, in units of one min-security thread
    let sec = minSec, total = 0;
    for (const n of parts) { total += n * growLog(sec) / growLog(minSec); sec += n * 0.004; }
    return total;
  };
  const args = { securityPerGrow: 0.004, weakenAmount: 0.05 };

  // 600 threads planned (as one grow at min security 10). Split 350 + 250 it
  // delivers the growth of only ~570 of them...
  assert.ok(landed([350, 250], 10) < 575);
  // ...padded, any split of the padded leg delivers at least the planned 600:
  const p = splitGrowPadding({ growThreads: 600, minSecurity: 10, ...args });
  assert.ok(p.growThreads > 600 && p.growThreads < 800, `padded to ${p.growThreads}`);
  for (const first of [1, 100, 300, 500, p.growThreads - 1]) {
    assert.ok(landed([first, p.growThreads - first], 10) >= 600, `split ${first}/${p.growThreads - first}`);
  }
  assert.ok(landed([200, 200, 200, p.growThreads - 600], 10) >= 600, "four parts");
  // ...and the weaken behind it covers the PADDED thread count.
  assert.equal(p.weaken2Threads, Math.ceil((p.growThreads * 0.004) / 0.05));

  // Under the cap's knee (security < ~8.5 even when raised) a split costs nothing.
  assert.equal(splitGrowPadding({ growThreads: 600, minSecurity: 1, ...args }).growThreads, 600);
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

test("stillDraining latches a drift until the target's last batch has landed", () => {
  // Drift seen with batches in flight: draining starts...
  assert.equal(stillDraining({ wasDraining: false, openCount: 12, drift: true }), true);
  // ...and HOLDS on the ticks the state happens to read fine again (a grow just
  // landed) - the flapping the latch exists to stop.
  assert.equal(stillDraining({ wasDraining: true, openCount: 7, drift: false }), true);
  // Nothing of ours left in flight: the drain is over (the caller re-preps).
  assert.equal(stillDraining({ wasDraining: true, openCount: 0, drift: false }), false);
  assert.equal(stillDraining({ wasDraining: true, openCount: 0, drift: true }), false);
  // No drift, never draining.
  assert.equal(stillDraining({ wasDraining: false, openCount: 12, drift: false }), false);
});

test("preppedScale turns current-security readings into prepped ones, by the game's formulas", () => {
  // The game's formulas (src/Hacking.ts, src/Server/formulas/grow.ts), with the
  // security-independent factors left as arbitrary constants - they must cancel.
  const req = 100;
  const hackTime = sec => 7 * (2.5 * req * sec + 500);
  const hackPct = sec => 0.0031 * (100 - sec) / 100;
  const growLog = sec => 1.9 * Math.min(Math.log1p(0.03 / sec), 0.00349388925425578);
  const growThreads = (sec, mult) => Math.log(mult) / growLog(sec);     // ns.growthAnalyze

  for (const [min, sec] of [[7, 7.34], [10, 13], [20, 60], [1, 1.5], [3, 9.2]]) {
    const k = preppedScale({ security: sec, minSecurity: min, requiredLevel: req });
    const near = (a, b, what) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.abs(b), `${what} at ${min}/${sec}: ${a} vs ${b}`);
    near(hackTime(sec) * k.time, hackTime(min), "time");
    near(hackPct(sec) * k.hackPct, hackPct(min), "hackPct");
    near(growThreads(sec, 2) * k.growThreads, growThreads(min, 2), "growThreads");
    assert.ok(k.time < 1 && k.hackPct > 1 && k.growThreads <= 1);
  }
  // Below the grow cap's knee (security < 8.57) a grow is as strong as at min.
  assert.equal(preppedScale({ security: 1.5, minSecurity: 1, requiredLevel: 1 }).growThreads, 1);
  // Already prepped (or nonsense input): identity.
  assert.deepEqual(preppedScale({ security: 10, minSecurity: 10, requiredLevel: 50 }), { time: 1, hackPct: 1, growThreads: 1 });
  assert.deepEqual(preppedScale({ security: 5, minSecurity: 10, requiredLevel: 50 }), { time: 1, hackPct: 1, growThreads: 1 });
  // 100 security: hackAnalyze reads 0, and no factor can bring that back.
  assert.ok(Number.isFinite(preppedScale({ security: 100, minSecurity: 10, requiredLevel: 50 }).hackPct));
});

test("shareBonus is the game's 1 + ln(1 + threads)/25, and shareThreadsFor inverts it", () => {
  assert.equal(shareBonus(0), 1);
  assert.ok(Math.abs(shareBonus(1) - (1 + Math.log(2) / 25)) < 1e-12);   // one thread is +2.8%, not +0%
  assert.ok(Math.abs(shareBonus(shareThreadsFor(1.25)) - 1.25) < 1e-12);
  assert.ok(Math.abs(shareThreadsFor(1.25) - (Math.exp(6.25) - 1)) < 1e-9);
  assert.equal(shareThreadsFor(1), 0);
});

test("shareTopUp takes only free RAM, in worthwhile chunks, until the plan is met", () => {
  // A busy host: the plan wants 80 threads, nothing fits yet -> wait (never evict).
  assert.equal(shareTopUp({ want: 80, have: 0, freeThreads: 0, maxProcesses: 8 }), 0);
  // One thread's worth freed up: not worth a process (the old code started it
  // and then left the host at 1 thread for the rest of the rep grind).
  assert.equal(shareTopUp({ want: 80, have: 0, freeThreads: 1, maxProcesses: 8 }), 0);
  // A chunk (80/8 = 10) fits: take everything that fits, up to what's missing.
  assert.equal(shareTopUp({ want: 80, have: 0, freeThreads: 10, maxProcesses: 8 }), 10);
  assert.equal(shareTopUp({ want: 80, have: 10, freeThreads: 35, maxProcesses: 8 }), 35);
  assert.equal(shareTopUp({ want: 80, have: 45, freeThreads: 500, maxProcesses: 8 }), 35);
  // The last few are below a chunk but complete the plan: take them.
  assert.equal(shareTopUp({ want: 80, have: 77, freeThreads: 3, maxProcesses: 8 }), 3);
  assert.equal(shareTopUp({ want: 80, have: 77, freeThreads: 2, maxProcesses: 8 }), 0);
  // Plan met, or shrunk below what runs: nothing to do.
  assert.equal(shareTopUp({ want: 80, have: 80, freeThreads: 50, maxProcesses: 8 }), 0);
  assert.equal(shareTopUp({ want: 40, have: 80, freeThreads: 50, maxProcesses: 8 }), 0);
});

test("pruneInFlight drops batches that have fully landed", () => {
  const list = [{ id: 1, doneAt: 100 }, { id: 2, doneAt: 300 }];
  assert.deepEqual(pruneInFlight(list, 200).map(b => b.id), [2]);
  assert.deepEqual(pruneInFlight(list, 50).map(b => b.id), [1, 2]);
});

// ── landingDelays ────────────────────────────────────────────────────────────

test("landingDelays reproduces the prepped schedule when the target is prepped", () => {
  const t = { hackTime: 25_000, growTime: 80_000, weakenTime: 100_000 };
  const sched = legSchedule({ ...t, spacing: 200, margin: 200 });
  const d = landingDelays(sched, t, 1_000, 0);
  // No slot yet: land as soon as possible, which is exactly legSchedule's plan.
  assert.equal(d.base, 1_000 + sched.firstLanding);
  for (const k of ["hack", "weaken1", "grow", "weaken2"]) assert.ok(Math.abs(d.delays[k] - sched.delays[k]) < 1e-6, k);
  assert.equal(d.slip, 0);
});

test("REGRESSION: with security raised at launch, every leg still lands on its slot, in order", () => {
  const prepped = { hackTime: 25_000, growTime: 80_000, weakenTime: 100_000 };
  const sched = legSchedule({ ...prepped, spacing: 200, margin: 200 });
  // +4% on every leg: what a fat grow's security does to a leg started inside it.
  const cur = { hackTime: 26_000, growTime: 83_200, weakenTime: 104_000 };
  const now = 50_000;
  const windowAt = now + 110_000; // a slot comfortably ahead
  const d = landingDelays(sched, cur, now, windowAt);

  const land = {
    hack: now + d.delays.hack + cur.hackTime,
    weaken1: now + d.delays.weaken1 + cur.weakenTime,
    grow: now + d.delays.grow + cur.growTime,
    weaken2: now + d.delays.weaken2 + cur.weakenTime,
  };
  assert.equal(d.slip, 0);
  assert.ok(Math.abs(land.hack - windowAt) < 1e-6, "the first leg lands on the window");
  assert.ok(land.hack < land.weaken1 && land.weaken1 < land.grow && land.grow < land.weaken2, "H, W1, G, W2");
  assert.ok(Math.abs(land.weaken2 - d.lastLanding) < 1e-6);
  for (const k of ["hack", "weaken1", "grow", "weaken2"]) assert.ok(d.delays[k] >= 0, `${k} delay`);

  // The old way - prepped delays, durations taken at the raised security - put
  // the legs seconds apart from where the 200ms spacing wanted them.
  const old = { hack: now + sched.delays.hack + cur.hackTime, weaken1: now + sched.delays.weaken1 + cur.weakenTime };
  assert.ok(Math.abs((old.weaken1 - old.hack) - 200) > 1_000);
});

test("landingDelays slips the window, never a negative delay, when the slot is out of reach", () => {
  const t = { hackTime: 25_000, growTime: 80_000, weakenTime: 100_000 };
  const sched = legSchedule({ ...t, spacing: 200, margin: 200 });
  const d = landingDelays(sched, t, 1_000, 2_000); // a slot 1s away, a weaken takes 100s
  assert.ok(d.slip > 0);
  for (const k of ["hack", "weaken1", "grow", "weaken2"]) assert.ok(d.delays[k] >= 0, k);
});
