// tests/stanek-logic.test.mjs
// Unit tests for the pure Stanek's Gift logic (lib/stanek-logic.js), plus a run
// of the manager (lib/stanek.js) against a fake gift and a fake botnet, and the
// HUD cards (ui/stanek.js). Run: npm test  (needs Node >=20).
//
// FRAGMENTS below is the game's own table, transcribed from bitburner-src
// (branch dev, 2026-10) src/CotMG/Fragment.ts and src/CotMG/data/Shapes.ts:
// id, shape, FragmentType number, power, limit - in the shape
// ns.stanek.fragmentDefinitions() returns them.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FRAGMENT_TYPE,
  LAYOUT_DEFAULTS,
  typeName,
  typeLabel,
  isBooster,
  gridSize,
  rotatedWidth,
  rotatedHeight,
  fullAt,
  shapeCells,
  orientations,
  cellsOf,
  chooseFragments,
  weightOf,
  boostsOf,
  withDefs,
  layoutValue,
  layoutProblems,
  layoutKey,
  planLayout,
  layoutDecision,
  chargeEffect,
  chargeAfter,
  nextCharge,
  chargeRotation,
  chargeFraction,
  planChargeHosts,
  tendHost,
  holdThreads,
  giftGate,
  chargeHolds,
  mergeHolds,
} from "../lib/stanek-logic.js";
import { CONFIG, forNode } from "../lib/config.js";
import { COLORS } from "../ui/dashboard-lib.js";
import { extraCards, chargedFragments, bonusText } from "../ui/stanek.js";
import { main as stanekMain } from "../lib/stanek.js";
import { main as bootMain } from "../early/stanek-boot.js";

const _ = false;
const X = true;
// src/CotMG/data/Shapes.ts
const SHAPES = {
  O: [[X, X], [X, X]],
  I: [[X, X, X, X]],
  L: [[_, _, X], [X, X, X]],
  J: [[X, _, _], [X, X, X]],
  S: [[_, X, X], [X, X, _]],
  Z: [[X, X, _], [_, X, X]],
  T: [[X, X, X], [_, X, _]],
};
const frag = (id, shape, type, power, limit = 1) => ({ id, shape, type, power, limit, effect: "" });
// src/CotMG/Fragment.ts, in file order.
const FRAGMENTS = [
  frag(0, SHAPES.S, FRAGMENT_TYPE.hacking, 1),
  frag(1, SHAPES.Z, FRAGMENT_TYPE.hacking, 1),
  frag(5, SHAPES.T, FRAGMENT_TYPE.hackingSpeed, 1.3),
  frag(6, SHAPES.I, FRAGMENT_TYPE.hackingMoney, 2),
  frag(7, SHAPES.J, FRAGMENT_TYPE.hackingGrow, 0.5),
  frag(10, SHAPES.T, FRAGMENT_TYPE.strength, 2),
  frag(12, SHAPES.L, FRAGMENT_TYPE.defense, 2),
  frag(14, SHAPES.L, FRAGMENT_TYPE.dexterity, 2),
  frag(16, SHAPES.S, FRAGMENT_TYPE.agility, 2),
  frag(18, SHAPES.S, FRAGMENT_TYPE.charisma, 3),
  frag(20, SHAPES.I, FRAGMENT_TYPE.hacknetMoney, 1),
  frag(21, SHAPES.O, FRAGMENT_TYPE.hacknetCost, 2),
  frag(25, SHAPES.J, FRAGMENT_TYPE.rep, 0.5),
  frag(27, SHAPES.J, FRAGMENT_TYPE.workMoney, 10),
  frag(28, SHAPES.L, FRAGMENT_TYPE.crime, 2),
  frag(30, SHAPES.S, FRAGMENT_TYPE.bladeburner, 0.4),
  frag(100, [[_, X, X], [X, X, _], [_, X, _]], FRAGMENT_TYPE.booster, 1.1, 99),
  frag(101, [[X, X, X, X], [X, _, _, _]], FRAGMENT_TYPE.booster, 1.1, 99),
  frag(102, [[_, X, X, X], [X, X, _, _]], FRAGMENT_TYPE.booster, 1.1, 99),
  frag(103, [[X, X, X, _], [_, _, X, X]], FRAGMENT_TYPE.booster, 1.1, 99),
  frag(104, [[_, X, X], [_, X, _], [X, X, _]], FRAGMENT_TYPE.booster, 1.1, 99),
  frag(105, [[_, _, X], [_, X, X], [X, X, _]], FRAGMENT_TYPE.booster, 1.1, 99),
  frag(106, [[X, _, _], [X, X, X], [X, _, _]], FRAGMENT_TYPE.booster, 1.1, 99),
  frag(107, [[_, X, _], [X, X, X], [_, X, _]], FRAGMENT_TYPE.booster, 1.1, 99),
];
const DEF = new Map(FRAGMENTS.map(f => [f.id, f]));
const PROFILES = CONFIG.stanek.profiles;
const BLADE = PROFILES.bladeburner;
const HACKING = PROFILES.hacking;

/** A placed fragment as ns.stanek.activeFragments() reports it. */
const placed = (id, x, y, rotation = 0, highestCharge = 0, numCharge = 0) =>
  ({ ...DEF.get(id), x, y, rotation, highestCharge, numCharge, chargedEffect: 1 });

/** "x,y" strings of a cell list, sorted - for comparing shapes. */
const keys = cells => cells.map(c => c.join(",")).sort();

// ── Types and grid ───────────────────────────────────────────────────────────

test("fragment types carry the game's numbers and readable names", () => {
  assert.equal(FRAGMENT_TYPE.hackingSpeed, 3);
  assert.equal(FRAGMENT_TYPE.bladeburner, 17);
  assert.equal(FRAGMENT_TYPE.booster, 18);
  assert.equal(typeName(7), "strength");
  assert.equal(typeName(99), null);
  assert.equal(typeLabel(17), "Bladeburner");
  assert.equal(typeLabel(14), "Reputation");
  assert.ok(isBooster(DEF.get(104)));
  assert.ok(!isBooster(DEF.get(30)));
  // The fixture is the whole table: 16 stat fragments, 8 boosters.
  assert.equal(FRAGMENTS.filter(f => !isBooster(f)).length, 16);
  assert.equal(FRAGMENTS.filter(isBooster).length, 8);
});

test("gridSize is the game's width/height for a base size", () => {
  // BN13: 9 + ExtraSize 1 + SF13 level 0..3.
  assert.deepEqual(gridSize(10), { width: 6, height: 5 });
  assert.deepEqual(gridSize(11), { width: 6, height: 6 });
  assert.deepEqual(gridSize(12), { width: 7, height: 6 });
  assert.deepEqual(gridSize(13), { width: 7, height: 7 });
  // BN8's ExtraSize -99 hits the floor; nothing exceeds the 25 cap.
  assert.deepEqual(gridSize(-87), { width: 2, height: 3 });
  assert.deepEqual(gridSize(1000), { width: 25, height: 25 });
});

// ── Geometry ─────────────────────────────────────────────────────────────────

test("rotation matches Fragment.fullAt: the T through all four turns", () => {
  const T = SHAPES.T; // XXX / _X_
  assert.deepEqual(keys(shapeCells(T, 0)), keys([[0, 0], [1, 0], [2, 0], [1, 1]]));
  // 1: _X / XX / _X     2: _X_ / XXX     3: X_ / XX / X_
  assert.deepEqual(keys(shapeCells(T, 1)), keys([[1, 0], [0, 1], [1, 1], [1, 2]]));
  assert.deepEqual(keys(shapeCells(T, 2)), keys([[1, 0], [0, 1], [1, 1], [2, 1]]));
  assert.deepEqual(keys(shapeCells(T, 3)), keys([[0, 0], [0, 1], [1, 1], [0, 2]]));
  assert.equal(rotatedWidth(T, 0), 3);
  assert.equal(rotatedHeight(T, 0), 2);
  assert.equal(rotatedWidth(T, 1), 2);
  assert.equal(rotatedHeight(T, 1), 3);
  assert.equal(fullAt(T, 1, 1, 0), true);
  assert.equal(fullAt(T, 0, 1, 0), false);
  assert.equal(fullAt(T, 3, 0, 0), false, "outside the bounding box");
  assert.equal(fullAt(T, -1, 0, 0), false);
});

test("rotation keeps chirality: an L never turns into a J", () => {
  const L = SHAPES.L; // __X / XXX
  // 1: X_ / X_ / XX     3: XX / _X / _X
  assert.deepEqual(keys(shapeCells(L, 1)), keys([[0, 0], [0, 1], [0, 2], [1, 2]]));
  assert.deepEqual(keys(shapeCells(L, 2)), keys([[0, 0], [1, 0], [2, 0], [0, 1]]));
  assert.deepEqual(keys(shapeCells(L, 3)), keys([[0, 0], [1, 0], [1, 1], [1, 2]]));
  const jShapes = new Set([0, 1, 2, 3].map(r => keys(shapeCells(SHAPES.J, r)).join(";")));
  for (const r of [0, 1, 2, 3]) {
    assert.ok(!jShapes.has(keys(shapeCells(L, r)).join(";")), `L rotation ${r} is a J`);
  }
});

test("every rotation of every fragment keeps its cells, inside its box", () => {
  for (const f of FRAGMENTS) {
    const count = f.shape.flat().filter(Boolean).length;
    assert.equal(count, isBooster(f) ? 5 : 4, `fragment ${f.id} size`);
    for (const r of [0, 1, 2, 3]) {
      const cells = shapeCells(f.shape, r);
      assert.equal(cells.length, count, `fragment ${f.id} rotation ${r}`);
      for (const [x, y] of cells) {
        assert.ok(x >= 0 && x < rotatedWidth(f.shape, r) && y >= 0 && y < rotatedHeight(f.shape, r));
      }
      // The root is the top-left of the bounding box: something touches each edge.
      assert.ok(cells.some(c => c[0] === 0) && cells.some(c => c[1] === 0), `fragment ${f.id} r${r} root`);
    }
  }
});

