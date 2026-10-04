// lib/bladeburner-logic.js
//
// The pure decision core behind the Bladeburner helpers (lib/bladeburner.js,
// lib/blade-upkeep.js). Every function here takes plain numbers/objects the
// helpers read off ns.bladeburner and returns a decision - no Netscript at all,
// so it's 0GB to import and unit-tested under Node (tests/bladeburner-logic.test.mjs).
// Same split as lib/batch-logic.js / lib/grafting-logic.js.
//
// The knobs (minChance, restBelow, ...) are CONFIG.bladeburner's; the helpers
// pass them in rather than this module importing config, so the tests can vary
// them freely.

export const REGEN_CHAMBER = "Hyperbolic Regeneration Chamber";

/**
 * Rest hysteresis. Below `restBelow` of max stamina (or `hpRestBelow` of max HP)
 * we start resting, and keep resting until stamina is back above `resumeAbove`
 * (HP recovers in the regen chamber, which restAction picks while it's low).
 * Under half of max stamina every action's success is scaled down, which is
 * why restBelow sits just above 0.5. Returns the new resting flag.
 * @param {boolean} resting - were we resting last tick?
 * @param {{stamina: number, maxStamina: number, hpFrac?: number}} s
 * @param {{restBelow: number, resumeAbove: number, hpRestBelow: number}} o
 */
export function nextRestState(resting, s, o) {
  const frac = s.maxStamina > 0 ? s.stamina / s.maxStamina : 0;
  const hp = s.hpFrac ?? 1;
  if (resting) return frac < o.resumeAbove || hp < o.hpRestBelow;
  return frac < o.restBelow || hp < o.hpRestBelow;
}

/**
 * Expected rank per millisecond of one attempt: the pessimistic success chance
 * times the rank a success pays, over the time it takes. Rank is the currency
 * that matters here - it pays Bladeburners faction rep, skill points and the
 * black-op gates - and contracts' money comes along regardless.
 * @param {{chanceMin: number, rankGain: number, timeMs: number}} a
 */
export function actionRate(a) {
  if (!(a.timeMs > 0)) return 0;
  return (Math.max(0, a.chanceMin) * Math.max(0, a.rankGain)) / a.timeMs;
}

/**
 * Pick the best contract/operation to run. Viable = at least one attempt left
 * and a pessimistic chance of at least `minChance`. The running action is kept
 * while it's within `stickyMargin` of the best (restarting throws away progress).
 *
 * @param {{type: string, name: string, chanceMin: number, chanceMax: number,
 *          rankGain: number, timeMs: number, count: number}[]} candidates
 * @param {{minChance: number, stickyMargin: number,
 *          current?: {type: string, name: string} | null}} o
 * @returns {{pick: any | null, ranked: any[]}} ranked = viable, best first
 */
export function chooseAction(candidates, o) {
  const ranked = candidates
    .filter(c => c.count >= 1 && c.chanceMin >= o.minChance && c.timeMs > 0)
    .map(c => ({ ...c, rate: actionRate(c) }))
    .sort((a, b) => b.rate - a.rate);

  const best = ranked[0] ?? null;
  if (!best) return { pick: null, ranked };

  const cur = o.current
    ? ranked.find(c => c.type === o.current?.type && c.name === o.current?.name)
    : null;
  if (cur && cur.rate >= best.rate * o.stickyMargin) return { pick: cur, ranked };
  return { pick: best, ranked };
}

/**
 * Drop the operations that spend the city's population while it is at or under
 * `populationFloor`. A successful Stealth Retirement removes 0.5% of the city's
 * Synthoids and a Sting 0.1%, for good - nothing regrows them but the odd random
 * event - and every contract and operation succeeds in proportion to
 * (population / 1e9)^0.7. With the sleeves' infiltration feeding ~70 attempts an
 * hour, farming them unchecked takes a third off a city's population (and a
 * quarter off every success chance) per hour. So they're harvested only from
 * the surplus above the floor; the kill operations (Assassination: one Synthoid
 * each) are unaffected. An unknown population (upkeep helper not up) filters
 * nothing.
 * @template {{name: string}} T
 * @param {T[]} candidates
 * @param {number | null} population - the current city's estimated population
 * @param {{populationOps: string[], populationFloor: number}} o
 * @returns {T[]}
 */
export function conservePopulation(candidates, population, o) {
  if (population == null || population > o.populationFloor) return candidates;
  return candidates.filter(c => !o.populationOps.includes(c.name));
}

