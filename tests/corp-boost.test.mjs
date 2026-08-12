// tests/corp-boost.test.mjs
//
// Verifies lib/corp-lib.js's optimalBoostQuantities against the Corporation
// manual's own worked answers. The function is the closed-form Lagrange solution
// (manual 8.3.2) for maximising the division production multiplier
//
//   (1+0.002x)^c1 * (1+0.002y)^c2 * (1+0.002z)^c3 * (1+0.002w)^c4
//
// under the storage constraint s1*x + s2*y + s3*z + s4*w = S, with the manual's
// 8.5 rule: a material whose optimum comes out negative is dropped and the rest
// re-solved. Importable under Node because corp-lib's whole import closure
// (lib/config.js) is Netscript-free.

import { test } from "node:test";
import assert from "node:assert/strict";
import { optimalBoostQuantities } from "../lib/corp-lib.js";

// Agriculture's boost coefficients and the boost materials' per-unit sizes
// (manual 8.1 / config materialSize).
const AGRI = [
  { name: "AI Cores", coefficient: 0.3, size: 0.1 },
  { name: "Hardware", coefficient: 0.2, size: 0.06 },
  { name: "Real Estate", coefficient: 0.72, size: 0.005 },
  { name: "Robots", coefficient: 0.3, size: 0.5 },
];

function usedSpace(out, mats) {
  return mats.reduce((sum, m) => sum + (out[m.name] ?? 0) * m.size, 0);
}

test("matches the manual's S=5250 worked example (18.3.2)", () => {
  // Manual's exact solution: [10518.09, 11742.32, 528368.42, 1703.62].
  const out = optimalBoostQuantities(5250, AGRI);
  assert.equal(out["AI Cores"], 10518);
  assert.equal(out.Hardware, 11742);
  assert.equal(out["Real Estate"], 528368);
  assert.equal(out.Robots, 1703);
});

test("matches the manual's round-1 buy list (19.2.2), with Robots dropped", () => {
  // The round-1 (no custom Smart Supply) table - AI 777, Hardware 919, Real
  // Estate 60794, Robots 0 - occupies 436.8 units of the 520-unit warehouse;
  // feeding that budget in must reproduce the table, including the 8.5 rule
  // zeroing Robots (its unconstrained optimum is negative at this budget).
  const out = optimalBoostQuantities(436.8, AGRI);
  assert.ok(Math.abs(out["AI Cores"] - 777) <= 1, `AI Cores ${out["AI Cores"]}`);
  assert.ok(Math.abs(out.Hardware - 919) <= 1, `Hardware ${out.Hardware}`);
  assert.ok(Math.abs(out["Real Estate"] - 60794) <= 1, `Real Estate ${out["Real Estate"]}`);
  assert.equal(out.Robots, 0);
});

test("never overfills the storage budget and never goes negative", () => {
  for (const space of [10, 50, 208, 436.8, 900, 5250, 1e6]) {
    const out = optimalBoostQuantities(space, AGRI);
    for (const m of AGRI) {
      assert.ok(out[m.name] >= 0, `${m.name} negative at S=${space}`);
    }
    assert.ok(usedSpace(out, AGRI) <= space + 1e-6, `overfilled at S=${space}`);
  }
});

test("uses (nearly) the whole budget once every material participates", () => {
  const out = optimalBoostQuantities(5250, AGRI);
  // Floors sacrifice at most one unit's size per material.
  const maxFloorLoss = AGRI.reduce((sum, m) => sum + m.size, 0);
  assert.ok(usedSpace(out, AGRI) > 5250 - maxFloorLoss - 1e-6);
});

test("degenerate inputs come back as all-zero, not NaN", () => {
  assert.deepEqual(optimalBoostQuantities(0, AGRI), {
    "AI Cores": 0, Hardware: 0, "Real Estate": 0, Robots: 0,
  });
  assert.deepEqual(optimalBoostQuantities(500, []), {});
  const noCoeff = optimalBoostQuantities(500, [{ name: "Robots", coefficient: 0, size: 0.5 }]);
  assert.deepEqual(noCoeff, { Robots: 0 });
});