test("orientations drops rotations that repeat a shape", () => {
  const n = id => orientations(DEF.get(id).shape).length;
  assert.equal(n(21), 1, "O");
  assert.equal(n(6), 2, "I");
  assert.equal(n(0), 2, "S");
  assert.equal(n(1), 2, "Z");
  assert.equal(n(5), 4, "T");
  assert.equal(n(12), 4, "L");
  assert.equal(n(7), 4, "J");
  assert.equal(n(107), 1, "the plus booster");
  assert.equal(n(104), 2, "the S-pentomino booster");
  assert.equal(n(101), 4);
  assert.equal(n(106), 4);
  // The surviving rotation is always the lowest number.
  assert.deepEqual(orientations(SHAPES.I).map(o => o.rotation), [0, 1]);
});

test("cellsOf places a rotated shape at its root", () => {
  assert.deepEqual(keys(cellsOf({ x: 2, y: 1, rotation: 1 }, SHAPES.I)), keys([[2, 1], [2, 2], [2, 3], [2, 4]]));
});

// ── Fragment choice ──────────────────────────────────────────────────────────

test("chooseFragments: only weighted types, heaviest first, boosters apart", () => {
  const { stats, boosters } = chooseFragments(FRAGMENTS, HACKING);
  assert.deepEqual(boosters.map(b => b.id), [100, 101, 102, 103, 104, 105, 106, 107]);
  // Both Hacking fragments take the `hacking` weight; nothing unlisted appears.
  assert.deepEqual(stats.map(s => s.id), [0, 1, 5, 6, 25, 7]);
  assert.deepEqual(stats.map(s => s.weight), [10, 10, 8, 8, 6, 4]);
  assert.ok(stats.every(s => s.name && HACKING[s.name] > 0));

  const blade = chooseFragments(FRAGMENTS, BLADE).stats;
  assert.equal(blade[0].id, 30, "the Bladeburner fragment leads the BN13 table");
  assert.deepEqual(blade.slice(1, 5).map(s => s.id), [10, 12, 14, 16], "then the four combat stats");
  assert.ok(!blade.some(s => [20, 21, 27].includes(s.id)), "hacknet and work money are not in it");

  assert.deepEqual(chooseFragments(FRAGMENTS, {}).stats, []);
  assert.deepEqual(chooseFragments(FRAGMENTS, { strength: 0, agility: -3 }).stats, []);
  assert.deepEqual(chooseFragments(null, HACKING), { stats: [], boosters: [] });
  assert.equal(weightOf(DEF.get(30), BLADE), 10);
  assert.equal(weightOf(DEF.get(107), BLADE), 0);
  assert.equal(weightOf(DEF.get(20), BLADE), 0);
});

test("config: every profile names real fragment types, and the default profile exists", () => {
  for (const [name, table] of Object.entries(PROFILES)) {
    for (const [type, weight] of Object.entries(table)) {
      assert.ok(type in FRAGMENT_TYPE && type !== "booster", `${name}.${type} is not a fragment type`);
      assert.ok(typeof weight === "number" && weight >= 0, `${name}.${type}`);
    }
  }
  for (const node of [0, 1, 6, 7, 9, 13]) {
    const S = forNode(node).stanek;
    assert.ok(S.profiles[S.profile], `node ${node}: profile "${S.profile}" exists`);
    assert.ok(S.ramFraction >= 0 && S.ramFraction <= 1);
  }
  assert.equal(CONFIG.stanek.layout.relayoutCharged, false, "a charged layout is never cleared by default");
});

// ── Reading a layout ─────────────────────────────────────────────────────────

test("boostsOf counts distinct touching boosters, as StaneksGift.effect does", () => {
  // Strength T at 0,0        = (0,0)(1,0)(2,0)(1,1)
  // booster 101 at 0,2       = (0,2)(1,2)(2,2)(3,2)(0,3)   - (1,2) is under the T's (1,1)
  // plus booster 107 at 3,0  = (4,0)(3,1)(4,1)(5,1)(4,2)   - a diagonal neighbour only
  const layout = [placed(10, 0, 0), placed(101, 0, 2), placed(107, 3, 0)];
  assert.deepEqual(layoutProblems(layout, FRAGMENTS, 6, 5), []);
  const b = boostsOf(layout);
  assert.equal(b[0].count, 1, "diagonal contact does not count");
  assert.ok(Math.abs(b[0].boost - 1.1) < 1e-12);
  assert.deepEqual(b[1], { count: 0, boost: 1 }, "boosters report no boost of their own");
  assert.deepEqual(b[2], { count: 0, boost: 1 });
});

test("boostsOf: two boosters multiply, two contacts with one booster count once", () => {
  // Hacknet-cost O at 2,2    = (2,2)(3,2)(2,3)(3,3)
  // booster 106 at 4,1       = (4,1)(4,2)(5,2)(6,2)(4,3)   - touches the O at (4,2) AND (4,3)
  // booster 101 at 0,1       = (0,1)(1,1)(2,1)(3,1)(0,2)   - (2,1) and (3,1) sit on top of it
  const layout = [placed(21, 2, 2), placed(106, 4, 1), placed(101, 0, 1)];
  assert.deepEqual(layoutProblems(layout, FRAGMENTS, 7, 5), []);
  assert.deepEqual(keys(cellsOf(layout[1], layout[1].shape)), keys([[4, 1], [4, 2], [5, 2], [6, 2], [4, 3]]));
  const b = boostsOf(layout);
  assert.equal(b[0].count, 2);
  assert.ok(Math.abs(b[0].boost - 1.21) < 1e-12);
  assert.equal(boostsOf(layout.slice(0, 2))[0].count, 1);

  // Stat fragments do not boost each other: two touching fragments, no booster.
  const pair = [placed(10, 0, 0), placed(5, 0, 2, 2)]; // a T, and a T upside down under it
  assert.deepEqual(boostsOf(pair).map(x => x.count), [0, 0]);
  assert.deepEqual(boostsOf([]), []);
});

test("layoutValue is sum(weight x boost); withDefs joins placements to definitions", () => {
  const layout = [{ id: 30, x: 0, y: 0, rotation: 0 }, { id: 10, x: 3, y: 0, rotation: 0 }, { id: 999, x: 0, y: 4, rotation: 0 }];
  assert.equal(withDefs(layout, FRAGMENTS).length, 2, "unknown ids are dropped");
  assert.equal(layoutValue(layout, FRAGMENTS, BLADE), 16);
  assert.equal(layoutValue(layout, FRAGMENTS, HACKING), 0);
  assert.equal(layoutValue([], FRAGMENTS, BLADE), 0);
});

test("layoutProblems catches what the game's canPlace would refuse", () => {
  const ok = [{ id: 30, x: 0, y: 0, rotation: 0 }, { id: 10, x: 3, y: 0, rotation: 0 }];
  assert.deepEqual(layoutProblems(ok, FRAGMENTS, 6, 5), []);
  assert.match(layoutProblems([{ id: 6, x: 3, y: 0, rotation: 0 }], FRAGMENTS, 6, 5)[0], /leaves the 6x5 grid/);
  assert.match(layoutProblems([{ id: 6, x: 0, y: 2, rotation: 1 }], FRAGMENTS, 6, 5)[0], /leaves/);
  assert.match(layoutProblems([{ id: 6, x: -1, y: 0, rotation: 0 }], FRAGMENTS, 6, 5)[0], /leaves/);
  assert.ok(layoutProblems([{ id: 10, x: 0, y: 0, rotation: 0 }, { id: 5, x: 1, y: 0, rotation: 0 }], FRAGMENTS, 6, 5)
    .some(p => /overlap/.test(p)));
  assert.ok(layoutProblems([{ id: 10, x: 0, y: 0, rotation: 0 }, { id: 10, x: 3, y: 2, rotation: 0 }], FRAGMENTS, 6, 5)
    .some(p => /limit/.test(p)));
  assert.ok(layoutProblems([{ id: 4242, x: 0, y: 0, rotation: 0 }], FRAGMENTS, 6, 5).some(p => /unknown/.test(p)));
  assert.ok(layoutProblems([{ id: 10, x: 0, y: 0, rotation: 7 }], FRAGMENTS, 6, 5).some(p => /rotation/.test(p)));
  // Boosters may repeat (limit 99).
  assert.deepEqual(layoutProblems([{ id: 107, x: 0, y: 0, rotation: 0 }, { id: 107, x: 3, y: 0, rotation: 0 }], FRAGMENTS, 6, 5), []);
  assert.equal(layoutKey(ok), layoutKey([...ok].reverse()), "the key ignores order");
});

// ── The packer ───────────────────────────────────────────────────────────────

const GRIDS = [[2, 3], [4, 3], [5, 4], [6, 5], [6, 6], [7, 6], [7, 7], [8, 7]];

/**
 * The true optimum, by enumerating every layout once: each cell in row-major
 * order is either left empty or is the FIRST cell of a placed piece. Only
 * feasible on tiny grids (4x3 is ~2,000 layouts).
 */