/**
 * One step of per-action level control. Returns the level to set, or null to
 * leave it: down one while the pessimistic chance is under `minChance`, up one
 * once it clears `raiseChance` (and a higher level is unlocked).
 * @param {{level: number, maxLevel: number, chanceMin: number}} a
 * @param {{minChance: number, raiseChance: number}} o
 */
export function levelStep(a, o) {
  if (a.chanceMin < o.minChance && a.level > 1) return a.level - 1;
  if (a.chanceMin >= o.raiseChance && a.level < a.maxLevel) return a.level + 1;
  return null;
}

/**
 * Should we run the next black op now?
 * @param {{name: string, rank: number} | null} next - getNextBlackOp()
 * @param {{rank: number, chanceMin: number, finishAllowed: boolean, finalName: string}} s
 * @param {{minChance: number}} o
 * @returns {{go: boolean, held?: boolean, done?: boolean, reason: string}}
 *   held = the ONLY thing stopping us is that this op would end the BitNode
 */
export function blackOpDecision(next, s, o) {
  if (!next) return { go: false, done: true, reason: "all black ops complete" };
  if (s.rank < next.rank) {
    return { go: false, reason: `${next.name} needs rank ${Math.ceil(next.rank)} (have ${Math.floor(s.rank)})` };
  }
  if (s.chanceMin < o.minChance) {
    return { go: false, reason: `${next.name} at ${Math.round(s.chanceMin * 100)}% (want ${Math.round(o.minChance * 100)}%)` };
  }
  if (next.name === s.finalName && !s.finishAllowed) {
    return { go: false, held: true, reason: `${next.name} ready - held (it ends the BitNode)` };
  }
  return { go: true, reason: `${next.name} at ${Math.round(s.chanceMin * 100)}%` };
}

/**
 * The general action to fall back on when no contract/operation is viable.
 * @param {{chaos: number | null, exhausted: boolean, spread: number}} s
 *   chaos     - our city's chaos (null when unknown)
 *   exhausted - every candidate is out of attempts (counts < 1)
 *   spread    - widest [min, max] success-estimate gap among the candidates
 * @param {{chaosDiplomacy: number, analysisSpread: number, inciteWhenExhausted: boolean}} o
 * @returns {{name: string, reason: string}}
 */
export function fallbackAction(s, o) {
  const chaos = s.chaos ?? 0;
  if (chaos > o.chaosDiplomacy) return { name: "Diplomacy", reason: `city chaos ${chaos.toFixed(0)}` };
  if (s.exhausted && o.inciteWhenExhausted) return { name: "Incite Violence", reason: "every contract/op is out of attempts" };
  if (s.spread > o.analysisSpread) return { name: "Field Analysis", reason: `estimates too loose (+-${(s.spread * 50).toFixed(0)}%)` };
  return { name: "Training", reason: "no action clears the success bar yet" };
}

/**
 * What to do with a REST phase. Stamina regenerates passively no matter what
 * we're doing, so the phase is free for the actions that cost none - but the
 * Regeneration Chamber adds 1% of max per minute on top, which is as much as the
 * passive rate itself once max stamina is in the hundreds. So after the two
 * things that make every later action worse (chaos, loose estimates), the
 * default is the chamber: it ends the rest sooner. `restInChamber: false` spends
 * rests on Recruitment / Field Analysis instead.
 * @param {{hpFrac: number, chaos: number | null, spread: number, recruitChance: number}} s
 *   recruitChance - Recruitment's success chance (charisma^0.45 / (team + 1))
 * @param {{hpRestBelow: number, chaosDiplomacy: number, analysisSpread: number,
 *          recruitMinChance: number, restInChamber?: boolean}} o
 * @returns {{name: string, reason: string}}
 */
export function restAction(s, o) {
  if (s.hpFrac < o.hpRestBelow) return { name: REGEN_CHAMBER, reason: `healing (HP ${Math.round(s.hpFrac * 100)}%)` };
  const chaos = s.chaos ?? 0;
  if (chaos > o.chaosDiplomacy) return { name: "Diplomacy", reason: `city chaos ${chaos.toFixed(0)}` };
  if (s.spread > o.analysisSpread) return { name: "Field Analysis", reason: `estimates too loose (+-${(s.spread * 50).toFixed(0)}%)` };
  if (o.restInChamber) return { name: REGEN_CHAMBER, reason: "+1% max stamina a minute" };
  if (s.recruitChance >= o.recruitMinChance) return { name: "Recruitment", reason: `${Math.round(s.recruitChance * 100)}% to recruit` };
  return { name: "Field Analysis", reason: "hacking/charisma exp" };
}

