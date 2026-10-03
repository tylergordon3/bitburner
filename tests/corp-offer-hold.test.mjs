// tests/corp-offer-hold.test.mjs
// lib/corp-invest.js offerHold: a round that is READY is not sold on the spot.
// The offer prices the mean of the last 10 valuation cycles, so it is still
// climbing when the readiness gates flip; accepting there sold every round for
// a fraction of what a minute's wait pays.
// Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { offerHold } from "../lib/corp-invest.js";
import { CONFIG } from "../lib/config.js";

const O = { offerHoldMinPasses: 2, offerHoldMaxPasses: 10, offerPlateauGrowth: 0.01 };

test("a ready round waits for its offer to stop climbing", () => {
  // The pass the gates flip, and the minimum wait: never accept.
  let h = offerHold(null, { round: 1, offer: 100e9 }, O);
  assert.equal(h.accept, false);
  h = offerHold(h.state, { round: 1, offer: 100e9 }, O);
  assert.equal(h.accept, false, "still inside the minimum hold, even if flat");
  // Still rising (the 10-cycle average is turning over): keep holding.
  h = offerHold(h.state, { round: 1, offer: 300e9 }, O);
  assert.equal(h.accept, false);
  h = offerHold(h.state, { round: 1, offer: 480e9 }, O);
  assert.equal(h.accept, false);
  // Settled: under 1% up on the last pass.
  h = offerHold(h.state, { round: 1, offer: 482e9 }, O);
  assert.equal(h.accept, true);
});

test("a corp that never stops growing is sold at the cap, not never", () => {
  let h = { state: null, accept: false };
  let offer = 1e12;
  let passes = 0;
  while (!h.accept) {
    h = offerHold(h.state, { round: 3, offer }, O);
    offer *= 1.5;
    passes++;
    assert.ok(passes <= O.offerHoldMaxPasses, "held past the cap");
  }
  assert.equal(passes, O.offerHoldMaxPasses);
});

test("a falling offer is settled too - waiting longer only loses more", () => {
  let h = offerHold(null, { round: 2, offer: 5e12 }, O);
  h = offerHold(h.state, { round: 2, offer: 5e12 }, O);
  h = offerHold(h.state, { round: 2, offer: 4e12 }, O);
  assert.equal(h.accept, true);
});

test("the configured hold is sane", () => {
  const CO = CONFIG.corp;
  assert.ok(CO.offerHoldMinPasses >= 1);
  assert.ok(CO.offerHoldMaxPasses > CO.offerHoldMinPasses);
  assert.ok(CO.offerPlateauGrowth > 0 && CO.offerPlateauGrowth < 0.5);
});