function exhaustiveBest(width, height, priorities) {
  const { stats, boosters } = chooseFragments(FRAGMENTS, priorities);
  const pieces = [...stats, ...boosters];
  const byFirst = Array.from({ length: width * height }, () => []);
  pieces.forEach((piece, pi) => {
    for (const o of orientations(piece.shape)) {
      for (let y = 0; y + o.height <= height; y++) {
        for (let x = 0; x + o.width <= width; x++) {
          const cells = o.cells.map(([dx, dy]) => (y + dy) * width + x + dx);
          byFirst[Math.min(...cells)].push({ pi, id: piece.id, x, y, rotation: o.rotation, cells });
        }
      }
    }
  });
  const used = new Uint8Array(width * height);
  const count = new Int32Array(pieces.length);
  const stack = [];
  let best = 0;
  const walk = cell => {
    while (cell < used.length && used[cell]) cell++;
    if (cell >= used.length) {
      best = Math.max(best, layoutValue(stack, FRAGMENTS, priorities));
      return;
    }
    for (const e of byFirst[cell]) {
      if (count[e.pi] >= pieces[e.pi].limit || e.cells.some(c => used[c])) continue;
      for (const c of e.cells) used[c] = 1;
      count[e.pi]++;
      stack.push({ id: e.id, x: e.x, y: e.y, rotation: e.rotation });
      walk(cell + 1);
      stack.pop();
      count[e.pi]--;
      for (const c of e.cells) used[c] = 0;
    }
    used[cell] = 1;
    walk(cell + 1);
    used[cell] = 0;
  };
  walk(0);
  return best;
}

test("planLayout: every layout is legal - in the grid, no overlap, within limits, rotations 0-3", () => {
  for (const [name, priorities] of Object.entries(PROFILES)) {
    for (const [w, h] of GRIDS) {
      const plan = planLayout(FRAGMENTS, w, h, { ...CONFIG.stanek.layout, priorities });
      assert.deepEqual(layoutProblems(plan.placements, FRAGMENTS, w, h), [], `${name} ${w}x${h}`);
      for (const p of plan.placements) {
        assert.ok(Number.isInteger(p.x) && Number.isInteger(p.y) && [0, 1, 2, 3].includes(p.rotation));
        assert.deepEqual(Object.keys(p).sort(), ["id", "rotation", "x", "y"]);
      }
      // What it reports is what the layout is.
      assert.ok(Math.abs(plan.value - layoutValue(plan.placements, FRAGMENTS, priorities)) < 1e-9, `${name} ${w}x${h} value`);
      assert.equal(plan.stats + plan.boosters, plan.placements.length);
      assert.equal(plan.cells, w * h);
      assert.equal(plan.cellsUsed, plan.stats * 4 + plan.boosters * 5);
      assert.ok(plan.cellsUsed <= w * h);
      // No two fragments on one root: the API addresses a fragment by it.
      assert.equal(new Set(plan.placements.map(p => `${p.x},${p.y}`)).size, plan.placements.length);
    }
  }
});

test("planLayout: every booster touches a stat fragment, and only weighted fragments are placed", () => {
  for (const [name, priorities] of Object.entries(PROFILES)) {
    for (const [w, h] of GRIDS) {
      const plan = planLayout(FRAGMENTS, w, h, { priorities });
      const on = withDefs(plan.placements, FRAGMENTS);
      const statCells = new Set(on.filter(f => !isBooster(f)).flatMap(f => cellsOf(f, f.shape).map(c => c.join(","))));
      for (const f of on) {
        if (!isBooster(f)) {
          assert.ok(weightOf(f, priorities) > 0, `${name} ${w}x${h}: fragment ${f.id} has no weight`);
          continue;
        }
        const touches = cellsOf(f, f.shape).some(([x, y]) =>
          [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].some(n => statCells.has(n.join(","))));
        assert.ok(touches, `${name} ${w}x${h}: booster ${f.id} at ${f.x},${f.y} touches nothing`);
      }
      // ...and they earn their cells: the value exceeds the bare weights exactly when boosters are on.
      const bare = on.reduce((sum, f) => sum + weightOf(f, priorities), 0);
      if (plan.boosters > 0) assert.ok(plan.value > bare + 1e-9, `${name} ${w}x${h}`);
      else assert.ok(Math.abs(plan.value - bare) < 1e-9);
    }
  }
});

test("planLayout is deterministic: same inputs, same layout; another seed, another legal one", () => {
  for (const [w, h] of [[6, 5], [7, 7]]) {
    const a = planLayout(FRAGMENTS, w, h, { priorities: BLADE });
    const b = planLayout(FRAGMENTS, w, h, { priorities: BLADE });
    assert.deepEqual(a, b);
    // Placement order is canonical too (row-major by root), not search order.
    const sorted = [...a.placements].sort((p, q) => p.y - q.y || p.x - q.x || p.id - q.id);
    assert.deepEqual(a.placements, sorted);
    const c = planLayout(FRAGMENTS, w, h, { priorities: BLADE, seed: 99 });
    assert.deepEqual(layoutProblems(c.placements, FRAGMENTS, w, h), []);
    // Different seeds land within a few percent of each other.
    assert.ok(Math.abs(c.value - a.value) / a.value < 0.08, `${w}x${h}: ${a.value} vs ${c.value}`);
  }
  // The definitions' order must not matter either.
  const shuffled = [...FRAGMENTS].reverse();
  assert.deepEqual(planLayout(shuffled, 6, 5, { priorities: BLADE }), planLayout(FRAGMENTS, 6, 5, { priorities: BLADE }));
});

test("planLayout finds the true optimum on grids small enough to enumerate", () => {
  for (const [name, priorities] of Object.entries(PROFILES)) {
    for (const [w, h] of [[2, 3], [3, 3], [4, 3], [3, 4]]) {
      const plan = planLayout(FRAGMENTS, w, h, { priorities });
      const best = exhaustiveBest(w, h, priorities);
      assert.ok(Math.abs(plan.value - best) < 1e-9, `${name} ${w}x${h}: packer ${plan.value}, optimum ${best}`);
    }
  }
});

test("planLayout: BN13's grids hold the Bladeburner and combat fragments, boosted where there is room", () => {
  // 6x5 = BN13 on a first visit; 7x7 = with SF13.3.
  const first = planLayout(FRAGMENTS, 6, 5, { priorities: BLADE });
  const ids = first.placements.map(p => p.id);
  for (const id of [30, 10, 12, 14, 16]) assert.ok(ids.includes(id), `fragment ${id} is on the 6x5 grid`);
  // Seven bare fragments would be 10 + 24 + 3 + 3 = 40; anything less wastes the grid.
  assert.ok(first.value >= 39.9, `6x5 value ${first.value}`);
  assert.ok(first.cellsUsed >= 28);

  const big = planLayout(FRAGMENTS, 7, 7, { priorities: BLADE });
  assert.ok(big.value > first.value);
  assert.ok(big.boosters >= 1);
  const on = withDefs(big.placements, FRAGMENTS);
  const boosts = boostsOf(on);
  const top = on.findIndex(f => f.id === 30);
  assert.ok(top >= 0);
  // With room to spare the heaviest fragment is not left unboosted.
  assert.ok(boosts[top].count >= 1, "the Bladeburner fragment has a booster on the 7x7 grid");
});

test("planLayout: a hacking node packs its six fragments and surrounds them with boosters", () => {
  const plan = planLayout(FRAGMENTS, 7, 6, { priorities: HACKING });
  assert.deepEqual(plan.placements.filter(p => p.id < 100).map(p => p.id).sort((a, b) => a - b), [0, 1, 5, 6, 7, 25]);
  assert.ok(plan.boosters >= 2, `boosters ${plan.boosters}`);
  // 46 bare; the boosters must add at least a sixth on a grid this size.
  assert.ok(plan.value >= 46 * 1.17, `value ${plan.value}`);
  const on = withDefs(plan.placements, FRAGMENTS);
  const boosts = boostsOf(on);
  const boosted = on.filter((f, i) => !isBooster(f) && boosts[i].count > 0).length;
  assert.ok(boosted >= 5, `${boosted} of 6 fragments boosted`);
});

test("planLayout degrades on tiny or useless inputs instead of failing", () => {
  const none = { placements: [], value: 0, cellsUsed: 0, stats: 0, boosters: 0 };
  assert.deepEqual(planLayout(FRAGMENTS, 0, 0, { priorities: BLADE }), { ...none, cells: 0 });
  assert.deepEqual(planLayout(FRAGMENTS, 1, 1, { priorities: BLADE }), { ...none, cells: 1 });
  assert.deepEqual(planLayout(FRAGMENTS, 3, 1, { priorities: BLADE }), { ...none, cells: 3 });
  assert.deepEqual(planLayout(FRAGMENTS, 6, 5, { priorities: {} }), { ...none, cells: 30 });
  assert.deepEqual(planLayout([], 6, 5, { priorities: BLADE }), { ...none, cells: 30 });
  // Boosters alone are worth nothing: none are placed when no stat fragment fits.
  assert.deepEqual(planLayout(FRAGMENTS.filter(isBooster), 6, 5, { priorities: BLADE }), { ...none, cells: 30 });

  // BN8's 2x3 floor: exactly one fragment, the heaviest that fits.
  const floor = planLayout(FRAGMENTS, 2, 3, { priorities: BLADE });
  assert.deepEqual(floor.placements.map(p => p.id), [30]);
  assert.deepEqual(layoutProblems(floor.placements, FRAGMENTS, 2, 3), []);
  // A 4x1 strip only fits the I fragments; the weighted one goes in.
  const strip = planLayout(FRAGMENTS, 4, 1, { priorities: HACKING });
  assert.deepEqual(strip.placements, [{ id: 6, x: 0, y: 0, rotation: 0 }]);
  // No search at all still returns the greedy layout, legal.
  const greedy = planLayout(FRAGMENTS, 6, 5, { priorities: BLADE, iterations: 0, restarts: 1 });
  assert.deepEqual(layoutProblems(greedy.placements, FRAGMENTS, 6, 5), []);
  assert.ok(greedy.value >= 30);
  // boosters: false packs stat fragments only.
  const plain = planLayout(FRAGMENTS, 7, 7, { priorities: HACKING, boosters: false });
  assert.equal(plain.boosters, 0);
  assert.equal(plain.value, 46);
});

