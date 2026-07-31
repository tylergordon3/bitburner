// lib/grafting-logic.js
//
// PURE decision core for the grafting manager - no Netscript, no imports, so it's
// unit-testable under Node (tests/grafting-logic.test.mjs) and costs 0 import RAM.
// lib/grafting.js gathers the candidate data from the game (prices, times, entropy,
// crime rate) and delegates the actual "graft what, and is it worth it?" decision
// here. See lib/grafting.js for the full model write-up.

/**
 * Money-equivalent value-rate of grafting one aug: permanent value gained per ms
 * of player work. value = price * valueMult * 0.98^entropy (the entropy factor
 * discounts a new aug whose own multipliers are already degraded by accrued
 * entropy); rate divides by the graft time (the player-slot cost).
 * @param {number} price @param {number} timeMs @param {number} entropy @param {number} valueMult
 * @returns {number} $/ms (0 if time is non-positive)
 */
export function graftValueRate(price, timeMs, entropy, valueMult) {
  if (!(timeMs > 0)) return 0;
  const value = price * valueMult * Math.pow(0.98, entropy);
  return value / timeMs;
}

/**
 * Rank graftable candidates and decide whether grafting the best affordable one
 * beats idle crime (the opportunity cost of the player's work slot).
 *
 * @param {{aug: string, price: number, timeMs: number, affordable: boolean}[]} candidates
 * @param {object} opts
 * @param {number} opts.entropy            - current Entropy level
 * @param {number} opts.entropyCap         - stop grafting at/above this
 * @param {number} opts.opportunityRate    - idle-crime $/ms (what NOT grafting earns)
 * @param {number} opts.worthwhileThreshold- graft must beat crime by this factor
 * @param {number} opts.valueMult          - aug value weight (see graftValueRate)
 * @returns {{best: any, ranked: any[], worthwhile: boolean, capped: boolean}}
 *   best is the chosen candidate (with .graftRate) or null; ranked is every
 *   candidate scored + sorted best-first (for the dashboard).
 */
export function chooseBestGraft(candidates, opts) {
  const { entropy, entropyCap, opportunityRate, worthwhileThreshold, valueMult } = opts;

  const ranked = candidates
    .map(c => ({ ...c, graftRate: graftValueRate(c.price, c.timeMs, entropy, valueMult) }))
    // Best value-rate first; cheaper price breaks ties so quick/cheap wins bank first.
    .sort((a, b) => (b.graftRate - a.graftRate) || (a.price - b.price));

  const capped = entropy >= entropyCap;
  if (capped) return { best: null, ranked, worthwhile: false, capped: true };

  const best = ranked.find(c => c.affordable) ?? null;
  const worthwhile = !!best && best.graftRate >= opportunityRate * worthwhileThreshold;
  return { best, ranked, worthwhile, capped: false };
}
