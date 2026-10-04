// tests/crime-logic.test.mjs
// Unit tests for the pure crime-selection core. Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { crimeRate, pickBestCrime } from "../lib/crime-logic.js";

// The two real crimes, with the game's numbers. `chance` varies per test.
const mug = (chance) => ({ crime: "Mug", chance, money: 36_000, karma: 0.25, timeMs: 4_000 });
const homicide = (chance) => ({ crime: "Homicide", chance, money: 45_000, karma: 3, timeMs: 3_000 });

test("crimeRate = chance * yield / time, per metric", () => {
  assert.equal(crimeRate(homicide(1), "money"), 15);      // 45k / 3s
  assert.equal(crimeRate(mug(1), "money"), 9);            // 36k / 4s
  assert.equal(crimeRate(homicide(0.5), "money"), 7.5);   // halved by the chance
  assert.equal(crimeRate(homicide(1), "karma"), 0.001);   // 3 karma / 3s
  assert.equal(crimeRate(mug(0), "money"), 0);
  assert.equal(crimeRate({ chance: 1, money: 100, timeMs: 0 }, "money"), 0); // no time -> no rate
});

test("homicide wins on money once its chance clears ~60% of the mug chance", () => {
  // Mug capped at 100%: homicide needs 9/15 = 0.6 to draw level.
  const below = pickBestCrime([homicide(0.55), mug(1)]);
  assert.equal(below.crime, "Mug");

  const above = pickBestCrime([homicide(0.65), mug(1)]);
  assert.equal(above.crime, "Homicide");

  // ...which is well before the old fixed "homicide at 80% chance" gate fired.
  assert.equal(pickBestCrime([homicide(0.7), mug(1)]).crime, "Homicide");
});

test("karma metric puts homicide ahead far earlier than money does", () => {
  const candidates = [homicide(0.55), mug(1)];
  assert.equal(pickBestCrime(candidates, { metric: "money" }).crime, "Mug");
  assert.equal(pickBestCrime(candidates, { metric: "karma" }).crime, "Homicide");
});

test("minChance filters out crimes we'd mostly fail", () => {
  // Homicide has the better rate here, but we'd botch 2 attempts in 3.
  const pick = pickBestCrime([homicide(0.35), mug(0.9)], { minChance: 0.5 });
  assert.equal(pick.crime, "Mug");

  // Nothing clears the bar -> caller should train/study instead.
  assert.equal(pickBestCrime([homicide(0.1), mug(0.2)], { minChance: 0.5 }), null);
  assert.equal(pickBestCrime([], { minChance: 0.5 }), null);
  assert.equal(pickBestCrime([mug(0)]), null); // zero rate is never worth committing
});

test("sticks with the crime already running while it's within the margin", () => {
  const candidates = [homicide(0.62), mug(1)]; // homicide 9.3/ms vs mug 9/ms
  const opts = { current: "Mug", stickyMargin: 0.95 };
  assert.equal(pickBestCrime(candidates, opts).crime, "Mug"); // 9 >= 9.3 * 0.95

  // A clear win still switches.
  assert.equal(pickBestCrime([homicide(1), mug(1)], opts).crime, "Homicide");
  // And with no stickiness configured, the best rate always wins.
  assert.equal(pickBestCrime(candidates, { current: "Mug" }).crime, "Homicide");
});

test("returns the ranked list alongside the pick, best rate first", () => {
  const { crime, ranked } = pickBestCrime([mug(1), homicide(1)]);
  assert.equal(crime, "Homicide");
  assert.deepEqual(ranked.map(c => c.crime), ["Homicide", "Mug"]);
  assert.equal(ranked[0].rate, 15);
});

// The PLAYER's failed crime still pays a quarter of its karma (bitburner-src
// Work/CrimeWork.ts commit(): `karma /= 4`); a sleeve's pays none.
test("failFraction: a failed attempt that still pays is counted", () => {
  // 3 karma * (0.2 + 0.8 * 0.25) / 3s
  assert.ok(Math.abs(crimeRate(homicide(0.2), "karma", 0.25) - (3 * 0.4) / 3000) < 1e-15);
  assert.equal(crimeRate(homicide(0.2), "karma"), (0.2 * 3) / 3000); // default: success only
  assert.equal(crimeRate(homicide(1), "karma", 0.25), 0.001);         // nothing to add at 100%
});

test("for the player's karma, a hopeless homicide beats a perfect mug", () => {
  const candidates = [homicide(0.02), mug(1)];
  // Success-only (the sleeves' rule): mug's 0.0625/s beats homicide's 0.02/s.
  assert.equal(pickBestCrime(candidates, { metric: "karma" }).crime, "Mug");
  // The player's rule: 3 * (0.02 + 0.98 / 4) / 3s = 0.265/s, over four times the mug.
  const pick = pickBestCrime(candidates, { metric: "karma", failFraction: 0.25 });
  assert.equal(pick.crime, "Homicide");
  assert.ok(pick.rate > 4 * crimeRate(mug(1), "karma", 0.25));
  // Money is unaffected by default - a failed crime pays none.
  assert.equal(pickBestCrime(candidates).crime, "Mug");
});