test("planLayout's work is bounded by its options, not by the grid being hard", () => {
  assert.ok(LAYOUT_DEFAULTS.iterations * LAYOUT_DEFAULTS.restarts * LAYOUT_DEFAULTS.smallGridBoost <= 5_000);
  const t0 = performance.now();
  planLayout(FRAGMENTS, 8, 7, { priorities: BLADE });
  // ~70ms on the development machine; the generous ceiling is for a loaded CI box.
  assert.ok(performance.now() - t0 < 5_000);
});

// ── When to re-lay ───────────────────────────────────────────────────────────

test("layoutDecision: lay out an empty gift, never clear a charged one unasked", () => {
  const plan = [{ id: 30, x: 0, y: 0, rotation: 0 }, { id: 10, x: 3, y: 0, rotation: 0 }];
  const same = [placed(10, 3, 0), placed(30, 0, 0)];
  const other = [placed(12, 0, 0)];
  const otherCharged = [placed(12, 0, 0, 0, 500, 3)];

  assert.equal(layoutDecision([], plan).action, "apply");
  assert.equal(layoutDecision(null, plan).action, "apply");
  assert.equal(layoutDecision([], []).action, "keep", "nothing to place");
  assert.equal(layoutDecision(same, plan).action, "keep", "already the plan, whatever the order");
  assert.deepEqual(layoutDecision(same.map(f => ({ ...f, numCharge: 9, highestCharge: 9 })), plan),
    { action: "keep", reason: "already the planned layout", pending: false });

  // Different and uncharged (a fresh node, or just after an install): free to replace.
  assert.equal(layoutDecision(other, plan).action, "apply");
  // Different and CHARGED: keep, and say a new layout is waiting.
  assert.deepEqual(layoutDecision(otherCharged, plan), { action: "keep", reason: "the current layout is charged", pending: true });
  assert.equal(layoutDecision(otherCharged, plan, { relayoutCharged: true }).action, "apply");
  // mode "keep": a hand-made layout stays even when uncharged, but an empty gift is still laid out.
  assert.equal(layoutDecision(other, plan, { mode: "keep" }).action, "keep");
  assert.equal(layoutDecision([], plan, { mode: "keep" }).action, "apply");
  // A different rotation or root is a different layout.
  assert.equal(layoutDecision([placed(10, 3, 0, 2), placed(30, 0, 0)], plan).action, "apply");
});

// ── Charging ─────────────────────────────────────────────────────────────────

test("chargeAfter is StaneksGift.charge: the total is kept, the biggest remembered", () => {
  let s = { highestCharge: 0, numCharge: 0 };
  s = chargeAfter(s, 100);
  assert.deepEqual(s, { highestCharge: 100, numCharge: 1 });
  s = chargeAfter(s, 50); // smaller: adds 50/100 to the count
  assert.deepEqual(s, { highestCharge: 100, numCharge: 1.5 });
  s = chargeAfter(s, 100); // equal counts as "not bigger"
  assert.deepEqual(s, { highestCharge: 100, numCharge: 2.5 });
  s = chargeAfter(s, 1000); // bigger: count rescaled, then + 1
  assert.equal(s.highestCharge, 1000);
  assert.ok(Math.abs(s.numCharge - 1.25) < 1e-12);
  // highestCharge x numCharge is always the sum of every charge's threads.
  assert.ok(Math.abs(s.highestCharge * s.numCharge - (100 + 50 + 100 + 1000)) < 1e-9);
  assert.deepEqual(chargeAfter(s, 0), s);
  assert.deepEqual(chargeAfter({}, 8), { highestCharge: 8, numCharge: 1 });
});

test("chargeEffect is the game's formula, and one big charge beats many small ones", () => {
  assert.equal(chargeEffect(0, 0, 2, 1), 1, "uncharged = no bonus");
  const expected = 1 + (Math.log(10001) / 60) * Math.pow(101 / 5, 0.07) * 2 * 1.1 * 2;
  assert.ok(Math.abs(chargeEffect(10000, 100, 2, 1.1, 2) - expected) < 1e-12);
  // BN13's x2 and a booster's x1.1 scale the BONUS, not the multiplier.
  assert.ok(Math.abs((chargeEffect(500, 20, 2, 1.1, 2) - 1) - 2.2 * (chargeEffect(500, 20, 2, 1, 1) - 1)) < 1e-12);

  let big = { highestCharge: 0, numCharge: 0 };
  big = chargeAfter(big, 1000);
  let small = { highestCharge: 0, numCharge: 0 };
  for (let i = 0; i < 1000; i++) small = chargeAfter(small, 1);
  assert.equal(small.numCharge, 1000);
  const bonus = s => chargeEffect(s.highestCharge, s.numCharge, 1, 1) - 1;
  assert.ok(bonus(big) > 6 * bonus(small), `${bonus(big)} vs ${bonus(small)}`);
  // Same total, split in two: still worse than whole.
  let halves = chargeAfter(chargeAfter({ highestCharge: 0, numCharge: 0 }, 500), 500);
  assert.ok(bonus(big) > bonus(halves));
  // And small charges on top of a big one only ever add.
  assert.ok(bonus(chargeAfter(big, 10)) > bonus(big));
});

test("nextCharge: a fragment the worker would set a new biggest on comes first", () => {
  const active = [
    placed(30, 0, 0, 0, 1000, 40), // Bladeburner, weight 10, already hit by the big worker
    placed(10, 3, 0, 0, 10, 300),  // Strength, weight 6, only ever charged by small ones
    placed(107, 0, 2),             // a booster - never chargeable
  ];
  const pick = nextCharge(active, 1000, { priorities: BLADE });
  assert.deepEqual([pick.id, pick.x, pick.y, pick.index], [10, 3, 0, 1]);
  assert.ok(pick.gain > 0);
  // With a worker no bigger than what both have seen, weight decides.
  const even = [placed(30, 0, 0, 0, 1000, 40), placed(10, 3, 0, 0, 1000, 40)];
  assert.equal(nextCharge(even, 1000, { priorities: BLADE }).id, 30);
  // ...until the heavy one is far enough ahead that the lighter gains more.
  const ahead = [placed(30, 0, 0, 0, 1000, 400), placed(10, 3, 0, 0, 1000, 40)];
  assert.equal(nextCharge(ahead, 1000, { priorities: BLADE }).id, 10);
  // An uncharged fragment beats everything.
  const fresh = [placed(30, 0, 0, 0, 1000, 40), placed(25, 3, 0)];
  assert.equal(nextCharge(fresh, 1000, { priorities: BLADE }).id, 25);
});

test("nextCharge: boosters and empty gifts yield nothing; a booster raises its neighbour's claim", () => {
  assert.equal(nextCharge([], 100), null);
  assert.equal(nextCharge(null, 100), null);
  assert.equal(nextCharge([placed(107, 0, 0), placed(101, 3, 0)], 100, { priorities: BLADE }), null);
  assert.equal(nextCharge([placed(10, 0, 0)], 0, { priorities: BLADE }), null);

  // Two equal-weight, equally charged fragments; one has a booster under it.
  const a = placed(12, 0, 0, 0, 500, 10); // defense L at 0,0: (2,0)(0,1)(1,1)(2,1)
  const b = placed(14, 3, 3, 0, 500, 10); // dexterity L, far away
  const booster = placed(101, 0, 2);      // (0,2)(1,2)(2,2)(3,2)(0,3) - under the first L
  assert.equal(boostsOf([a, b, booster])[0].count, 1);
  assert.equal(boostsOf([a, b, booster])[1].count, 0);
  assert.equal(nextCharge([b, a, booster], 500, { priorities: BLADE }).id, 12);
  // A fragment the table gives no weight still gets charged when it is all there is.
  assert.equal(nextCharge([placed(20, 0, 0)], 100, { priorities: BLADE }).id, 20);
  assert.equal(nextCharge([placed(20, 0, 0)], 100).id, 20, "no table at all");
});

test("chargeRotation: flat x,y pairs, every chargeable fragment once, heavier ones more often", () => {
  const active = [
    placed(30, 0, 0),   // weight 10
    placed(10, 3, 0),   // 6
    placed(25, 0, 2),   // 3
    placed(107, 3, 2),  // booster
  ];
  const flat = chargeRotation(active, 2000, { priorities: BLADE, extra: 6 });
  assert.equal(flat.length, 2 * (3 + 6));
  assert.ok(flat.every(Number.isInteger));
  const roots = [];
  for (let i = 0; i < flat.length; i += 2) roots.push(`${flat[i]},${flat[i + 1]}`);
  // First lap: each of the three, heaviest first; never the booster's root.
  assert.deepEqual(roots.slice(0, 3), ["0,0", "3,0", "0,2"]);
  assert.ok(!roots.includes("3,2"));
  const count = r => roots.filter(x => x === r).length;
  assert.ok(count("0,0") > count("0,2"), "the weight-10 fragment is charged more often than the weight-3 one");
  assert.ok(count("0,2") >= 1);
  // Default length: two laps' worth.
  assert.equal(chargeRotation(active, 2000, { priorities: BLADE }).length, 2 * 6);
  // Deterministic, and it does not mutate what it was given.
  assert.deepEqual(chargeRotation(active, 2000, { priorities: BLADE, extra: 6 }), flat);
  assert.equal(active[0].numCharge, 0);
  assert.deepEqual(chargeRotation([placed(107, 0, 0)], 100, { priorities: BLADE }), []);
  assert.deepEqual(chargeRotation([], 100), []);
});

