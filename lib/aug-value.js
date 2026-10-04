// lib/aug-value.js
//
// What an augmentation is WORTH, and which one to work toward next. Pure - no ns
// calls, 0GB - so lib/aug-targets.js can use it on every daemon and the tests can
// run it in Node.
//
// The target used to be whichever aug had the soonest ETA. That sends the work
// slot after a +5% charisma trinket because it is twenty minutes away, while the
// aug that would actually speed the node up sits two hours out - and every aug
// bought raises the price of all the others by 1.9x, so the trinket is not free.
//
// The order is now value per unit of time (Smith's rule: for jobs with a weight
// and a duration, working them in descending weight/duration order minimises the
// total weighted waiting). Two refinements make it fit the game:
//
//   - Reputation is cumulative per faction. Grinding to an aug's requirement also
//     delivers every cheaper aug that faction sells, so a candidate is scored on
//     the BUNDLE it unlocks (the sum of the values at or below its requirement),
//     not on itself alone. A faction with four decent augs beats a faction with
//     one, which soonest-ETA never saw.
//   - The reigning target gets a bonus (stickiness). Rates are noisy, and a
//     target that flips every tick moves the work slot with it.
//
// The value itself is a weighted sum of ln(multiplier) over the aug's stats, the
// weights being per-BitNode config (augs.value in lib/config.js): a multiplier
// compounds, so its log is what adds up, and what a stat is worth depends
// entirely on the node - combat stats are nearly worthless in BN4 and are the
// whole game in BN7.

/**
 * The value of one augmentation under a node's weights.
 * @param {string} aug
 * @param {Record<string, number> | null | undefined} stats - the multipliers that
 *   differ from 1 (lib/aug-stats.js publishes them); null when not known
 * @param {{ weights: Record<string, number>, special?: Record<string, number>, base?: number }} V
 * @returns {number} always >= V.base
 */
export function augValue(aug, stats, V) {
  const base = V.base ?? 0;
  let value = base + (V.special?.[aug] ?? 0);
  for (const [key, mult] of Object.entries(stats ?? {})) {
    const weight = V.weights?.[key] ?? 0;
    if (!weight || !(mult > 0)) continue;
    // Hacknet COST multipliers are below 1, and lower is better.
    value += weight * (key.endsWith("_cost") ? -Math.log(mult) : Math.log(mult));
  }
  return Math.max(base, value);
}

/**
 * A reputation rate to PLAN with (rep/ms), for a faction that may never have
 * been worked for. Measured beats everything; failing that the rate measured at
 * another faction, scaled by favor (the only per-faction term in the game's
 * formula - a guess at the same job type, corrected the moment it is measured);
 * failing that a nominal rate, which at least orders factions by distance.
 * @param {{ measured: number, favor: number, ref: { rate: number, favor: number } | null, assumed: number }} o
 */
export function planningRepRate({ measured, favor, ref, assumed }) {
  if (measured > 0) return measured;
  const boost = 1 + Math.max(0, favor) / 100;
  if (ref && ref.rate > 0) return ref.rate * boost / (1 + Math.max(0, ref.favor) / 100);
  return assumed * boost;
}

/** The key the stickiness bonus is tracked by. @param {{faction: string, aug: string}} c */
export function candidateKey(c) {
  return `${c.faction}|${c.aug}`;
}

/**
 * Score and sort candidates in place: buyable first, then by bundle value per
 * unit of time. Adds `rankMs`, `bundleValue` and `score` to each.
 *
 * @param {{ faction: string, aug: string, value: number, repReq: number,
 *           repMissing: number, moneyMissing: number, price: number,
 *           canBuy: boolean, priorityIndex: number }[]} candidates
 * @param {object} o
 * @param {(faction: string) => number} o.repRate - planning rate, rep/ms (> 0)
 * @param {number} o.incomePerMs - 0 when not measured yet
 * @param {number} o.floorMs - added to every ETA: the fixed overhead of acting on
 *   a target at all, and what stops a near-ready trinket's ratio running away
 * @param {number} [o.stickiness] - relative bonus on an incumbent's score
 * @param {Set<string>} [o.incumbents] - candidateKeys of the targets being worked toward
 * @param {number} [o.unknownPriorityIndex]
 */
export function rankCandidates(candidates, o) {
  const { repRate, incomePerMs, floorMs, stickiness = 0, incumbents = new Set(), unknownPriorityIndex = 99 } = o;

  /** @type {Map<string, any[]>} */
  const byFaction = new Map();
  for (const c of candidates) {
    if (!byFaction.has(c.faction)) byFaction.set(c.faction, []);
    byFaction.get(c.faction).push(c);
  }

  for (const c of candidates) {
    const rate = repRate(c.faction);
    const repMs = c.repMissing <= 0 ? 0 : rate > 0 ? c.repMissing / rate : Infinity;
    const moneyMs = c.moneyMissing <= 0 ? 0 : incomePerMs > 0 ? c.moneyMissing / incomePerMs : Infinity;
    // Rep and money are earned in parallel, so the slower one is the wait.
    const rankMs = c.canBuy ? 0 : Math.max(repMs, moneyMs);
    const bundleValue = byFaction.get(c.faction)
      .reduce((sum, d) => (d.repReq <= c.repReq ? sum + d.value : sum), 0);
    const anyC = /** @type {any} */ (c);
    anyC.rankMs = rankMs;
    anyC.bundleValue = bundleValue;
    anyC.score = Number.isFinite(rankMs) ? bundleValue / (floorMs + rankMs) : 0;
  }

  const prio = c => (c.priorityIndex === -1 ? unknownPriorityIndex : c.priorityIndex);
  const effective = c => c.score * (incumbents.has(candidateKey(c)) ? 1 + stickiness : 1);

  candidates.sort((a, b) => {
    if (a.canBuy !== b.canBuy) return a.canBuy ? -1 : 1;
    const diff = effective(/** @type {any} */ (b)) - effective(/** @type {any} */ (a));
    if (diff !== 0) return diff;
    // Equal scores (typically 0: no income measured yet, so every money-gated
    // aug is an unknown wait) - the old static order.
    if (prio(a) !== prio(b)) return prio(a) - prio(b);
    if (a.repMissing !== b.repMissing) return a.repMissing - b.repMissing;
    return a.price - b.price;
  });
  return candidates;
}
