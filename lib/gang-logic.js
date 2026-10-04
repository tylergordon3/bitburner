// lib/gang-logic.js
//
// The pure decisions behind lib/gang.js - no Netscript, so it's 0GB to import
// and unit-tested under Node (tests/gang-logic.test.mjs). Same split as
// lib/batch-logic.js / lib/bladeburner-logic.js: the helper reads the game, these
// functions decide.

/**
 * The gang's territory-and-power update runs once per 100 game cycles of 200ms
 * (bitburner-src Gang.ts, CyclesPerTerritoryAndPowerUpdate). Gang time, not
 * wall-clock: bonus time processes it faster, which is why the clock below
 * counts the milliseconds ns.gang.nextUpdate() reports rather than Date.now().
 */
export const TERRITORY_TICK_MS = 20_000;

/**
 * How much an ascension must multiply a member's stats to be worth taking, given
 * the multiplier it already has. Ascending resets the member's stats and gear, so
 * the first ones should wait for a big jump and later ones for less and less -
 * a flat threshold is either too eager early or (as 1.5 was) leaves a x4 member
 * waiting forever for a gain it can no longer reach.
 * @param {number} mult - the member's current ascension multiplier
 * @param {[number, number][]} table - [multiplier below which, threshold], ascending
 */
export function ascendThreshold(mult, table) {
  for (const [below, threshold] of table) {
    if (mult < below) return threshold;
  }
  return table[table.length - 1][1];
}

/**
 * The one member to ascend this update, or null. At most one per update: a mass
 * ascension drops the whole roster to the gym at once (and, while recruiting,
 * takes the respect the next recruit needs with it).
 *
 * @param {{name: string, ascMult: number, gain: number, respect: number}[]} members
 *   gain    - the multiplier an ascension would apply now (getAscensionResult)
 *   respect - the respect this member would forfeit
 * @param {{table: [number, number][], rosterFull: boolean, gangRespect: number,
 *          respectFraction: number}} o
 * @returns {{name: string, gain: number, threshold: number} | null}
 */
export function chooseAscension(members, o) {
  let best = null;
  for (const m of members) {
    if (!(m.gain > 0)) continue;
    const threshold = ascendThreshold(m.ascMult, o.table);
    if (m.gain < threshold) continue;
    // While recruiting, don't let one ascension take the respect pool the next
    // recruit needs.
    if (!o.rosterFull && m.respect > o.gangRespect * o.respectFraction) continue;
    const margin = m.gain / threshold;
    if (!best || margin > best.margin) best = { name: m.name, gain: m.gain, threshold, margin };
  }
  return best ? { name: best.name, gain: best.gain, threshold: best.threshold } : null;
}

/**
 * Follow the territory tick, so the roster can be on "Territory Warfare" for the
 * one update that contains it and earning for the rest.
 *
 * Power is credited ONLY at the tick, and only from members whose task is
 * Territory Warfare at that instant; a member parked there for the other 18
 * seconds contributes nothing and earns nothing. So instead of parking half the
 * roster full-time, everyone switches over just before the tick and back just
 * after: twice the power for a tenth of the income, instead of half the power
 * for half the income.
 *
 * The tick is recognised from outside (`tickSeen`: another gang's power changed -
 * they all gain at the tick) and predicted by adding up processed gang time since.
 * `preTick` is true when the NEXT update will contain the tick. If a predicted
 * tick fails to show for `maxWaitUpdates` updates the clock has lost sync (bonus
 * time ending mid-cycle); it stops predicting until it sees the next tick.
 *
 * @param {{progressMs: number, synced: boolean, waitUpdates: number}} prev
 * @param {{durationMs: number, tickSeen: boolean}} s
 * @param {{periodMs?: number, maxWaitUpdates?: number}} [o]
 * @returns {{progressMs: number, synced: boolean, waitUpdates: number, preTick: boolean}}
 */
export function nextTerritoryClock(prev, s, o = {}) {
  const period = o.periodMs ?? TERRITORY_TICK_MS;
  const maxWait = o.maxWaitUpdates ?? 3;

  const progressMs = s.tickSeen ? 0 : prev.progressMs + s.durationMs;
  const synced = prev.synced || s.tickSeen;
  if (!synced) return { progressMs, synced: false, waitUpdates: 0, preTick: false };

  const preTick = progressMs + s.durationMs >= period - 1;
  const waitUpdates = preTick ? (s.tickSeen ? 1 : prev.waitUpdates + 1) : 0;
  if (waitUpdates > maxWait) return { progressMs: 0, synced: false, waitUpdates: 0, preTick: false };
  return { progressMs, synced: true, waitUpdates, preTick };
}

/**
 * Has the territory tick just happened? Every gang with territory gains power
 * at the tick and at no other time, so any change in another gang's power since
 * the last look is the tick.
 * @param {Record<string, number> | null} before - other gangs' power last update
 * @param {Record<string, number>} after
 */
export function territoryTickSeen(before, after) {
  if (!before) return false;
  return Object.keys(after).some(name => name in before && after[name] !== before[name]);
}

/**
 * Which members train instead of working this update.
 *   - Anyone under `trainMinStat`: too weak for any task to pay.
 *   - Once the roster is full, the members with the LOWEST ascension multiplier,
 *     up to `maxTrainFraction` of the roster, until they reach
 *     `trainUntilAscMult`. A working task pays a fraction of the experience
 *     training does (and some stats none at all), so a member that only works
 *     barely ascends after its first time; training through the early
 *     ascensions is what compounds. The cap keeps the rest of the roster
 *     earning meanwhile. While still recruiting nobody is held back: respect is
 *     what buys the next member.
 * @param {{name: string, stat: number, ascMult: number}[]} members
 * @param {{trainMinStat: number, trainUntilAscMult: number, maxTrainFraction: number,
 *          rosterFull: boolean}} o
 * @returns {Set<string>}
 */
export function chooseTrainers(members, o) {
  const out = new Set();
  for (const m of members) {
    if (m.stat < o.trainMinStat) out.add(m.name);
  }
  if (!o.rosterFull) return out;

  const cap = Math.floor(members.length * o.maxTrainFraction);
  const behind = members
    .filter(m => !out.has(m.name) && m.ascMult < o.trainUntilAscMult)
    .sort((a, b) => a.ascMult - b.ascMult);
  for (const m of behind) {
    if (out.size >= cap) break;
    out.add(m.name);
  }
  return out;
}