test("chargeRotation: fragments the big worker has not reached lead the list", () => {
  const active = [
    placed(30, 0, 0, 0, 5000, 80),
    placed(10, 3, 0, 0, 5000, 80),
    placed(16, 0, 2, 0, 40, 900), // agility: lots of small charges, never the big one
  ];
  const flat = chargeRotation(active, 5000, { priorities: BLADE, extra: 0 });
  assert.deepEqual(flat.slice(0, 2), [0, 2]);
  assert.equal(flat.length, 6);
});

// ── RAM ──────────────────────────────────────────────────────────────────────

test("chargeFraction: a fresh gift gets the burst share, a charged one the steady share", () => {
  const cfg = { ramFraction: 0.1, freshFraction: 0.4, freshCharges: 50 };
  assert.deepEqual(chargeFraction([placed(30, 0, 0), placed(107, 3, 0)], cfg), { fraction: 0.4, fresh: true });
  assert.deepEqual(chargeFraction([placed(30, 0, 0, 0, 100, 80), placed(10, 3, 0, 0, 100, 60)], cfg), { fraction: 0.1, fresh: false });
  // One lagging fragment keeps it fresh; boosters (always 0 charges) do not.
  assert.equal(chargeFraction([placed(30, 0, 0, 0, 100, 80), placed(10, 3, 0, 0, 100, 3)], cfg).fresh, true);
  assert.equal(chargeFraction([placed(30, 0, 0, 0, 100, 80), placed(107, 3, 0)], cfg).fresh, false);
  // Nothing chargeable: no RAM at all.
  assert.deepEqual(chargeFraction([], cfg), { fraction: 0, fresh: false });
  assert.deepEqual(chargeFraction([placed(107, 0, 0)], cfg), { fraction: 0, fresh: false });
  // The burst never LOWERS the share (BN13 runs a high steady share).
  assert.equal(chargeFraction([placed(30, 0, 0)], { ramFraction: 0.6, freshFraction: 0.4, freshCharges: 50 }).fraction, 0.6);
  assert.equal(chargeFraction([placed(30, 0, 0)], { ramFraction: 0.2 }).fraction, 0.2);
  assert.equal(chargeFraction([placed(30, 0, 0)], { ramFraction: 7 }).fraction, 1);
});

test("planChargeHosts: the budget goes to the largest hosts, whole", () => {
  const hosts = [
    { host: "cloud-2", max: 1024 },
    { host: "cloud-0", max: 1024 },
    { host: "cloud-1", max: 1024 },
    { host: "cloud-3", max: 1024 },
    { host: "n00dles", max: 4 },
    { host: "home", max: 2048, reserve: 548 }, // 1500 usable
  ];
  // Usable 5600; half = 2800: home whole (1500), cloud-0 whole (1024), then 276 of cloud-1.
  const plan = planChargeHosts(hosts, { fraction: 0.5, threadRam: 2 });
  assert.deepEqual(plan, [
    { host: "home", threads: 750, ram: 1500 },
    { host: "cloud-0", threads: 512, ram: 1024 },
    { host: "cloud-1", threads: 138, ram: 276 },
  ]);
  assert.ok(plan.reduce((s, p) => s + p.ram, 0) <= 2800);
  // Same input in another order: same plan (equal hosts are taken by name).
  assert.deepEqual(planChargeHosts([...hosts].reverse(), { fraction: 0.5, threadRam: 2 }), plan);
  // Everything, everywhere - except hosts too small for minThreads.
  const all = planChargeHosts(hosts, { fraction: 1, threadRam: 2, minThreads: 4 });
  assert.deepEqual(all.map(p => p.host), ["home", "cloud-0", "cloud-1", "cloud-2", "cloud-3"]);
  assert.deepEqual(planChargeHosts(hosts, { fraction: 1, threadRam: 2 }).at(-1), { host: "n00dles", threads: 2, ram: 4 });
  // Caps.
  assert.equal(planChargeHosts(hosts, { fraction: 1, threadRam: 2, maxHosts: 2 }).length, 2);
  assert.deepEqual(planChargeHosts(hosts, { fraction: 1, threadRam: 2, maxRam: 1000 }), [{ host: "home", threads: 500, ram: 1000 }]);
  // A leftover too small to be worth a process is not placed.
  assert.deepEqual(planChargeHosts(hosts, { fraction: 0.5, threadRam: 2, minThreads: 200 }).map(p => p.host), ["home", "cloud-0"]);
  // Nothing to do.
  assert.deepEqual(planChargeHosts(hosts, { fraction: 0, threadRam: 2 }), []);
  assert.deepEqual(planChargeHosts([], { fraction: 0.5, threadRam: 2 }), []);
  assert.deepEqual(planChargeHosts(hosts, { fraction: 0.5, threadRam: 0 }), []);
  assert.deepEqual(planChargeHosts([{ host: "a", max: 100, reserve: 100 }], { fraction: 1, threadRam: 2 }), []);
});

test("tendHost: one process per host, reached without killing anything but our own", () => {
  const opts = { tolerance: 0.1, maxProcesses: 4, minThreads: 4 };
  const t = (want, have, processes, freeThreads) => tendHost({ want, have, processes, freeThreads }, opts);
  // Empty planned host with room: launch the lot.
  assert.deepEqual(t(500, 0, 0, 512), { action: "restart", threads: 500 });
  // On plan: leave it alone - including a few percent off.
  assert.deepEqual(t(500, 500, 1, 12), { action: "none", threads: 0 });
  assert.deepEqual(t(500, 470, 1, 0), { action: "none", threads: 0 });
  assert.deepEqual(t(500, 530, 1, 0), { action: "none", threads: 0 });
  // A full host: nothing fits yet -> wait (the hold does the rest).
  assert.deepEqual(t(500, 0, 0, 0), { action: "none", threads: 0 });
  assert.deepEqual(t(500, 0, 0, 100), { action: "none", threads: 0 }, "a chunk under want/maxProcesses is not worth a process");
  // Legs landed: a worthwhile chunk is taken as an interim worker...
  assert.deepEqual(t(500, 0, 0, 200), { action: "topUp", threads: 200 });
  assert.deepEqual(t(500, 200, 1, 150), { action: "topUp", threads: 150 });
  // ...never more than maxProcesses of them...
  assert.deepEqual(t(500, 380, 4, 110), { action: "none", threads: 0 });
  // ...and merged into one the moment the whole plan fits alongside what we hold.
  assert.deepEqual(t(500, 200, 1, 300), { action: "restart", threads: 500 });
  assert.deepEqual(t(500, 480, 3, 20), { action: "restart", threads: 500 });
  assert.deepEqual(t(500, 480, 3, 5), { action: "none", threads: 0 });
  // The plan shrank, or the host left it.
  assert.deepEqual(t(200, 500, 1, 0), { action: "restart", threads: 200 });
  assert.deepEqual(t(0, 500, 2, 0), { action: "stop", threads: 0 });
  assert.deepEqual(t(0, 0, 0, 900), { action: "none", threads: 0 });
  assert.deepEqual(t(3, 0, 0, 900), { action: "none", threads: 0 }, "below minThreads");
  // The plan grew past tolerance (a pserv upgrade) and the new size fits.
  assert.deepEqual(t(1000, 500, 1, 512), { action: "restart", threads: 1000 });
});

test("holdThreads: ask the batcher only for what a pending launch still needs", () => {
  const opts = { tolerance: 0.1, minThreads: 4 };
  assert.equal(holdThreads({ want: 500, have: 0, processes: 0 }, opts), 500);
  assert.equal(holdThreads({ want: 500, have: 200, processes: 1 }, opts), 300);
  // On plan within tolerance, single process: nothing more will be launched, so nothing is held.
  assert.equal(holdThreads({ want: 500, have: 470, processes: 1 }, opts), 0);
  assert.equal(holdThreads({ want: 500, have: 500, processes: 1 }, opts), 0);
  assert.equal(holdThreads({ want: 500, have: 600, processes: 1 }, opts), 0);
  // Several interim processes waiting to be merged: the merge needs the difference free.
  assert.equal(holdThreads({ want: 500, have: 480, processes: 3 }, opts), 20);
  assert.equal(holdThreads({ want: 0, have: 0, processes: 0 }, opts), 0);
  assert.equal(holdThreads({ want: 3, have: 0, processes: 0 }, opts), 0);
});

// ── What the daemons read ────────────────────────────────────────────────────

test("giftGate: only THIS BitNode's answer counts", () => {
  const now = Date.now();
  assert.equal(giftGate(undefined, 111), "pending");
  assert.equal(giftGate(null, 111), "pending");
  assert.equal(giftGate({ gate: "accepted", resetAt: 111, updatedAt: now }, 111), "accepted");
  assert.equal(giftGate({ gate: "refused", resetAt: 111, updatedAt: now }, 111), "refused");
  // globalThis outlives a BitNode: last node's "accepted" must not let this node's first aug through.
  assert.equal(giftGate({ gate: "accepted", resetAt: 111, updatedAt: now }, 222), "pending");
  assert.equal(giftGate({ gate: "accepted", updatedAt: now }, 222), "pending", "no stamp, no trust");
  // Age is irrelevant within a node - the answer cannot change back.
  assert.equal(giftGate({ gate: "accepted", resetAt: 111, updatedAt: 0 }, 111), "accepted");
  assert.equal(giftGate({ gate: "pending", resetAt: 111 }, 111), "pending");
  assert.equal(giftGate({ accepted: true, resetAt: 111 }, 111), "pending", "the gate field is the contract");
});

