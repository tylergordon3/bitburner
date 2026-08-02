// lib/crime-logic.js
//
// PURE crime-selection core - no Netscript, no imports, so it's unit-testable
// under Node (tests/crime-logic.test.mjs) and costs 0 import RAM, exactly like
// lib/grafting-logic.js. Callers gather the per-crime numbers from the game
// (ns.singularity.getCrimeStats/getCrimeChance for the player, ns.formulas.work
// for a sleeve) and delegate the "mug or homicide?" decision here.
//
// ── Why a rate check rather than a chance threshold ──────────────────────────
// The old rule was a fixed success-chance gate: "homicide once its chance clears
// 80%, else mug". That's a proxy for the thing we actually care about, which is
// EXPECTED YIELD PER UNIT OF TIME:
//
//   rate = successChance x yieldPerAttempt / attemptTimeMs
//
// Homicide pays more ($45k vs $36k) and is faster (3s vs 4s), so per ms it's
// worth ~15,000 x chance against mug's ~9,000 x chance. It's also ~5x harder, so
// the honest crossover is wherever chance_homicide clears ~0.6 x chance_mug -
// which lands well before homicide reaches an 80% chance. Waiting for 80% left
// real money on the table; this picks whichever crime is actually ahead.
//
// ── Metrics ──────────────────────────────────────────────────────────────────
// Karma works the same way with karma-per-attempt (3 vs 0.25) as the yield,
// which is why the metric is a parameter: the BN2/BN5 gang bootstrap grinds
// KARMA (where homicide's 12x per-attempt edge dominates), everything else
// grinds MONEY.

/**
 * Expected yield per ms of one crime, under the chosen metric.
 * @param {{chance: number, money?: number, karma?: number, timeMs: number}} c
 * @param {"money"|"karma"} [metric]
 * @returns {number} yield/ms (0 if the attempt takes no time / yields nothing)
 */
export function crimeRate(c, metric = "money") {
  if (!c || !(c.timeMs > 0)) return 0;
  const yieldPerAttempt = (metric === "karma" ? c.karma : c.money) ?? 0;
  return (c.chance * yieldPerAttempt) / c.timeMs;
}

/**
 * Pick the crime with the best expected rate.
 *
 * @param {{crime: string, chance: number, money?: number, karma?: number, timeMs: number}[]} candidates
 * @param {object} [opts]
 * @param {"money"|"karma"} [opts.metric]   - what we're optimizing for (default money)
 * @param {number} [opts.minChance]         - skip crimes we'd fail this often (default 0)
 * @param {string|null} [opts.current]      - crime already running, if any
 * @param {number} [opts.stickyMargin]      - keep `current` while its rate is at least
 *                                            this fraction of the best (default 1 = no
 *                                            stickiness). Stops us thrashing across the
 *                                            crossover, where re-issuing a crime forfeits
 *                                            the progress already sunk into the attempt.
 * @returns {{crime: string, chance: number, rate: number, ranked: any[]} | null}
 *   null when no candidate is worth committing (all below minChance, or zero rate).
 */
export function pickBestCrime(candidates, opts = {}) {
  const { metric = "money", minChance = 0, current = null, stickyMargin = 1 } = opts;

  const ranked = (candidates ?? [])
    .filter(c => c && Number.isFinite(c.chance) && c.chance >= minChance)
    .map(c => ({ ...c, rate: crimeRate(c, metric) }))
    .sort((a, b) => b.rate - a.rate);

  const best = ranked[0];
  if (!best || !(best.rate > 0)) return null;

  // Already committing one of the candidates and it's still within the margin?
  // Stay put rather than restarting an attempt for a negligible gain.
  const staying = current ? ranked.find(c => c.crime === current) : null;
  const chosen = staying && staying.rate >= best.rate * stickyMargin ? staying : best;

  return { ...chosen, ranked };
}
