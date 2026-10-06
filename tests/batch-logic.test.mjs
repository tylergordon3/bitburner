// tests/batch-logic.test.mjs
// Unit tests for the pure HGW batch planner. Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planBatch, legSchedule, landingDelays, batchDepth, maxHackThreads, largestBatch, planCycle, incomeRate,
  prepPlan, allocate, splitGrowPadding, isPrepped, driftDetected, stillDraining, preppedScale,
  shareBonus, shareThreadsFor, shareTopUp, pruneInFlight,
  efficientThreads, threadLadder, concaveHull, incomeCurve, allocateRam, prepDiscount,
  costAt, stolenAt, preferredWishes, expPerThread, expCurve, capProcesses,
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

test("planCycle fills RAM at full depth when the budget carries efficient batches", () => {
  const sched = { lastLanding: 40_600, launchInterval: 1200, maxThreads: 250, planFor: planThreads };  // depth 34
  const eff = efficientThreads(sched);
  const rich = planCycle({ totalRam: planThreads(eff + 10).ram * 34 + 1, ...sched });
  assert.equal(rich.depth, 34);
  assert.equal(rich.plan.hackThreads, eff + 10);
  assert.ok(rich.depth * rich.plan.ram <= planThreads(eff + 10).ram * 34 + 1);

  assert.equal(planCycle({ totalRam: 1, ...sched }), null);
});

test("efficientThreads: the smallest batch that is near the best steal per GB", () => {
  const p = { maxThreads: 250, planFor: planThreads };
  const eff = efficientThreads(p);
  const rate = h => planThreads(h).hackedFraction / planThreads(h).ram;
  // A one-thread batch is mostly overhead (a grow and two weakens for one hack).
  assert.ok(eff > 4, `efficient size ${eff}`);
  assert.ok(rate(eff) > rate(1) * 2);
  // Within tolerance of the best on the ladder, and no smaller rung is.
  const ladder = threadLadder(64);
  const best = Math.max(...ladder.map(rate));
  assert.ok(rate(eff) >= best * 0.95);
  for (const h of ladder.filter(x => x < eff)) assert.ok(rate(h) < best * 0.95);
  // A target one thread nearly empties has no choice.
  assert.equal(efficientThreads({ maxThreads: 1, planFor: planThreads }), 1);
});

test("REGRESSION: a small budget buys fewer efficient batches, not a full window of tiny ones", () => {
  // 440GB against a target whose window holds 34 batches: the old plan was 34
  // batches of a hack thread or two each (0.4% bites) - most of the RAM on the
  // grow and weaken threads every batch needs regardless. Simulated, the thin
  // window stole 3x as much from the same RAM.
  const sched = { lastLanding: 40_600, launchInterval: 1200, maxThreads: 250, planFor: planThreads };
  const eff = efficientThreads(sched);
  const totalRam = planThreads(eff).ram * 6.5;
  const c = planCycle({ totalRam, ...sched });
  assert.ok(c.depth < 34 && c.plan.hackThreads >= eff, `depth ${c.depth} x ${c.plan.hackThreads} threads`);
  assert.ok(c.depth * c.plan.ram <= totalRam);
  // More stolen per window than the full-depth alternative on the same RAM.
  const tiny = largestBatch({ ramBudget: totalRam / 34, maxThreads: 250, planFor: planThreads });
  assert.ok(c.depth * c.plan.hackedFraction > 34 * (tiny?.hackedFraction ?? 0));
  // Less than one efficient batch: the largest single batch that fits.
  const one = planCycle({ totalRam: planThreads(3).ram + 0.1, ...sched });
  assert.equal(one.depth, 1);
  assert.equal(one.plan.hackThreads, 3);
});