test("chargeHolds / mergeHolds: a live helper's holds, folded in idempotently", () => {
  const now = 1_000_000;
  const state = { updatedAt: now - 5_000, holds: { "cloud-0": 1374, home: 300, bad: 0, worse: "x" } };
  assert.deepEqual(chargeHolds(state, now, 60_000), { "cloud-0": 1374, home: 300 });
  // A dead helper holds nothing.
  assert.deepEqual(chargeHolds({ ...state, updatedAt: now - 61_000 }, now, 60_000), {});
  assert.deepEqual(chargeHolds({ holds: { a: 1 } }, now, 60_000), {});
  assert.deepEqual(chargeHolds(undefined, now, 60_000), {});
  assert.deepEqual(chargeHolds({ updatedAt: now }, now, 60_000), {});

  // The gang manager's home reservation and ours: the larger wins, both ways.
  const map = { home: 44 };
  assert.equal(mergeHolds(map, { home: 300, "cloud-0": 1374 }), map);
  assert.deepEqual(map, { home: 300, "cloud-0": 1374 });
  mergeHolds(map, { home: 300, "cloud-0": 1374 });
  assert.deepEqual(map, { home: 300, "cloud-0": 1374 }, "applying twice changes nothing");
  assert.deepEqual(mergeHolds({ home: 500 }, { home: 300 }), { home: 500 });
  assert.deepEqual(mergeHolds(undefined, { a: 1 }), { a: 1 });
  assert.deepEqual(mergeHolds({ a: 1 }, undefined), { a: 1 });
});

// ── The manager against a fake gift and a fake botnet ────────────────────────

const STOP = new Error("stop the loop");

/**
 * A fake `ns` for lib/stanek.js: a gift that follows the game's rules (canPlace,
 * charge state, acceptGift) and a few hosts with RAM accounting. ns.sleep throws
 * STOP after `ticks` calls, which is how a test ends the manager's endless loop.
 */
function makeGame(opts = {}) {
  const world = {
    width: opts.width ?? 6,
    height: opts.height ?? 5,
    canAccept: opts.canAccept ?? true,
    accepted: false,
    fragments: /** @type {any[]} */ (opts.fragments ?? []),
    clears: 0,
    places: 0,
    pid: 1,
    hosts: {
      home: { max: 512, procs: [{ pid: 9001, filename: "bn13/daemon.js", threads: 1, ram: 112, args: [] }] },
      "cloud-0": { max: 2048, procs: [{ pid: 9002, filename: "hacking/weaken.js", threads: 1000, ram: 1.75, args: ["t", 0] }] },
      "cloud-1": { max: 1024, procs: [] },
      n00dles: { max: 4, procs: [] },
      "hacknet-server-0": { max: 4096, procs: [] },
      ...(opts.hosts ?? {}),
    },
    sleeps: 0,
    ticks: opts.ticks ?? 3,
    prints: [],
  };
  const used = h => world.hosts[h].procs.reduce((s, p) => s + p.threads * p.ram, 0);
  const host = h => {
    if (!world.hosts[h]) throw new Error(`Invalid host ${h}`);
    return world.hosts[h];
  };
  const view = f => ({ ...DEF.get(f.id), ...f, chargedEffect: chargeEffect(f.highestCharge, f.numCharge, DEF.get(f.id).power, 1) });
  const ns = {
    args: opts.args ?? [1],
    disableLog() {},
    print: line => world.prints.push(String(line)),
    tprint: line => world.prints.push(String(line)),
    format: { ram: n => `${n}GB`, number: n => String(n) },
    getResetInfo: () => ({ currentNode: 13, lastNodeReset: opts.resetAt ?? 111, ownedSF: new Map() }),
    async sleep() {
      if (++world.sleeps >= world.ticks) throw STOP;
    },
    scan: h => (h === "home" ? Object.keys(world.hosts).filter(x => x !== "home") : ["home"]),
    hasRootAccess: () => true,
    getServerMaxRam: h => host(h).max,
    getServerUsedRam: h => used(h) + 0 * host(h).max,
    getScriptRam: file => (file.endsWith("charge.js") ? 2 : 1.75),
    ps: h => host(h).procs.map(p => ({ pid: p.pid, filename: p.filename, threads: p.threads, args: p.args })),
    scp: () => true,
    exec(script, h, threads, ...args) {
      const filename = script.startsWith("/") ? script.slice(1) : script;
      const server = host(h);
      if (used(h) + threads * 2 > server.max + 1e-9) return 0;
      if (server.procs.some(p => p.filename === filename && JSON.stringify(p.args) === JSON.stringify(args))) return 0;
      const pid = world.pid++;
      server.procs.push({ pid, filename, threads, ram: 2, args });
      return pid;
    },
    kill(pid) {
      for (const server of Object.values(world.hosts)) {
        const i = server.procs.findIndex(p => p.pid === pid);
        if (i >= 0) {
          server.procs.splice(i, 1);
          return true;
        }
      }
      return false;
    },
    stanek: {
      acceptGift() {
        if (world.canAccept) world.accepted = true;
        return world.accepted;
      },
      giftWidth: () => world.width,
      giftHeight: () => world.height,
      fragmentDefinitions: () => FRAGMENTS.map(f => ({ ...f })),
      activeFragments: () => world.fragments.map(view),
      clearGift() {
        world.clears++;
        world.fragments = [];
      },
      placeFragment(x, y, rotation, id) {
        world.places++;
        const next = [...world.fragments, { id, x, y, rotation }];
        if (layoutProblems(next, FRAGMENTS, world.width, world.height).filter(p => !/share the root/.test(p)).length) return false;
        world.fragments.push({ id, x, y, rotation, highestCharge: 0, numCharge: 0 });
        return true;
      },
    },
  };
  return { ns, world, used };
}

/** Run the manager until its fake ns.sleep stops it. */
async function runManager(game, ticks) {
  game.world.sleeps = 0;
  game.world.ticks = ticks;
  await assert.rejects(stanekMain(game.ns), e => e === STOP);
}

function resetGlobals() {
  delete globalThis.gordStanekState;
  delete globalThis.gordStanekRotation;
  delete globalThis.gordStanekAsserted;
  delete globalThis.gordReservedRam;
  delete globalThis.gordReservedHosts;
  delete globalThis.gordEvents;
}

const workersOn = (world, h) => world.hosts[h].procs.filter(p => p.filename === "hacking/charge.js");

test("manager: accepts, lays out the planned layout, and publishes the gate with this node's stamp", async () => {
  resetGlobals();
  const game = makeGame();
  await runManager(game, 2);
  const { world } = game;
  const state = globalThis.gordStanekState;
  assert.equal(world.accepted, true);
  assert.equal(state.gate, "accepted");
  assert.equal(state.accepted, true);
  assert.equal(state.resetAt, 111);
  assert.equal(giftGate(state, 111), "accepted");
  assert.equal(giftGate(state, 222), "pending");
  assert.ok(Date.now() - state.updatedAt < 5_000);

  // The gift now holds exactly what the packer plans for a 6x5 grid under node 1's profile.
  const S = forNode(1).stanek;
  const plan = planLayout(FRAGMENTS, 6, 5, { ...S.layout, priorities: S.profiles[S.profile] });
  assert.equal(layoutKey(world.fragments), layoutKey(plan.placements));
  assert.equal(world.clears, 1);
  assert.equal(world.places, plan.placements.length, "placed once, not once per tick");
  assert.deepEqual([state.width, state.height, state.placed], [6, 5, plan.placements.length]);
  assert.equal(state.stats, plan.stats);
  assert.equal(state.boosters, plan.boosters);
  assert.equal(state.layout.failed, 0);
  assert.equal(state.errors, 0, state.lastError);
  for (const f of state.fragments) {
    assert.ok(typeof f.label === "string" && Array.isArray(f.cells) && f.cells.length >= 4);
  }
  assert.ok((globalThis.gordEvents ?? []).some(e => /Accepted Stanek/.test(e.text)));
  assert.ok((globalThis.gordEvents ?? []).some(e => /Laid out Stanek/.test(e.text)));
  resetGlobals();
});

