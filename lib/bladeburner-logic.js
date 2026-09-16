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
 * we're doing, and the Regeneration Chamber only adds 1% of max per minute on
 * top, so a rest phase is really a free slot for the actions that cost no
 * stamina. The chamber is only worth it for its HP.
 * @param {{hpFrac: number, chaos: number | null, spread: number, recruitChance: number}} s
 *   recruitChance - Recruitment's success chance (charisma^0.45 / (team + 1))
 * @param {{hpRestBelow: number, chaosDiplomacy: number, analysisSpread: number, recruitMinChance: number}} o
 * @returns {{name: string, reason: string}}
 */
export function restAction(s, o) {
  if (s.hpFrac < o.hpRestBelow) return { name: "Hyperbolic Regeneration Chamber", reason: `healing (HP ${Math.round(s.hpFrac * 100)}%)` };
  const chaos = s.chaos ?? 0;
  if (chaos > o.chaosDiplomacy) return { name: "Diplomacy", reason: `city chaos ${chaos.toFixed(0)}` };
  if (s.spread > o.analysisSpread) return { name: "Field Analysis", reason: `estimates too loose (+-${(s.spread * 50).toFixed(0)}%)` };
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

/**
 * What each Bladeburner-eligible sleeve should do (lib/sleeves.js, wherever the
 * node runs Bladeburner). Two jobs exist, and the game's own numbers say how to
 * split them:
 *   - "Take on contracts": the sleeve runs a contract with ITS OWN stats and pays
 *     the player's rank exactly as the player would (no money). One sleeve per
 *     contract name - the game refuses a second - so at most three sleeves.
 *   - "Infiltrate Synthoids": every 60s adds n^-0.5 / 2 attempts to EVERY contract
 *     and operation (n = sleeves infiltrating), i.e. sqrt(n)/2 per minute in
 *     total. Attempts are the real time gate of a Bladeburner node (the natural
 *     regen is one growthFunction() per 480s), so this is the default job, and
 *     the one a sleeve too weak to clear `minChance` on any contract does.
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
 *          current?: Record<number, string | null | undefined>}} o
 *   current - the contract each sleeve is already on (index -> name)
 * @returns {{index: number, action: string, contract?: string, chance?: number}[]}
 */
export function planSleeveBladeWork(sleeves, counts, o) {
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

  return sleeves.map(s => plan.get(s.index) ?? { index: s.index, action: SLEEVE_INFILTRATE });
}

// ── Finishing ────────────────────────────────────────────────────────────────

/**
 * The BitNode to enter once Operation Daedalus is done (0 = the halt sentinel:
 * the daemon runs every black op but the last and leaves the choice to the
 * player). An explicit daemon arg always wins. Otherwise the node re-enters
 * ITSELF while the Source-File level this run will award (sfLevel + 1) is
 * still below `reenterUntilSF` - BN7's SF7.3 is the one that hands out The
 * Blade's Simulacrum for free, so BITNODE[7] sets 3; BN6 leaves it 0 (halt).
 * @param {{override?: number | null, currentNode: number, sfLevel: number, reenterUntilSF: number}} s
 */
export function plannedNodeAfterBlade(s) {
  if (s.override != null && Number.isFinite(Number(s.override))) return Number(s.override);
  return s.sfLevel + 1 < (s.reenterUntilSF ?? 0) ? s.currentNode : 0;
}