test("REGRESSION: a thin window is the depth x bite that steals most, not a whole number of efficient batches", () => {
  // The thin window used to be floor(RAM / efficient batch) batches of exactly
  // the efficient size, which strands whatever is left over: six and a half
  // batches' worth of RAM ran six (92% of it), two and a half ran two (80%), one
  // and nine tenths ran ONE (53%). Every depth is now tried with the fattest
  // batch that lets that many share the RAM.
  const sched = { lastLanding: 40_600, launchInterval: 1200, maxThreads: 250, planFor: planThreads };
  const eff = efficientThreads(sched);
  for (const batches of [1.9, 2.5, 3.4, 6.5]) {
    const totalRam = planThreads(eff).ram * batches;
    const c = planCycle({ totalRam, ...sched });
    const old = Math.floor(batches) * planThreads(eff).hackedFraction;
    assert.ok(c.depth * c.plan.ram <= totalRam + 1e-9, "the window must fit its RAM");
    assert.ok(c.depth * c.plan.hackedFraction >= old, `${batches} batches' worth: steals less than the old plan`);
    assert.ok(c.depth * c.plan.ram >= totalRam * 0.9,
      `${batches} batches' worth: only ${((c.depth * c.plan.ram / totalRam) * 100).toFixed(0)}% of the RAM in use`);
    // ...and no other depth does better with its own fattest batch - beyond the
    // margin the efficient-size window is given the benefit of (3%).
    for (let depth = 1; depth <= 34; depth++) {
      const plan = largestBatch({ ramBudget: totalRam / depth, maxThreads: 250, planFor: planThreads });
      if (plan) assert.ok(depth * plan.hackedFraction <= c.depth * c.plan.hackedFraction * 1.03 + 1e-12, `depth ${depth} steals more`);
    }
  }
  // A window the search cannot clearly improve on stays as it was: two
  // efficient batches' worth of RAM is two efficient batches (one batch of
  // twice the size steals exactly as much)...
  const exact = planCycle({ totalRam: planThreads(eff).ram * 2 + 0.01, ...sched });
  assert.equal(exact.depth, 2);
  assert.equal(exact.plan.hackThreads, eff);
  assert.equal(exact.cost, exact.plan.ram);
  // ...and when the search does win, it is by more than its margin. (In this
  // grow model a batch goes on getting cheaper per hack thread up to ~100 of
  // them, so six batches' worth is better spent on two fat ones.)
  const six = planCycle({ totalRam: planThreads(eff).ram * 6 + 0.01, ...sched });
  assert.ok(six.depth < 6 && six.plan.hackThreads > eff, `depth ${six.depth} x ${six.plan.hackThreads} threads`);
  assert.ok(six.depth * six.plan.hackedFraction > 6 * planThreads(eff).hackedFraction * 1.03);
});

test("planCycle: the search does not trade a window that shrugs off a lost grow for one that does not", () => {
  // Six efficient batches' worth of RAM: 6 x 21 threads (4.2% bites), which the
  // search would spend on 2 x 65 (13%). One hack landing unrepaired on a 4.2%
  // bite stays inside the 5% drift tolerance and the padded grows close the
  // gap; on 13% the window drains and the target is re-prepped. `safeThreads`
  // is the thread count at that tolerance (25 here).
  const sched = { lastLanding: 40_600, launchInterval: 1200, maxThreads: 250, planFor: planThreads };
  const eff = efficientThreads(sched);
  const totalRam = planThreads(eff).ram * 6 + 0.01;
  const free = planCycle({ totalRam, ...sched });
  assert.ok(free.plan.hackedFraction > 0.05, `bite ${free.plan.hackedFraction}`);

  const safe = planCycle({ totalRam, safeThreads: 25, ...sched });
  assert.ok(safe.plan.hackThreads <= 25, `${safe.depth} x ${safe.plan.hackThreads} threads`);
  assert.ok(safe.depth * safe.plan.hackedFraction >= 6 * planThreads(eff).hackedFraction, "never less than the plain window");
  // ...and it is still searched inside the limit: 2.5 batches' worth is not two
  // efficient batches and half a batch of idle RAM.
  const filled = planCycle({ totalRam: planThreads(eff).ram * 2.5, safeThreads: 25, ...sched });
  assert.ok(filled.plan.hackThreads <= 25 && filled.depth * filled.plan.ram >= planThreads(eff).ram * 2.5 * 0.9,
    `${filled.depth} x ${filled.plan.hackThreads} threads`);

  // A plain window whose bite is past the tolerance already has nothing to
  // protect: the search is not held back.
  const fat = planCycle({ totalRam, safeThreads: 10, ...sched });
  assert.deepEqual([fat.depth, fat.plan.hackThreads], [free.depth, free.plan.hackThreads]);
});

