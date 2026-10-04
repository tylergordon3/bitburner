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

// ── The game's gain formulas ─────────────────────────────────────────────────
//
// Transcribed from bitburner-src src/Gang/formulas/formulas.ts, so lib/gang.js
// can rank tasks without Formulas.exe. The magic numbers are the GAME's, not
// knobs - they change only if the game's formulas do.
//
// `softcap` is the BitNode's GangSoftcap (1 in BN1/2/4/5/11/15, 0.9 in BN3/10,
// 0.8 in BN9/12, 0.7 in BN6/7/14, 0.3 in BN13, 0 in BN8): the game raises money
// AND respect to the power (0.2 * territory + 0.8) * GangSoftcap. A script can't
// read that multiplier without SF5's getBitNodeMultipliers (4GB), but it can
// measure it - see inferSoftcap.

/** A member's stat total as a task weights it. */
function statWeight(task, m) {
  return (
    (task.hackWeight / 100) * m.hack +
    (task.strWeight / 100) * m.str +
    (task.defWeight / 100) * m.def +
    (task.dexWeight / 100) * m.dex +
    (task.agiWeight / 100) * m.agi +
    (task.chaWeight / 100) * m.cha
  );
}

function territoryMult(gang, exponent) {
  return Math.max(0.005, Math.pow(gang.territory * 100, exponent) / 100);
}

function wantedPenaltyMult(gang) {
  return gang.respect / (gang.respect + gang.wantedLevel);
}

/** What the game raises to the territory/softcap power for a task's money, or 0. */
function moneyBase(gang, m, task) {
  if (task.baseMoney === 0) return 0;
  const sw = statWeight(task, m) - 3.2 * task.difficulty;
  if (sw <= 0) return 0;
  const terr = territoryMult(gang, task.territory.money);
  if (!(terr > 0)) return 0;
  return 5 * task.baseMoney * sw * terr * wantedPenaltyMult(gang);
}

/** ...and for its respect. */
function respectBase(gang, m, task) {
  if (task.baseRespect === 0) return 0;
  const sw = statWeight(task, m) - 4 * task.difficulty;
  if (sw <= 0) return 0;
  const terr = territoryMult(gang, task.territory.respect);
  if (!(terr > 0)) return 0;
  return 11 * task.baseRespect * sw * terr * wantedPenaltyMult(gang);
}

const softcapExponent = (gang, softcap) => (0.2 * gang.territory + 0.8) * softcap;

/**
 * Money per game cycle one member earns on a task (calculateMoneyGain).
 * @param {{respect: number, wantedLevel: number, territory: number}} gang
 * @param {any} m - getMemberInformation @param {any} task - getTaskStats
 * @param {number} [softcap] - the BitNode's GangSoftcap
 */
export function moneyGain(gang, m, task, softcap = 1) {
  const base = moneyBase(gang, m, task);
  return base > 0 ? Math.pow(base, softcapExponent(gang, softcap)) : 0;
}

/** Respect per game cycle (calculateRespectGain). Same arguments as moneyGain. */
export function respectGain(gang, m, task, softcap = 1) {
  const base = respectBase(gang, m, task);
  return base > 0 ? Math.pow(base, softcapExponent(gang, softcap)) : 0;
}

/**
 * Wanted level per game cycle (calculateWantedLevelGain): negative for the
 * tasks that lower it. No softcap in this one.
 */
export function wantedGain(gang, m, task) {
  if (task.baseWanted === 0) return 0;
  const sw = statWeight(task, m) - 3.5 * task.difficulty;
  if (sw <= 0) return 0;
  const terr = territoryMult(gang, task.territory.wanted);
  if (!(terr > 0)) return 0;
  if (task.baseWanted < 0) return 0.4 * task.baseWanted * sw * terr;
  return Math.min(100, (7 * task.baseWanted) / Math.pow(3 * sw * terr, 0.8));
}

/**
 * The BitNode's GangSoftcap, measured: a member's reported gain on the task it
 * is on (getMemberInformation's moneyGain / respectGain) is base^(exponent *
 * softcap), and base and exponent are both computable here - so
 *   softcap = ln(reported) / (ln(base) * (0.2 * territory + 0.8)).
 * null when this member tells us nothing: not earning, or a base so close to 1
 * that every exponent fits.
 * @param {{respect: number, wantedLevel: number, territory: number}} gang
 * @param {any} m - getMemberInformation @param {any} task - the stats of m.task
 * @returns {number | null}
 */
export function inferSoftcap(gang, m, task) {
  if (!task) return null;
  const readings = [
    [m.moneyGain, moneyBase(gang, m, task)],
    [m.respectGain, respectBase(gang, m, task)],
  ];
  for (const [reported, base] of readings) {
    if (!(reported > 0) || !(base > 0)) continue;
    const lnBase = Math.log(base);
    if (Math.abs(lnBase) < 0.1) continue;
    const cap = Math.log(reported) / (lnBase * (0.2 * gang.territory + 0.8));
    if (Number.isFinite(cap) && cap > 0) return cap;
  }
  return null;
}

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