test("manager: workers go on the largest hosts as single processes; a full host is held, not raided", async () => {
  resetGlobals();
  const game = makeGame();
  await runManager(game, 2);
  const { world } = game;
  const state = globalThis.gordStanekState;
  const S = forNode(1).stanek;

  // Usable: cloud-0 2048 (its weaken legs drain, so they do not count against
  // it); cloud-1 1024; n00dles 4. The hacknet server is never used, and neither
  // is home while no daemon is ticking. Fresh gift -> freshFraction of 3076GB,
  // all of which fits on cloud-0, the largest - but cloud-0 has only 298GB free.
  const budget = Math.max(S.ramFraction, S.freshFraction) * (2048 + 1024 + 4);
  const want = Math.floor(Math.min(budget, 2048) / 2);
  assert.equal(state.ram.fresh, true);
  assert.equal(state.ram.hosts[0].host, "cloud-0");
  assert.equal(state.ram.hosts[0].want, want);
  assert.equal(workersOn(world, "hacknet-server-0").length, 0);
  assert.equal(world.hosts["cloud-0"].procs.filter(p => p.filename === "hacking/weaken.js").length, 1, "the batcher's legs are never killed");
  assert.equal(world.hosts.home.procs.some(p => p.pid === 9001), true);

  // 149 threads are free there; a chunk that small (< want / maxProcesses) is not
  // taken, so the whole plan is held - published AND written into gordReservedRam.
  assert.equal(workersOn(world, "cloud-0").length, 0);
  assert.equal(state.holds["cloud-0"], want * 2);
  assert.equal(globalThis.gordReservedRam["cloud-0"], want * 2);
  assert.deepEqual(chargeHolds(state, Date.now(), 60_000), state.holds);
  assert.match(state.status, /waiting for RAM/);

  // Some of the legs land: 499 threads fit, not yet the whole plan. That is
  // taken at once as an INTERIM worker (it still charges), and only the
  // difference stays held. (This scenario needs the plan to be bigger than the
  // gap and the gap worth a process - true for the shipped defaults.)
  world.hosts["cloud-0"].procs[0].threads = 600;
  const gap = Math.floor((2048 - 600 * 1.75) / 2);
  assert.ok(gap < want * (1 - S.resizeTolerance) && gap >= Math.ceil(want / S.maxProcessesPerHost), "scenario preconditions");
  await runManager(game, 2);
  assert.deepEqual(workersOn(world, "cloud-0").map(p => p.threads), [gap]);
  assert.equal(globalThis.gordStanekState.holds["cloud-0"], (want - gap) * 2);
  assert.equal(globalThis.gordReservedRam["cloud-0"], (want - gap) * 2, "the hold shrinks with what is still missing");
  assert.match(globalThis.gordStanekState.status, /charging \d+ fragments with 1 worker\(s\), 1 host\(s\) still filling/);

  // The rest land. Now the whole plan fits alongside what we hold: the interim
  // worker is replaced by ONE process of the full size, the hold is withdrawn
  // (by a restarted helper - each runManager is a fresh run of the script), and
  // the batcher keeps the rest of the host.
  world.hosts["cloud-0"].procs[0].threads = 100;
  await runManager(game, 2);
  const after = globalThis.gordStanekState;
  const mine = workersOn(world, "cloud-0");
  assert.equal(mine.length, 1);
  assert.equal(mine[0].threads, want, "the whole plan as one process");
  assert.deepEqual(after.holds, {});
  assert.equal(globalThis.gordReservedRam["cloud-0"], undefined);
  assert.equal(after.ram.threads, want);
  assert.equal(after.ram.inUse, want * 2);
  assert.equal(after.ram.processes, 1);
  assert.match(after.status, /charging \d+ fragments with 1 worker/);
  assert.equal(world.hosts["cloud-0"].procs.filter(p => p.filename === "hacking/weaken.js").length, 1);

  // The worker's arguments are roots of chargeable fragments only, plus the serial.
  const args = mine[0].args;
  assert.equal(typeof args.at(-1), "string");
  const chargeable = new Set(world.fragments.filter(f => !isBooster(DEF.get(f.id))).map(f => `${f.x},${f.y}`));
  for (let i = 0; i + 1 < args.length - 1; i += 2) assert.ok(chargeable.has(`${args[i]},${args[i + 1]}`));
  assert.ok(args.length - 1 >= 2 * chargeable.size, "every chargeable fragment is in the rotation");
  assert.deepEqual(globalThis.gordStanekRotation.list, args.slice(0, -1));
  assert.ok(Date.now() - globalThis.gordStanekRotation.at < 5_000);
  resetGlobals();
});

test("manager: someone else's reservation in gordReservedRam is left alone", async () => {
  resetGlobals();
  globalThis.gordReservedRam = { home: 44, "cloud-0": 5000 };
  const game = makeGame();
  await runManager(game, 2);
  assert.equal(globalThis.gordReservedRam.home, 44);
  assert.equal(globalThis.gordReservedRam["cloud-0"], 5000, "a larger reservation than ours stands");
  // Our hold goes away; theirs does not.
  game.world.hosts["cloud-0"].procs[0].threads = 0;
  await runManager(game, 2);
  assert.equal(globalThis.gordReservedRam["cloud-0"], 5000);
  assert.equal(globalThis.gordReservedRam.home, 44);
  resetGlobals();
});

test("manager: hosts in gordReservedHosts are never used; a restart adopts workers instead of doubling them", async () => {
  resetGlobals();
  globalThis.gordReservedHosts = new Set(["cloud-0"]);
  const game = makeGame();
  await runManager(game, 2);
  const { world } = game;
  assert.equal(workersOn(world, "cloud-0").length, 0);
  // The budget moves to the next largest host, which is free.
  assert.equal(workersOn(world, "cloud-1").length, 1);
  const threads = workersOn(world, "cloud-1")[0].threads;
  const pid = workersOn(world, "cloud-1")[0].pid;

  // A second run of the script (daemon restart) finds that worker and keeps it.
  await runManager(game, 3);
  assert.equal(workersOn(world, "cloud-1").length, 1);
  assert.equal(workersOn(world, "cloud-1")[0].pid, pid, "not restarted");
  assert.equal(workersOn(world, "cloud-1")[0].threads, threads);
  assert.equal(world.clears, 1, "and the layout it recognises as its own is not re-laid");

  // The host becomes reserved (the gang manager took it): the worker is stopped.
  globalThis.gordReservedHosts = new Set(["cloud-0", "cloud-1"]);
  await runManager(game, 2);
  assert.equal(workersOn(world, "cloud-1").length, 0);
  resetGlobals();
});

test("manager: home holds a worker only while a daemon is ticking, and never its reserve", async () => {
  resetGlobals();
  const S = forNode(1).stanek;
  const cfg = forNode(1);
  const bigHome = () => makeGame({
    hosts: { home: { max: 8192, procs: [{ pid: 9001, filename: "bn13/daemon.js", threads: 1, ram: 112, args: [] }] } },
  });

  // No daemon state: home is the driver's, however large it is.
  delete globalThis.gordState;
  const cold = bigHome();
  await runManager(cold, 2);
  assert.equal(workersOn(cold.world, "home").length, 0);
  assert.equal(globalThis.gordStanekState.holds.home, undefined);
  resetGlobals();

  // A live daemon: home is the largest host, so the budget starts there - less
  // what is running on it and both reserves.
  globalThis.gordState = { action: "Faction Rep", updatedAt: Date.now() };
  const game = bigHome();
  await runManager(game, 2);
  const usableHome = 8192 - 112 - S.homeReserveRam - cfg.hacking.reserveHomeRam;
  const budget = Math.max(S.ramFraction, S.freshFraction) * (usableHome + 2048 + 1024 + 4);
  const want = Math.floor(Math.min(budget, usableHome) / 2);
  assert.deepEqual(workersOn(game.world, "home").map(p => p.threads), [want]);
  assert.ok(game.used("home") <= 8192 - S.homeReserveRam - cfg.hacking.reserveHomeRam);
  assert.equal(game.world.hosts.home.procs.some(p => p.pid === 9001), true, "the daemon is untouched");

  // The daemon stops ticking (killall; run driver): the worker lets go of home.
  globalThis.gordState.updatedAt = Date.now() - cfg.daemon.tickMs * 10;
  await runManager(game, 2);
  assert.equal(workersOn(game.world, "home").length, 0);
  assert.equal(globalThis.gordStanekState.holds.home, undefined, "and asks for nothing there");
  delete globalThis.gordState;
  resetGlobals();
});

test("manager: a charged layout that differs from the plan is kept and still charged", async () => {
  resetGlobals();
  const manual = [
    { id: 10, x: 0, y: 0, rotation: 0, highestCharge: 800, numCharge: 12 },
    { id: 107, x: 3, y: 0, rotation: 0, highestCharge: 0, numCharge: 0 },
  ];
  const game = makeGame({ fragments: manual.map(f => ({ ...f })) });
  await runManager(game, 2);
  const { world } = game;
  const state = globalThis.gordStanekState;
  assert.equal(world.clears, 0);
  assert.equal(layoutKey(world.fragments), layoutKey(manual));
  assert.equal(state.layout.pending, true);
  assert.equal(state.placed, 2);
  // Its one chargeable fragment is what the rotation holds.
  assert.deepEqual([...new Set(globalThis.gordStanekRotation.list)], [0]);
  assert.equal(globalThis.gordStanekRotation.list.length % 2, 0);
  resetGlobals();

  // The same layout with no charge is replaced (nothing to lose).
  const uncharged = makeGame({ fragments: manual.map(f => ({ ...f, highestCharge: 0, numCharge: 0 })) });
  await runManager(uncharged, 2);
  assert.equal(uncharged.world.clears, 1);
  assert.notEqual(layoutKey(uncharged.world.fragments), layoutKey(manual));
  resetGlobals();
});

test("manager: a gift emptied behind its back is laid out again; a refused piece is not retried for ever", async () => {
  // The once-per-(have > want) guard exists for a plan the game refuses part of.
  // It used to be left set after a layout that went down whole, so the same
  // transition a second time - an empty gift, the planned layout - read as
  // "already tried", and a gift cleared by hand stayed empty until a restart.
  resetGlobals();
  const game = makeGame();
  const sleep = game.ns.sleep;
  let emptied = 0;
  game.ns.sleep = async ms => {
    if (emptied === 0 && game.world.fragments.length > 0) {
      game.world.fragments = [];
      emptied++;
    }
    return sleep(ms);
  };
  await runManager(game, 4);
  assert.equal(emptied, 1);
  assert.equal(game.world.clears, 2, "laid out, emptied by hand, laid out again");
  const S = forNode(1).stanek;
  const plan = planLayout(FRAGMENTS, 6, 5, { ...S.layout, priorities: S.profiles[S.profile] });
  assert.equal(layoutKey(game.world.fragments), layoutKey(plan.placements));
  resetGlobals();

  // The guard's own case still holds: the game refuses one planned piece, the
  // manager tries the partial result once more and then leaves it alone.
  const stubborn = makeGame();
  const place = stubborn.ns.stanek.placeFragment;
  const last = plan.placements[plan.placements.length - 1];
  stubborn.ns.stanek.placeFragment = (x, y, rotation, id) =>
    (id === last.id && x === last.x && y === last.y ? false : place(x, y, rotation, id));
  await runManager(stubborn, 6);
  assert.equal(stubborn.world.clears, 2, "once from empty, once more from the partial layout, then no more");
  assert.equal(globalThis.gordStanekState.layout.failed, 1);
  assert.equal(stubborn.world.fragments.length, plan.placements.length - 1, "what the game took stays on the gift");
  resetGlobals();
});