test("planCycle: a thin window is sized on thinRam, a full window is fitted as it always was", () => {
  // totalRam is the manager's old count of the RAM in hand, which runs over
  // while a batch is landing; thinRam is the same counted leg by leg. A thin
  // window's bite is the budget over a handful of batches, so it must not see
  // the overrun - that is how a window got stuck one batch short of its depth.
  const sched = { lastLanding: 40_600, launchInterval: 1200, maxThreads: 250, planFor: planThreads };
  const eff = efficientThreads(sched);
  const real = planThreads(eff).ram * 4.4;
  const over = real * 1.25;                               // one landing batch counted twice
  const thin = planCycle({ totalRam: over, thinRam: real, ...sched });
  assert.deepEqual([thin.depth, thin.plan.hackThreads], (c => [c.depth, c.plan.hackThreads])(planCycle({ totalRam: real, ...sched })));
  assert.ok(thin.depth * thin.cost <= real + 1e-9, `${thin.depth} x ${thin.cost}GB planned into ${real}GB`);
  const blind = planCycle({ totalRam: over, ...sched });
  assert.ok(blind.depth * blind.plan.ram > real, "sized on the overrun, the window does not fit the RAM there is");

  // Full depth (the budget carries efficient batches): thinRam changes nothing,
  // and the batch is the fattest that lets `depth` share totalRam as a pool.
  const rich = planThreads(eff + 10).ram * 34 + 1;
  const full = planCycle({ totalRam: rich, thinRam: rich * 0.9, ...sched });
  assert.equal(full.depth, 34);
  assert.equal(full.plan.hackThreads, eff + 10);
  assert.equal(full.cost, full.plan.ram);
});

test("largestBatch: a starting point (`from`) changes the search, never the answer", () => {
  for (const budget of [10, 37.5, 120, 333, 2000]) {
    const plain = largestBatch({ ramBudget: budget, maxThreads: 250, planFor: planThreads });
    for (const from of [1, 2, 7, 60, 249, 250, 400]) {
      const seeded = largestBatch({ ramBudget: budget, maxThreads: 250, planFor: planThreads, from });
      assert.equal(seeded?.hackThreads, plain?.hackThreads, `budget ${budget}, from ${from}`);
    }
  }
});

test("planBatch with the fleet's hosts: a grow no host can hold is planned as the split grow it will be", () => {
  // A 40% bite: 21 grow threads (36.75GB) - more than a 16GB host holds.
  const base = { hackThreads: 200, hackPct: 0.002, growThreadsFor, ramPerThread: RAM, minSecurity: 20, ...GAME };
  const pool = planBatch(base);
  assert.equal(pool.split, false);
  assert.equal(pool.growSeats, undefined, "no hosts described: nothing about packing");
  assert.equal(costAt(pool, 9), pool.ram);
  assert.equal(stolenAt(pool, 9), pool.hackedFraction);

  // Roomy hosts: every grow sits whole, the plan is the pool's plan.
  const roomy = planBatch({ ...base, hosts: [1024, 1024] });
  assert.equal(roomy.split, false);
  assert.equal(roomy.ram, pool.ram);
  assert.equal(roomy.growThreads, pool.growThreads);
  // A host seats as many grows as it holds; its hacks are counted with their
  // batch (one per whole batch, one more if a grow and a hack fit the remainder).
  const growRam = pool.growThreads * RAM.grow;
  const perHost = Math.floor(1024 / pool.ram);
  assert.equal(roomy.growSeats, 2 * Math.floor(1024 / growRam));
  assert.equal(roomy.wholeHacks, 2 * (perHost + (1024 - perHost * pool.ram >= growRam + 200 * RAM.hack ? 1 : 0)));
  assert.equal(costAt(roomy, 4), pool.ram);

  // Eight 16GB hosts (9 threads each): the grow cannot sit whole anywhere.
  const cramped = planBatch({ ...base, hosts: Array(8).fill(16) });
  const padded = splitGrowPadding({ growThreads: pool.growThreads, minSecurity: 20, ...GAME });
  assert.equal(cramped.split, true);
  assert.equal(cramped.growThreads, padded.growThreads);
  assert.ok(cramped.growThreads > pool.growThreads, "a split grow at security 20 needs padding");
  assert.equal(cramped.weaken2Threads, padded.weaken2Threads);
  assert.ok(cramped.ram > pool.ram);
  assert.equal(cramped.nominalRam, pool.ram, "the ranking still sees the batch a pool of RAM would run");
  assert.equal(cramped.splitExtra, 0, "the padding is in the plan already");
  assert.equal(cramped.growSeats, 0);

  // One big host and small ones: ONE grow at a time can be whole; the batches
  // past that are billed their padding.
  const mixed = planBatch({ ...base, hosts: [pool.growThreads * RAM.grow + 1, 16, 16, 16] });
  assert.equal(mixed.split, false);
  assert.equal(mixed.growSeats, 1);
  assert.ok(mixed.splitExtra > 0);
  assert.equal(costAt(mixed, 1), mixed.ram);
  assert.ok(Math.abs(costAt(mixed, 3) - (mixed.ram + mixed.splitExtra * 2 / 3)) < 1e-9);
});