/**
 * The next skill level to buy: the cheapest cost/weight among skills we weight,
 * aren't capped on, and can afford. null when nothing qualifies.
 * @param {{name: string, level: number, cost: number}[]} skills - cost of the NEXT level (Infinity at the game's cap)
 * @param {number} points
 * @param {Record<string, {weight: number, cap?: number}>} weights
 */
export function chooseSkill(skills, points, weights) {
  let best = null;
  let bestScore = Infinity;
  for (const s of skills) {
    const w = weights[s.name];
    if (!w || !(w.weight > 0)) continue;
    if (s.level >= (w.cap ?? Infinity)) continue;
    if (!(s.cost > 0) || !isFinite(s.cost) || s.cost > points) continue;
    const score = s.cost / w.weight;
    if (score < bestScore) { best = s; bestScore = score; }
  }
  return best;
}

/**
 * The city to operate from: the most populous one that isn't too chaotic,
 * unless the current city is within `switchMargin` of it (population estimates
 * drift, and every move resets nothing but still isn't worth making on noise).
 * @param {{city: string, population: number, chaos: number}[]} cities
 * @param {string} current
 * @param {{switchMargin: number, maxChaos: number}} o
 * @returns {string} the city to be in
 */
export function chooseCity(cities, current, o) {
  const calm = cities.filter(c => c.chaos <= o.maxChaos);
  const pool = calm.length ? calm : cities;
  const best = [...pool].sort((a, b) => b.population - a.population)[0];
  if (!best || best.city === current) return current;
  const here = cities.find(c => c.city === current);
  if (here && here.chaos <= o.maxChaos && best.population <= here.population * (1 + o.switchMargin)) return current;
  return best.city;
}

// ── Sleeves ──────────────────────────────────────────────────────────────────

export const SLEEVE_TAKE_CONTRACTS = "Take on contracts";
export const SLEEVE_INFILTRATE = "Infiltrate Synthoids";
export const SLEEVE_DIPLOMACY = "Diplomacy";
export const SLEEVE_SUPPORT = "Support main sleeve";

/**
 * Should the roster be on "Support main sleeve" for the next black op?
 *
 * A supporting sleeve counts into the team, and a black op's success gets
 * (team + 1)^0.05 - about +10% for six sleeves on an empty team. Unlike a
 * recruit it can't be lost: the team never shrinks below the sleeve count, and a
 * sleeve picked as a casualty takes 0.5 shock. So it's a free bonus, but only
 * while a black op is on the table - a supporting sleeve does nothing else.
 *
 * The roster goes on support when the op is otherwise ready (`eligible`: rank
 * met, not the held final op, the player not resting, the upkeep helper up to
 * send the team) and the bonus would carry it to `minChance`; it stays on while
 * the op runs or still clears the bar. If the bar isn't met once `graceMs` has
 * passed (time for the upkeep helper to set the op's team size), the prediction
 * was wrong: stand down and don't retry for `cooldownMs`, so the sleeves go back
 * to work instead of flapping.
 *
 * @param {{on: boolean, since: number, cooldownUntil: number}} prev
 * @param {{now: number, eligible: boolean, running: boolean, chance: number,
 *          humanTeam: number, sleeves: number}} s
 *   chance    - the op's pessimistic chance with the team as it stands
 *   humanTeam - recruited (non-sleeve) team members
 *   sleeves   - sleeves that would join
 * @param {{minChance: number, graceMs: number, cooldownMs: number}} o
 * @returns {{on: boolean, since: number, cooldownUntil: number}}
 */
export function nextSleeveSupportState(prev, s, o) {
  const off = { on: false, since: 0, cooldownUntil: prev.cooldownUntil };
  if (s.running) return prev.on ? prev : { on: true, since: s.now, cooldownUntil: 0 };
  if (!s.eligible || s.sleeves < 1) return off;

  if (prev.on) {
    if (s.chance >= o.minChance || s.now - prev.since < o.graceMs) return prev;
    return { on: false, since: 0, cooldownUntil: s.now + o.cooldownMs };
  }

  if (s.now < prev.cooldownUntil) return off;
  const team = Math.max(0, s.humanTeam);
  const predicted = s.chance * Math.pow((team + s.sleeves + 1) / (team + 1), 0.05);
  return predicted >= o.minChance ? { on: true, since: s.now, cooldownUntil: 0 } : off;
}