test("manager: a refusal is published as final and the script exits; a broken tick never kills it", async () => {
  resetGlobals();
  const refused = makeGame({ canAccept: false });
  await stanekMain(refused.ns); // returns - no loop to stop
  assert.equal(globalThis.gordStanekState.gate, "refused");
  assert.equal(globalThis.gordStanekState.accepted, false);
  assert.equal(giftGate(globalThis.gordStanekState, 111), "refused");
  assert.equal(refused.world.clears + refused.world.places, 0);
  assert.equal(Object.values(refused.world.hosts).flatMap(h => h.procs).filter(p => p.filename === "hacking/charge.js").length, 0);
  resetGlobals();

  // activeFragments throwing every tick: the loop survives and reports it.
  const broken = makeGame();
  broken.ns.stanek.activeFragments = () => {
    throw new Error("boom");
  };
  await runManager(broken, 4);
  assert.ok(globalThis.gordStanekState.errors >= 1);
  assert.match(globalThis.gordStanekState.status, /error: .*boom/);
  assert.equal(globalThis.gordStanekState.gate, "accepted", "the gate survives a failing tick");
  resetGlobals();
});

test("boot: accepts once, stamps the node, never clobbers a live manager's state", async () => {
  resetGlobals();
  const prints = [];
  const makeBoot = (canAccept, args = [1]) => ({
    args,
    tprint: line => prints.push(String(line)),
    getResetInfo: () => ({ currentNode: 13, lastNodeReset: 333, ownedSF: new Map() }),
    stanek: { acceptGift: () => canAccept },
  });

  // Last node's state is lying around: it must not count, and it is replaced.
  globalThis.gordStanekState = { gate: "accepted", resetAt: 111, source: "manager", fragments: [], updatedAt: Date.now() };
  assert.equal(giftGate(globalThis.gordStanekState, 333), "pending");
  await bootMain(makeBoot(true));
  assert.equal(giftGate(globalThis.gordStanekState, 333), "accepted");
  assert.equal(globalThis.gordStanekState.source, "boot");
  assert.equal(globalThis.gordStanekState.resetAt, 333);
  assert.match(prints.at(-1), /accepted/);

  // Running it again is harmless and says so.
  await bootMain(makeBoot(true));
  assert.match(prints.at(-1), /already installed/);
  assert.equal((globalThis.gordEvents ?? []).filter(e => /Accepted Stanek/.test(e.text)).length, 1, "one journal line, not one per run");

  // A live manager's richer state for this node is left alone.
  const managed = { gate: "accepted", resetAt: 333, source: "manager", fragments: [1, 2, 3], updatedAt: Date.now() };
  globalThis.gordStanekState = managed;
  await bootMain(makeBoot(true));
  assert.equal(globalThis.gordStanekState, managed);

  // Refused: published as final for the node.
  resetGlobals();
  await bootMain(makeBoot(false));
  assert.equal(giftGate(globalThis.gordStanekState, 333), "refused");
  assert.match(globalThis.gordStanekState.status, /already owned|no access/);
  resetGlobals();
});

// ── HUD ──────────────────────────────────────────────────────────────────────

/** Every string in a rendered element tree, joined. */
function textOf(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node !== "object") return String(node);
  return (node.children ?? []).map(textOf).join(" ");
}

test("STANEK tab: nothing without a live helper; gate, grid, charge and RAM with one", () => {
  const React = globalThis.React;
  globalThis.React = { createElement: (type, props, ...children) => ({ type, props, children }) };
  const NS = { format: { ram: n => `${n}GB`, number: n => String(Math.round(n)) } };
  try {
    resetGlobals();
    assert.deepEqual(extraCards(NS, COLORS), []);

    // Before the manager is up: the boot script's stub is enough for one card.
    globalThis.gordStanekState = { status: "accepted - waiting for the manager", gate: "accepted", accepted: true, resetAt: 1, source: "boot", updatedAt: Date.now() };
    const stub = extraCards(NS, COLORS);
    assert.equal(stub.length, 1);
    assert.match(textOf(stub[0]), /accepted/);

    const state = {
      status: "charging 2 fragments with 1 worker(s)", gate: "accepted", accepted: true, resetAt: 1, profile: "bladeburner",
      width: 6, height: 5, placed: 3, stats: 2, boosters: 1,
      fragments: [
        { id: 10, type: 7, label: "Strength", booster: false, x: 3, y: 0, rotation: 0, cells: [[3, 0], [4, 0], [5, 0], [4, 1]], highestCharge: 512, numCharge: 40, effect: 1.42, boosters: 1, weight: 6 },
        { id: 30, type: 17, label: "Bladeburner", booster: false, x: 0, y: 0, rotation: 0, cells: [[1, 0], [2, 0], [0, 1], [1, 1]], highestCharge: 512, numCharge: 55, effect: 1.085, boosters: 0, weight: 10 },
        { id: 107, type: 18, label: "Booster", booster: true, x: 3, y: 1, rotation: 0, cells: [[4, 2], [3, 3], [4, 3], [5, 3], [4, 4]], highestCharge: 0, numCharge: 0, effect: 1, boosters: 0, weight: 0 },
      ],
      layout: { value: 16.6, planned: 3, pending: true, note: "", failed: 0 },
      ram: { fraction: 0.5, fresh: false, threadRam: 2, budget: 2048, inUse: 1024, threads: 512, processes: 1, largest: 512,
        hosts: [{ host: "cloud-0", threads: 512, want: 512, processes: 1 }, { host: "cloud-1", threads: 0, want: 512, processes: 0 }] },
      holds: { "cloud-1": 1024 }, errors: 0, lastError: "", updatedAt: Date.now(),
    };
    globalThis.gordStanekState = state;
    const cards = extraCards(NS, COLORS);
    assert.equal(cards.length, 2);
    const text = cards.map(textOf).join("\n");
    assert.match(text, /6x5/);
    assert.match(text, /2 \+ 1 boosters/);
    assert.match(text, /bladeburner/);
    assert.match(text, /1024GB \/ 2048GB/);
    assert.match(text, /50% of the botnet/);
    assert.match(text, /cloud-1/);
    assert.match(text, /0 of 512 threads/);
    assert.match(text, /waits for the next install/);
    assert.match(text, /Strength x1 booster - biggest 512 x 40/);
    assert.match(text, /\+42\.0%/);
    assert.match(text, /\+8\.5%/);
    // Strongest bonus first; the booster has no row of its own.
    assert.deepEqual(chargedFragments(state).map(f => f.id), [10, 30]);

    assert.equal(bonusText({ type: 7, effect: 1.25 }), "+25.0%");
    assert.equal(bonusText({ type: 13, effect: 1.25 }), "-20.0%", "hacknet cost is a divisor");
    assert.equal(bonusText({}), "+0.0%");

    // A dead helper's last state is not shown.
    state.updatedAt = Date.now() - 10 * 60_000;
    assert.deepEqual(extraCards(NS, COLORS), []);
  } finally {
    globalThis.React = React;
    resetGlobals();
  }
});

// ── The gate the daemons and the cold-start driver call ──────────────────────

test("giftStatus: off where the node or the Source-Files rule the gift out, else the gate", async () => {
  const { giftStatus } = await import("../lib/stanek-logic.js");
  const on = { enabled: true };
  const inBN13 = { currentNode: 13, ownedSF: new Map(), lastNodeReset: 111 };
  const withSF13 = { currentNode: 7, ownedSF: new Map([[13, 1]]), lastNodeReset: 111 };
  const without = { currentNode: 7, ownedSF: new Map([[7, 2]]), lastNodeReset: 111 };

  // No access: nothing to wait for, whatever a stale state says.
  assert.equal(giftStatus(without, on, { gate: "accepted", resetAt: 111 }), "off");
  assert.equal(giftStatus(inBN13, { enabled: false }, undefined), "off");
  // Access, nobody has asked in THIS node: everything that could forfeit it waits.
  assert.equal(giftStatus(inBN13, on, undefined), "pending");
  assert.equal(giftStatus(withSF13, on, { gate: "accepted", resetAt: 110 }), "pending");
  assert.equal(giftStatus(inBN13, on, { gate: "accepted", resetAt: 111 }), "accepted");
  assert.equal(giftStatus(withSF13, on, { gate: "refused", resetAt: 111 }), "refused");
});

test("the gift is declined in BN8, where the grid holds one fragment and no booster", async () => {
  // BitNode.tsx: StaneksGiftExtraSize -99 in BN8 -> the 2x3 floor, at any SF13 level.
  assert.deepEqual(gridSize(9 - 99 + 3), { width: 2, height: 3 });
  const plan = planLayout(FRAGMENTS, 2, 3, { priorities: HACKING });
  assert.equal(plan.stats, 1);
  assert.equal(plan.boosters, 0, "no pentomino fits a 2x3 grid");
  // One fragment against Genesis's -10% on everything: config turns it down,
  // so nothing accepts it even with Source-File 13.
  assert.equal(forNode(8).stanek.enabled, false);
  const { giftStatus } = await import("../lib/stanek-logic.js");
  const reset = { currentNode: 8, lastNodeReset: 5, ownedSF: new Map([[13, 3]]) };
  assert.equal(giftStatus(reset, forNode(8).stanek, undefined), "off");
  assert.equal(giftStatus({ ...reset, currentNode: 5 }, forNode(5).stanek, undefined), "pending", "elsewhere SF13 offers it");
});

test("the gift is wanted in BN13 with the Bladeburner profile and half the botnet", () => {
  const s = forNode(13).stanek;
  assert.equal(s.enabled, true);
  assert.equal(s.profile, "bladeburner");
  assert.ok(s.ramFraction > CONFIG.stanek.ramFraction);
  assert.ok(s.profiles.bladeburner.bladeburner > s.profiles.bladeburner.hacking);
  // The engine that goes with it, and the order: BN13 is a Bladeburner node.
  assert.equal(forNode(13).bladeburner.enabled, true);
  assert.equal(forNode(13).paths.daemon, "/bn13/daemon.js");
});