test("REGRESSION: grows are seated on their own, not one per whole batch a host holds", () => {
  // A 57GB batch with a 26GB grow, on ten hosts of 131GB: each holds 2.3
  // batches but FOUR of the grows - the other legs go wherever they fit. Counted
  // one per whole batch (plus one if the remainder took a grow) that fleet
  // seated 20, a 30-batch window was billed for ten split grows that never
  // happened, and every bite shrank for it: on 26 hosts of 1TB a 60-batch window
  // of 290GB grows was told 52 fit, and earned 1.3% less than before.
  const plan = planBatch({ hackThreads: 15, hackPct: 0.02, growThreadsFor, ramPerThread: RAM, minSecurity: 20,
    hosts: Array(10).fill(131), ...GAME });
  const growRam = plan.growThreads * RAM.grow;
  assert.ok(Math.floor(131 / plan.ram) === 2 && Math.floor(131 / growRam) === 4, `batch ${plan.ram}GB, grow ${growRam}GB`);
  assert.equal(plan.growSeats, 40);
  assert.ok(plan.splitExtra > 0, "a split grow at security 20 would need padding");
  assert.equal(costAt(plan, 30), plan.ram, "thirty grows sit whole: nothing to bill");
  assert.equal(costAt(plan, 40), plan.ram);
  assert.ok(costAt(plan, 50) > plan.ram, "past the seats there are, the padding is billed");
});

test("stolenAt: a hack leg that has to be split takes less than its bite", () => {
  // 100 hack threads of 0.5% each = a 50% bite; in many pieces it takes 1 - e^-0.5.
  const plan = planBatch({ hackThreads: 100, hackPct: 0.005, maxHackFraction: 0.9, growThreadsFor, ramPerThread: RAM,
    minSecurity: 5, hosts: [400, 16, 16, 16], ...GAME });
  assert.equal(plan.hackedFraction, 0.5);
  assert.equal(plan.wholeHacks, 1, "one host can seat the grow and the hack side by side");
  assert.equal(stolenAt(plan, 1), 0.5);
  const pieces = 1 - Math.exp(-0.5);
  assert.ok(Math.abs(stolenAt(plan, 2) - (0.5 + pieces) / 2) < 1e-12);
  assert.ok(stolenAt(plan, 5) < stolenAt(plan, 2));
});

// ── Sharing RAM between targets ──────────────────────────────────────────────

test("threadLadder climbs to maxThreads in ~1.5x steps", () => {
  assert.deepEqual(threadLadder(1), [1]);
  assert.deepEqual(threadLadder(4), [1, 2, 3, 4]);
  assert.deepEqual(threadLadder(30), [1, 2, 3, 4, 6, 9, 14, 21, 30]);
});

test("concaveHull: from the origin, slopes strictly falling, dominated points dropped", () => {
  const hull = concaveHull([
    { ram: 10, income: 1 },    // under the chord origin -> (20, 6)
    { ram: 20, income: 6 },
    { ram: 40, income: 9 },
    { ram: 50, income: 9 },    // more RAM, no more income
    { ram: 80, income: 12 },
  ]);
  assert.deepEqual(hull.map(p => p.ram), [0, 20, 40, 80]);
  const slopes = hull.slice(1).map((p, i) => (p.income - hull[i].income) / (p.ram - hull[i].ram));
  for (let i = 1; i < slopes.length; i++) assert.ok(slopes[i] < slopes[i - 1]);
  assert.deepEqual(concaveHull([]), [{ ram: 0, income: 0 }]);
});