/**
 * Hysteresis for the sleeves' stamina support: on below `regenBelow` of the
 * player's max stamina, off again above `regenAbove`. Returns the new flag.
 * @param {boolean} regen - were the sleeves regenerating last tick?
 * @param {number} staminaFrac - the player's stamina / max stamina
 * @param {{regenBelow: number, regenAbove: number}} o
 */
export function nextSleeveRegenState(regen, staminaFrac, o) {
  return regen ? staminaFrac < o.regenAbove : staminaFrac < o.regenBelow;
}

/**
 * What each Bladeburner-eligible sleeve should do (lib/sleeves.js, wherever the
 * node runs Bladeburner). The jobs, and what the game's own numbers say about
 * splitting them:
 *   - "Take on contracts": the sleeve runs a contract with ITS OWN stats and pays
 *     the player's rank (and money) exactly as the player would. One sleeve per
 *     contract name - the game refuses a second - so at most three sleeves.
 *   - "Infiltrate Synthoids": every 60s adds n^-0.5 / 2 attempts to EVERY contract
 *     and operation (n = sleeves infiltrating), i.e. sqrt(n)/2 per minute in
 *     total. Attempts are the real time gate of a Bladeburner node (the natural
 *     regen is one growthFunction() per 480s), so this is the default job, and
 *     the one a sleeve too weak to clear `minChance` on any contract does.
 *   - General actions act on the DIVISION, whoever performs them: a sleeve's
 *     Diplomacy lowers the city's chaos, and a sleeve in the Regeneration Chamber
 *     restores 1% of the player's max stamina per 60s. So the sleeves not on a
 *     contract drop infiltration for Diplomacy while `diplomacy` is set (chaos is
 *     penalising every action), else for the chamber while `regen` is set (the
 *     player is running low - n sleeves there are worth n%/min, which keeps the
 *     player out of rest phases altogether).
 *   - "Support main sleeve": with `support` set the WHOLE roster joins the team
 *     for the black op at hand (nextSleeveSupportState) - contracts included,
 *     since every member adds to (team + 1)^0.05.
 * A sleeve already on a contract that is still viable keeps it (restarting
 * forfeits the attempt in progress). Otherwise each unclaimed contract - deepest
 * queue first, since that is the one the player is least likely to drain - goes
 * to the free sleeve with the best chance at it.
 *
 * @param {{index: number, chances: Record<string, number>}[]} sleeves
 *   the sleeves free for Bladeburner work, each with its own pessimistic
 *   success chance per contract name
 * @param {Record<string, number>} counts - attempts remaining per contract
 * @param {{minChance: number, maxContractSleeves: number,
 *          current?: Record<number, string | null | undefined>,
 *          diplomacy?: boolean, regen?: boolean, support?: boolean}} o
 *   current - the contract each sleeve is already on (index -> name)
 * @returns {{index: number, action: string, contract?: string, chance?: number}[]}
 */
export function planSleeveBladeWork(sleeves, counts, o) {
  if (o.support) return sleeves.map(s => ({ index: s.index, action: SLEEVE_SUPPORT }));

  const plan = new Map();
  const taken = new Set();
  const ok = (s, c) => (counts[c] ?? 0) >= 1 && (s.chances[c] ?? 0) >= o.minChance;
  const room = () => taken.size < o.maxContractSleeves;
  const assign = (s, c) => {
    taken.add(c);
    plan.set(s.index, { index: s.index, action: SLEEVE_TAKE_CONTRACTS, contract: c, chance: s.chances[c] });
  };

  for (const s of sleeves) {
    const cur = o.current?.[s.index];
    if (cur && room() && !taken.has(cur) && ok(s, cur)) assign(s, cur);
  }

  const contracts = Object.keys(counts)
    .filter(c => !taken.has(c))
    .sort((a, b) => counts[b] - counts[a]);
  for (const c of contracts) {
    if (!room()) break;
    const free = sleeves
      .filter(s => !plan.has(s.index) && ok(s, c))
      .sort((a, b) => b.chances[c] - a.chances[c]);
    if (free.length) assign(free[0], c);
  }

  const rest = o.diplomacy ? SLEEVE_DIPLOMACY : o.regen ? REGEN_CHAMBER : SLEEVE_INFILTRATE;
  return sleeves.map(s => plan.get(s.index) ?? { index: s.index, action: rest });
}
