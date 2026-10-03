// tests/grafting-logic.test.mjs
// Unit tests for the pure grafting decision core. Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { graftValueRate, chooseBestGraft } from "../lib/grafting-logic.js";

test("graftValueRate = price*valueMult*0.98^entropy / timeMs", () => {
  assert.equal(graftValueRate(1000, 10, 0, 1), 100);
  assert.equal(graftValueRate(1000, 10, 1, 1), 98);   // one entropy level discounts 2%
  assert.equal(graftValueRate(1000, 10, 0, 2), 200);  // value weight doubles it
  assert.equal(graftValueRate(1000, 0, 0, 1), 0);     // non-positive time -> 0
});

const opts = (over = {}) => ({
  entropy: 0,
  entropyCap: 25,
  opportunityRate: 50,
  worthwhileThreshold: 1,
  valueMult: 1,
  ...over,
});

test("picks the affordable candidate with the best value-rate", () => {
  const candidates = [
    { aug: "A", price: 1000, timeMs: 10, affordable: true }, // rate 100
    { aug: "B", price: 5000, timeMs: 10, affordable: true }, // rate 500
  ];
  const { best, worthwhile } = chooseBestGraft(candidates, opts());
  assert.equal(best.aug, "B");
  assert.equal(worthwhile, true); // 500 >= 50*1
});

test("skips unaffordable candidates", () => {
  const candidates = [
    { aug: "A", price: 1000, timeMs: 10, affordable: true },  // rate 100
    { aug: "B", price: 5000, timeMs: 10, affordable: false }, // better rate, but can't pay
  ];
  assert.equal(chooseBestGraft(candidates, opts()).best.aug, "A");
});

test("not worthwhile when crime out-earns the best graft", () => {
  const candidates = [{ aug: "A", price: 100, timeMs: 10, affordable: true }]; // rate 10
  const { best, worthwhile } = chooseBestGraft(candidates, opts({ opportunityRate: 50 }));
  assert.equal(best.aug, "A");
  assert.equal(worthwhile, false); // 10 < 50
});

test("entropy cap halts grafting", () => {
  const candidates = [{ aug: "A", price: 5000, timeMs: 10, affordable: true }];
  const res = chooseBestGraft(candidates, opts({ entropy: 25, entropyCap: 25 }));
  assert.equal(res.capped, true);
  assert.equal(res.best, null);
  assert.equal(res.worthwhile, false);
});

test("no affordable / no candidates -> null best, still ranks for the dashboard", () => {
  assert.equal(chooseBestGraft([], opts()).best, null);
  const none = chooseBestGraft(
    [{ aug: "A", price: 1000, timeMs: 10, affordable: false }],
    opts(),
  );
  assert.equal(none.best, null);
  assert.equal(none.ranked.length, 1); // still scored + returned for display
});

test("REGRESSION: the entropy cap never blocks the graft that cures entropy", async () => {
  const { CONGRUITY_IMPLANT } = await import("../lib/grafting-logic.js");
  const candidates = [
    { aug: "A", price: 5000, timeMs: 10, affordable: true },
    { aug: CONGRUITY_IMPLANT, price: 1, timeMs: 1e9, affordable: true },
  ];
  const res = chooseBestGraft(candidates, opts({ entropy: 25, entropyCap: 25 }));
  assert.equal(res.capped, true);
  assert.equal(res.best.aug, CONGRUITY_IMPLANT);
  assert.equal(res.worthwhile, true);
  // ...but only when we can pay for it.
  const poor = chooseBestGraft([{ ...candidates[1], affordable: false }], opts({ entropy: 25, entropyCap: 25 }));
  assert.equal(poor.best, null);
});