test("incomeCurve: income is linear in the bite, RAM is not", () => {
  const pts = incomeCurve({
    maxMoney: 1e9, hackChance: 1, lastLanding: 40_600, launchInterval: 1200, maxThreads: 250, planFor: planThreads,
  });
  assert.equal(pts.at(-1).threads, 250);
  const at = h => pts.find(p => p.threads === h);
  assert.ok(Math.abs(at(250).income / at(1).income - 250) < 1e-6);
  // A fat bite costs more RAM per thread than a moderate one (its grow is bigger
  // out of proportion), and a one-thread batch more than either (all overhead).
  assert.ok(at(250).ram / 250 > at(72).ram / 72);
  assert.ok(at(1).ram > at(72).ram / 72 * 2);
  // maxDepth stretches the interval: fewer batches in the window, less RAM and income.
  const capped = incomeCurve({
    maxMoney: 1e9, hackChance: 1, lastLanding: 40_600, launchInterval: 1200, maxThreads: 250, planFor: planThreads, maxDepth: 10,
  });
  assert.ok(capped.at(-1).ram < pts.at(-1).ram && capped.at(-1).income < pts.at(-1).income);
});

// Two-segment curves: `a` RAM at slope `s1`, then `b` more at slope `s2`.
const curve = (key, a, s1, b, s2, minRam = 1) => ({
  key, minRam, points: [{ ram: a, income: a * s1 }, { ram: a + b, income: a * s1 + b * s2 }],
});
const shares = list => Object.fromEntries(list.map(e => [e.key, e.ram]));

test("REGRESSION: allocateRam takes the best gigabytes of each target, not all of the best target", () => {
  // "rich" pays 10/GB on its first 100GB and 1/GB on the next 400; "next" pays
  // 5/GB on 100GB. The old spill gave rich all 200GB (income 1,100).
  const list = allocateRam({ totalRam: 200, maxTargets: 6, curves: [curve("rich", 100, 10, 400, 1), curve("next", 100, 5, 100, 0.5)] });
  assert.deepEqual(shares(list), { rich: 100, next: 100 });
  assert.equal(list.reduce((s, e) => s + e.income, 0), 1500);
  assert.equal(list[0].key, "rich", "best earner first");
});

test("allocateRam: a small botnet goes on one target, a huge one saturates them all", () => {
  const curves = [curve("rich", 100, 10, 400, 1), curve("next", 100, 5, 100, 0.5)];
  assert.deepEqual(shares(allocateRam({ totalRam: 60, maxTargets: 6, curves })), { rich: 60 });
  assert.deepEqual(shares(allocateRam({ totalRam: 1e6, maxTargets: 6, curves })), { rich: 500, next: 200 });
  assert.deepEqual(allocateRam({ totalRam: 0, maxTargets: 6, curves }), []);
});

test("allocateRam: opening a target needs a whole batch, and a worthwhile slice after the first", () => {
  // 30GB left for "next", whose smallest batch is 50GB: it stays shut.
  const curves = [curve("rich", 100, 10, 400, 1), curve("next", 100, 5, 100, 0.5, 50)];
  assert.deepEqual(shares(allocateRam({ totalRam: 130, maxTargets: 6, curves })), { rich: 130 });
  // minTargetRam binds on the second target only - the first is always served.
  const small = [curve("rich", 100, 10, 0.001, 1), curve("next", 100, 5, 100, 0.5)];
  assert.deepEqual(Object.keys(shares(allocateRam({ totalRam: 140, maxTargets: 6, minTargetRam: 64, curves: small }))), ["rich"]);
  assert.deepEqual(shares(allocateRam({ totalRam: 20, maxTargets: 6, minTargetRam: 64, curves: small })), { rich: 20 });
});

test("allocateRam: with RAM to spare, the slots go to the richest targets, not the most efficient", () => {
  // "cheap" is the better use of a gigabyte but can only ever absorb 10 of them.
  const curves = [curve("cheap", 10, 20, 0.001, 1), curve("big", 1000, 5, 1000, 2)];
  // RAM-bound: efficiency decides, and both fit anyway.
  assert.deepEqual(shares(allocateRam({ totalRam: 100, maxTargets: 2, curves })), { cheap: 10, big: 90 });
  // One slot, plenty of RAM: the efficient-first greedy would spend it on "cheap".
  assert.deepEqual(shares(allocateRam({ totalRam: 5000, maxTargets: 1, curves })), { big: 2000 });
  // One slot, 8GB: now "cheap" really is the better target.
  assert.deepEqual(shares(allocateRam({ totalRam: 8, maxTargets: 1, curves })), { cheap: 8 });
});

