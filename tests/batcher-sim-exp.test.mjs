// tests/batcher-sim-exp.test.mjs
// hacking/manager.js's hacking-exp objectives, in every node, end to end on the
// fake botnet (tests/helpers/fake-botnet.mjs), on the ns.* fallback path (one
// path per process: lib/formulas.js caches whether Formulas.exe is there, so a
// second path in the same file would silently re-run the first):
//   - the exp LEFTOVER: RAM the income plan cannot use goes to exp windows
//     instead of idling, and income is untouched;
//   - the exp GOAL: while the daemon publishes globalThis.gordHackGoal = "exp"
//     (or the config forces it) the whole botnet trains hacking exp.
// Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, outOfOrder, H } from "./helpers/fake-botnet.mjs";
import { step, newSchedulerState, resetCaches } from "../hacking/manager.js";

/**
 * Drive a world for `minutes` under config patches (restored after), with an
 * optional hook before each tick.
 */
function expRun(base, opts, patch, minutes, each = null) {
  const saved = { maxTargets: H.maxTargets, adaptive: H.adaptive.enabled, leftover: H.expFarm.leftover.enabled, goal: H.expFarm.goal };
  if (patch.maxTargets != null) H.maxTargets = patch.maxTargets;
  if (patch.adaptive != null) H.adaptive.enabled = patch.adaptive;
  if (patch.leftover != null) H.expFarm.leftover.enabled = patch.leftover;
  if (patch.goal !== undefined) H.expFarm.goal = patch.goal;
  resetCaches();
  for (const k of ["gordReservedHosts", "gordReservedRam", "gordReservedRamAt", "gordState", "gordStockWishes", "gordHackRate", "gordHackGoal"]) delete globalThis[k];
  try {
    const { world, ns, advance } = makeWorld({ ...base, ...opts });
    const s = newSchedulerState();
    const modes = [];
    for (let i = 0; i < minutes * 300; i++) {
      if (each) each(world, i);
      modes.push(step(ns, s, world.clock));
      advance(H.batchSpacingMs);
    }
    return { world, s, modes, state: globalThis.gordHackState, order: outOfOrder(world) };
  } finally {
    H.maxTargets = saved.maxTargets;
    H.adaptive.enabled = saved.adaptive;
    H.expFarm.leftover.enabled = saved.leftover;
    H.expFarm.goal = saved.goal;
    delete globalThis.gordHackGoal;
  }
}

/** Every batch landed H W G W, no exec over-commit, no drift, every hack on a prepped server. */
function assertClean(r, name) {
  assert.deepEqual(r.order.bad, [], `${name}: batches landed out of order`);
  assert.equal(r.world.execFailures, 0, `${name}: exec over-committed`);
  assert.equal(r.modes.filter(m => m.startsWith("Draining")).length, 0, `${name}: drift`);
  const bad = r.world.hackLandings.filter(h => h.moneyFrac < 0.995 || h.secOver > 0.01);
  assert.equal(bad.length, 0, `${name}: ${bad.length} hacks landed unprepped`);
}

{
  const base = { formulas: false };
  const label = " [ns.* fallback]";

  test("exp leftover: RAM the income plan cannot use trains hacking exp, and income is untouched" + label, () => {
    // Nine n00dles-alikes, 32TB, room for three money windows: the income plan
    // is full long before the fleet is, and without the leftover most of it idles.
    const opts = { tinyCount: 9, onlyTiny: true, w1Ram: 16384, w2Ram: 16384 };
    const patch = { maxTargets: 3, adaptive: false };
    const off = expRun(base, opts, { ...patch, leftover: false }, 6);
    const on = expRun(base, opts, { ...patch, leftover: true }, 6);
    const exp = on.state.targets.filter(t => t.objective === "exp");
    assert.ok(exp.length >= 1, `no exp window: ${JSON.stringify(on.state.targets)}`);
    assert.ok(on.state.targets.slice(0, 3).every(t => t.objective === undefined), "the money targets come first");
    assert.ok(on.world.exp >= off.world.exp * 1.5, `exp ${off.world.exp.toExponential(2)} -> ${on.world.exp.toExponential(2)}`);
    // Income: the money windows are serviced first, out of the same budget.
    assert.ok(on.world.stolen >= off.world.stolen * 0.97,
      `income $${off.world.stolen.toExponential(3)} -> $${on.world.stolen.toExponential(3)}`);
    assert.equal(on.state.goal, "money");
    assert.ok(on.state.exp.targets === exp.length && on.state.exp.plannedPerSec > 0 && on.state.exp.ram > 0,
      `gordHackState.exp: ${JSON.stringify(on.state.exp)}`);
    assert.ok(on.state.exp.perSec > 0, "the measured exp rate is published");
    assertClean(off, "leftover off");
    assertClean(on, "leftover on");
    console.log(`#${label} leftover: exp ${off.world.exp.toExponential(3)} -> ${on.world.exp.toExponential(3)} ` +
      `(x${(on.world.exp / off.world.exp).toFixed(2)}), income $${off.world.stolen.toExponential(3)} -> $${on.world.stolen.toExponential(3)}`);
  });

  test("exp leftover: a fleet the income plan fills is left exactly as it was" + label, () => {
    const plain = expRun(base, {}, { leftover: false }, 4);
    const same = expRun(base, {}, { leftover: true }, 4);
    assert.equal(same.world.stolen, plain.world.stolen);
    assert.equal(same.state.exp.targets, 0);
  });

  test("exp goal: the whole botnet trains hacking exp while the daemon asks, and goes back to income after" + label, () => {
    const opts = { tinyCount: 3, w1Ram: 4096, w2Ram: 2048 };
    const money = expRun(base, opts, {}, 6);
    let during = null;
    const exp = expRun(base, opts, {}, 12, (world, i) => {
      // The daemon publishes the goal (after The Red Pill); here for six minutes, then not.
      if (i === 0) globalThis.gordHackGoal = "exp";
      if (i === 6 * 300) {
        during = { state: globalThis.gordHackState, exp: world.exp, stolen: world.stolen };
        delete globalThis.gordHackGoal;
      }
    });
    assert.equal(during.state.goal, "exp");
    assert.ok(during.state.targets.every(t => t.objective === "exp"), JSON.stringify(during.state.targets));
    assert.equal(during.state.stockPush, false);
    assert.ok(during.exp >= money.world.exp * 1.2,
      `exp in six minutes: ${money.world.exp.toExponential(2)} money mode, ${during.exp.toExponential(2)} exp mode`);
    // ...and back: the income ranking, and money coming in again.
    assert.equal(exp.state.goal, "money");
    assert.ok(exp.state.targets.some(t => t.objective === undefined), "back to the income plan");
    assert.ok(exp.world.stolen > during.stolen, "income resumes");
    // The config can force it.
    const forced = expRun(base, opts, { goal: "exp" }, 2);
    assert.equal(forced.state.goal, "exp");
    assertClean(exp, "goal");
    assertClean(forced, "forced");
    console.log(`#${label} goal: exp in 6 min ${money.world.exp.toExponential(3)} (money) -> ${during.exp.toExponential(3)} (exp), ` +
      `x${(during.exp / money.world.exp).toFixed(2)}`);
  });
}
