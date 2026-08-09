// tests/corp-upkeep.test.mjs
//
// Verifies lib/corp-upkeep.js's optimalPartyCost against the game's own morale
// update rule (Corporation manual 10.3):
//
//   morale' = (morale * PerfMult + PartyCost/1e6) * (1 + PartyCost/1e7)
//
// The function is the positive root of that quadratic solved for PartyCost with
// morale' pinned to the target, so feeding its answer back through the update rule
// must land exactly on the target. Importable under Node because corp-upkeep's
// whole import closure (lib/config.js, lib/corp-lib.js) is Netscript-free.

import { test } from "node:test";
import assert from "node:assert/strict";
import { optimalPartyCost } from "../lib/corp-upkeep.js";

/** The game's morale update, given current morale, PerfMult and party cost. */
function nextMorale(current, k, partyCost) {
  const partyMult = 1 + partyCost / 1e7;
  const increase = (partyMult - 1) * 10; // == partyCost / 1e6
  return (current * k + increase) * partyMult;
}

test("solved cost lands exactly on the target morale", () => {
  const cases = [
    // [current, target, perfMult] - decaying office, drifting-up office, deep
    // recovery, and the raised ceilings Sti.mu grants.
    [99.5, 100, 0.998],
    [99.5, 100, 1.002],
    [95, 100, 0.998],
    [70, 100, 0.998],
    [50, 100, 0.998],
    [99.5, 109.5, 0.998],
    [100, 109.5, 0.998],
  ];
  for (const [current, target, k] of cases) {
    const cost = optimalPartyCost(current, target, k);
    assert.ok(cost > 0, `expected a positive cost for ${current} -> ${target}`);
    const landed = nextMorale(current, k, cost);
    assert.ok(Math.abs(landed - target) < 1e-6,
      `${current} -> ${target} (k=${k}): cost ${cost} landed on ${landed}`);
  }
});

test("no party when already at or above target", () => {
  assert.equal(optimalPartyCost(100, 100, 1.002), 0);
  assert.equal(optimalPartyCost(109.5, 109.5, 1.002), 0);
  // Above target: the root goes negative, which must clamp to "no party" rather
  // than emerge as a nonsense negative spend.
  assert.equal(optimalPartyCost(110, 100, 1.002), 0);
});

test("cost rises with the size of the gap and with decay", () => {
  const small = optimalPartyCost(99, 100, 0.998);
  const large = optimalPartyCost(80, 100, 0.998);
  assert.ok(large > small, "bigger gap must cost more");

  const decaying = optimalPartyCost(99, 100, 0.998);
  const drifting = optimalPartyCost(99, 100, 1.002);
  assert.ok(decaying > drifting, "a decaying office must cost more than a drifting-up one");
});