test("allocateRam: the bonus tilts the choice without inflating the reported income", () => {
  const curves = [curve("held", 100, 5, 100, 1), curve("rival", 100, 5.5, 100, 1)];
  assert.equal(shares(allocateRam({ totalRam: 100, maxTargets: 6, curves })).rival, 100);
  const sticky = allocateRam({ totalRam: 100, maxTargets: 6, curves, bonus: k => (k === "held" ? 1.15 : 1) });
  assert.deepEqual(shares(sticky), { held: 100 });
  assert.equal(sticky[0].income, 500);
});

test("prepDiscount: a target that must be prepped first is worth less, never nothing", () => {
  assert.equal(prepDiscount(0, 3_600_000), 1);
  assert.equal(prepDiscount(3_600_000, 3_600_000), 0.5);
  assert.ok(prepDiscount(60_000, 3_600_000) > 0.98);
  assert.ok(prepDiscount(1e9, 3_600_000) > 0);
});

// ── When money is not the point (BN8) ────────────────────────────────────────

test("preferredWishes: only a fresh list that asks to be preferred changes anything", () => {
  const list = { up: ["a", "b", "c"], down: ["d"], prefer: true, updatedAt: 1_000_000 };
  const at = age => preferredWishes(list, 1_000_000 + age, 120_000, 0.5);

  // Every other BitNode publishes prefer: false - the ranking must not move.
  assert.equal(preferredWishes({ ...list, prefer: false }, 1_000_000, 120_000, 0.5), null);
  assert.equal(preferredWishes(undefined, 1_000_000, 120_000, 0.5), null);
  assert.equal(preferredWishes(null, 1_000_000, 120_000, 0.5), null);
  // Truthy is not `true`: a list somebody half-wrote is nobody's wish.
  assert.equal(preferredWishes({ ...list, prefer: 1 }, 1_000_000, 120_000, 0.5), null);
  // Stale after two minutes (the workers' own rule), and with no timestamp at all.
  assert.ok(at(119_999) instanceof Map);
  assert.equal(at(120_000), null);
  assert.equal(at(-200_000), null, "a timestamp from the future is not fresh");
  assert.equal(preferredWishes({ up: ["a"], prefer: true }, 1_000_000, 120_000, 0.5), null);

  // Weight falls by `decay` per place, within each list.
  assert.deepEqual([...at(0)], [["a", 1], ["b", 0.5], ["c", 0.25], ["d", 1]]);
  // An empty list is still the BN8 signal (nothing to push, exp for everything).
  assert.equal(preferredWishes({ up: [], down: [], prefer: true, updatedAt: 5 }, 5, 120_000, 0.5).size, 0);
  // Junk in a list is skipped; a host in both keeps its better place.
  assert.deepEqual([...preferredWishes({ up: ["a", 7, "b"], down: ["b"], prefer: true, updatedAt: 5 }, 5, 120_000, 0.5)],
    [["a", 1], ["b", 1]]);
});

test("expCurve: exp is threads landed per interval - the bite hardly matters, the server does", () => {
  const sched = { lastLanding: 40_600, launchInterval: 1200, maxThreads: 250, planFor: planThreads, hackChance: 1 };
  const pts = expCurve({ ...sched, minSecurity: 5 });
  assert.equal(pts.length, threadLadder(250).length);
  const perGb = pts.map(p => p.income / p.ram);
  // Every thread is worth the same and costs about the same: flat to within the
  // hack thread's 3% discount.
  assert.ok(Math.max(...perGb) / Math.min(...perGb) < 1.04, `exp per GB varies ${Math.min(...perGb)}..${Math.max(...perGb)}`);
  const plan = planThreads(250);
  const threads = plan.hackThreads + plan.growThreads + plan.weaken1Threads + plan.weaken2Threads;
  assert.ok(Math.abs(pts.at(-1).income - threads * expPerThread(5) / 1200) < 1e-9);
  assert.equal(pts.at(-1).ram, 34 * plan.ram);
  // A failed hack is worth a quarter: half the hacks failing costs 3/8 of the hack threads' exp.
  const half = expCurve({ ...sched, hackChance: 0.5, minSecurity: 5 }).at(-1).income;
  assert.ok(Math.abs(half - (threads - 250 * 0.375) * expPerThread(5) / 1200) < 1e-9);
  // Harder servers pay more per thread (3 + 0.3 x base security, base ~ 3 x min).
  assert.equal(expPerThread(5), 7.5);
  assert.ok(expCurve({ ...sched, minSecurity: 20 }).at(-1).income > pts.at(-1).income * 2);
});

test("capProcesses: windows are kept best first until the process budget is spent", () => {
  const windows = [
    { target: "a", depth: 240, income: 2400 },
    { target: "b", depth: 240, income: 1200 },
    { target: "c", depth: 60, income: 60 },
  ];
  // Room for everything: nothing is touched.
  const all = capProcesses(windows, 4 * 540);
  assert.equal(all.trimmed, false);
  assert.deepEqual(all.kept.map(w => [w.target, w.depth]), [["a", 240], ["b", 240], ["c", 60]]);
  assert.equal(all.processes, 2160);
  assert.equal(all.income, 3660);
  // 3,000 processes = 750 batches: a and b whole, c never opened.
  const some = capProcesses(windows, 4 * 480);
  assert.equal(some.trimmed, true);
  assert.deepEqual(some.kept.map(w => [w.target, w.depth]), [["a", 240], ["b", 240]]);
  // The window that crosses the budget is cut to what is left, its income with it.
  const cut = capProcesses(windows, 4 * 300);
  assert.deepEqual(cut.kept.map(w => [w.target, w.depth, w.income]), [["a", 240, 2400], ["b", 60, 300]]);
  assert.equal(cut.processes, 1200);
  assert.equal(cut.income, 2700);
  assert.deepEqual(capProcesses(windows, 3).kept, [], "less than one batch's worth of processes");
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

// ── RAM ──────────────────────────────────────────────────────────────────────

/**
 * The identifier tokens of a source file: comments, quoted strings and the TEXT
 * of template literals dropped, `${...}` expressions kept. That is what the
 * game's RAM analyser sees - it bills every identifier and every dotted property
 * name that matches an ns function, whatever object it hangs off.
 */
function identifiers(src) {
  const out = [];
  const templates = [];   // brace depth at which each open `${` closes
  let depth = 0;
  for (let i = 0; i < src.length;) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (two === "//") { i = src.indexOf("\n", i); if (i < 0) break; continue; }
    if (two === "/*") { i = src.indexOf("*/", i) + 2; continue; }
    if (c === '"' || c === "'") {
      for (i++; src[i] !== c; i++) if (src[i] === "\\") i++;
      i++;
      continue;
    }
    if (c === "`" || (c === "}" && templates.at(-1) === depth)) {
      if (c === "}") templates.pop();
      for (i++; src[i] !== "`"; i++) {
        if (src[i] === "\\") i++;
        else if (src[i] === "$" && src[i + 1] === "{") { templates.push(depth); i++; break; }
      }
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    const word = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 64));
    if (word) { out.push(word[0]); i += word[0].length; } else i++;
  }
  return out;
}

test("RAM: nothing the batcher reaches names `share` - an identifier of that name is billed as ns.share (2.4GB)", async () => {
  const { readFileSync } = await import("node:fs");
  const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
  // The tokenizer itself: strings and template text are not identifiers, ${} is.
  assert.deepEqual(identifiers('a.b("share"); // share\n x = `share ${c.share} share`; /* share */ d["share"]'),
    ["a", "b", "x", "c", "share", "d"]);

  // hacking/manager.js and everything it pulls in whole (its own functions all
  // count, as do those of a namespace import), plus the one-shot status tool.
  // Only hacking/share.js calls ns.share; CONFIG["share"] is how the rest read
  // its config. (12.35GB -> 9.95GB for the manager when this was fixed.)
  for (const path of ["../hacking/manager.js", "../lib/batch-logic.js", "../lib/formulas.js", "../lib/net.js",
    "../lib/events.js", "../lib/ns-utils.js", "../tools/hack-status.js"]) {
    assert.ok(!identifiers(read(path)).includes("share"), `${path} has an identifier or property named share`);
  }
  assert.ok(identifiers(read("../hacking/share.js")).includes("share"), "the tokenizer no longer sees ns.share in share.js");
});
