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
 * Drop Raid while the city is too chaotic for it - or its chaos is unknown.
 * Raid is the best rank per difficulty there is (rankGain 55, rewardFac 1.1 on
 * difficultyFac 1.045: ~4.7x Assassination's rank per attempt at the same
 * difficulty), but every attempt multiplies the city's chaos by 1.01-1.05
 * (Bladeburner.ts completeOperation), and past 50 chaos makes every action
 * harder. With no Synthoid community left its chance reads 0 (Operation.ts
 * getSuccessChance), which the chance bar already drops.
 * @template {{name: string}} T
 * @param {T[]} candidates @param {number | null} chaos
 * @param {{raidMaxChaos: number}} o
 * @returns {T[]}
 */
export function gateRaid(candidates, chaos, o) {
  if (chaos != null && chaos <= o.raidMaxChaos) return candidates;
  return candidates.filter(c => c.name !== "Raid");
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
 *
 * The bar `o.minChance` comes from blackOpBar (what a failure costs against
 * the rank rate), bladeburner.blackOpMinChance when that can't be priced. It
 * is low on purpose for most ops. A failed black op
 * costs its rankLoss (100 for Tyrell, against tens of thousands held) and a
 * hospital bill of at most min(10% of cash, $100k per max HP) (bitburner-src
 * Bladeburner.ts completeAction, Hospital.ts) - and the attempt's minutes. The
 * alternative, grinding skill points until the chance climbs, buys a few
 * percent an hour. So at any chance worth the name, expected time to the next
 * black op is shortest by attempting it: retries are cheap, waiting is not.
 *
 * A black op ignores population (BlackOperation.ts), yet its estimate range
 * does not: the game scales the LOW end by the current city's pop / popEst
 * whenever the estimate is too high (Action.ts getSuccessRange). So when the
 * range straddles the bar and is wider than `analysisSpread`, the answer is
 * `analyse` - Field Analysis, which pulls the estimate onto the real
 * population - rather than a no. Not for the held final op (it would analyse
 * forever).
 * @param {{name: string, rank: number} | null} next - getNextBlackOp()
 * @param {{rank: number, chanceMin: number, chanceMax?: number, finishAllowed: boolean, finalName: string}} s
 * @param {{minChance: number, analysisSpread?: number}} o
 * @returns {{go: boolean, held?: boolean, done?: boolean, analyse?: boolean, reason: string}}
 *   held = the ONLY thing stopping us is that this op would end the BitNode
 */
export function blackOpDecision(next, s, o) {
  if (!next) return { go: false, done: true, reason: "all black ops complete" };
  if (s.rank < next.rank) {
    return { go: false, reason: `${next.name} needs rank ${Math.ceil(next.rank)} (have ${Math.floor(s.rank)})` };
  }
  if (s.chanceMin < o.minChance) {
    const max = s.chanceMax ?? s.chanceMin;
    const heldFinal = next.name === s.finalName && !s.finishAllowed;
    if (!heldFinal && max >= o.minChance && max - s.chanceMin > (o.analysisSpread ?? Infinity)) {
      return {
        go: false,
        analyse: true,
        reason: `${next.name} at ${Math.round(s.chanceMin * 100)}-${Math.round(max * 100)}% - sharpening the estimate`,
      };
    }
    return { go: false, reason: `${next.name} at ${Math.round(s.chanceMin * 100)}% (want ${Math.round(o.minChance * 100)}%)` };
  }
  if (next.name === s.finalName && !s.finishAllowed) {
    return { go: false, held: true, reason: `${next.name} ready - held (it ends the BitNode)` };
  }
  return { go: true, reason: `${next.name} at ${Math.round(s.chanceMin * 100)}%` };
}

// The black ops in order (bitburner-src v3.0.1 src/Bladeburner/data/
// BlackOperations.ts): the rank each needs and the rank a FAILURE costs. The
// API has getActionRankLoss, but at 4GB for numbers that never change. Note the
// loss is NOT scaled by the node's BladeburnerRank (Formulas.ts
// calculateActionRankLoss) while every gain is - so in BN15 (x0.2) a failed
// Vindictus costs 20,000 rank that takes five times as long to earn back.
export const BLACK_OPS = [
  ["Operation Typhoon", 2_500, 10], ["Operation Zero", 5_000, 15], ["Operation X", 7_500, 15],
  ["Operation Titan", 10_000, 20], ["Operation Ares", 12_500, 20], ["Operation Archangel", 15_000, 20],
  ["Operation Juggernaut", 20_000, 40], ["Operation Red Dragon", 25_000, 50], ["Operation K", 30_000, 60],
  ["Operation Deckard", 40_000, 75], ["Operation Tyrell", 50_000, 100], ["Operation Wallace", 75_000, 150],
  ["Operation Shoulder of Orion", 100_000, 500], ["Operation Hyron", 125_000, 1_000],
  ["Operation Morpheus", 150_000, 1_000], ["Operation Ion Storm", 175_000, 1_000],
  ["Operation Annihilus", 200_000, 1_000], ["Operation Ultron", 250_000, 2_000],
  ["Operation Centurion", 300_000, 5_000], ["Operation Vindictus", 350_000, 20_000],
  ["Operation Daedalus", 400_000, 10_000],
].map(([name, rank, loss]) => ({ name: String(name), rank: Number(rank), loss: Number(loss) }));

/**
 * The success chance a black op is worth attempting at, from what a failure
 * costs. Attempting at chance p until it lands loses (1 - p) / p x rankLoss on
 * the way, and that rank has to be earned back at the current rate; waiting
 * instead buys a few percent of chance an hour. So attempt once the expected
 * loss is at most `lossHorizonMs` of earning:
 *   (1 - p) / p x loss / rate <= horizon   <=>   p >= loss / (loss + horizon x rate)
 * which is the floor for the early ops (Typhoon's 10 rank is seconds of work -
 * a 40% Typhoon used to sit under a flat bar for hours) and most of the way to
 * certain for Vindictus where rank pays x0.2. Unknown loss or rate: the flat
 * `minChance` as before.
 * @param {string} name @param {number} ratePerMs - the best action's expected rank/ms
 * @param {{minChance: number, floor?: number, lossHorizonMs?: number, maxBar?: number}} o
 */
export function blackOpBar(name, ratePerMs, o) {
  const op = BLACK_OPS.find(b => b.name === name);
  if (!op || !(ratePerMs > 0) || !(o.lossHorizonMs > 0)) return o.minChance;
  const bar = op.loss / (op.loss + o.lossHorizonMs * ratePerMs);
  return Math.min(o.maxBar ?? 0.95, Math.max(o.floor ?? 0, bar));
}

/**
 * Hold aug installs in the finishing stretch of a Bladeburner node? An install
 * keeps rank and skills (Bladeburner.ts prestigeAugmentation only stops the
 * action) but puts every stat back to 1, and every black op's chance is
 * competence / difficulty with the stats most of the competence - so the
 * chain of black ops that ends the node stalls until they are rebuilt. Held
 * once the bot means to finish (`finishAllowed`) and rank reaches `holdRank`,
 * or the next `unlockedAhead` black ops are all rank-unlocked already.
 * @param {{rank: number, done: number, finishAllowed: boolean}} s - done = black ops completed
 * @param {{holdRank: number, unlockedAhead: number}} o
 */
export function holdInstallForFinish(s, o) {
  if (!s.finishAllowed) return false;
  if (s.rank >= o.holdRank) return true;
  if (s.done >= BLACK_OPS.length) return true;
  const ahead = Math.max(1, o.unlockedAhead);
  const last = BLACK_OPS[Math.min(BLACK_OPS.length - 1, s.done + ahead - 1)];
  return s.rank >= last.rank;
}

/**
 * An install policy (CONFIG.augs.install shape) with every trigger but The Red
 * Pill out of reach - what lib/blade-daemon.js shows the core while installs
 * are held (lib/daemon-lib.js installReason then finds no reason).
 * @template T @param {T} install @returns {T}
 */
export function neverInstall(install) {
  return { ...install, queuedThreshold: Infinity, priorityQueuedThreshold: Infinity, minQueued: Infinity, favorInstall: false };
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
 * Skill points the upkeep pass may spend. Normally all of them. With a `bank`
 * configured (bladeburner.skillPointBank - e.g. 100,000 for the game's
 * "unspent skill points" achievement, whose test is skillPoints >= 100000) the
 * first `bank` points are left unspent once the black ops are `settled`: every
 * one done, or the last one ready and held. Before that, skills are what gets
 * the next black op over its bar, so nothing is held back.
 * @param {number} points - unspent skill points
 * @param {number | undefined} bank - points to keep unspent (0 / undefined = none)
 * @param {boolean} settled - no black op is still waiting on skills
 */
export function spendableSkillPoints(points, bank, settled) {
  if (!(bank > 0) || !settled) return points;
  return Math.max(0, points - bank);
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

// The black ops that count as kill / stealth actions, for Short-Circuit and
// Cloak (bitburner-src src/Bladeburner/data/BlackOperations.ts isKill /
// isStealth; the API exposes neither flag). Centurion, Vindictus and Daedalus
// are neither.
export const BLACK_OP_STEALTH = new Set(["Operation Zero", "Operation Shoulder of Orion", "Operation Morpheus"]);
export const BLACK_OP_KILL = new Set([
  "Operation Typhoon", "Operation X", "Operation Titan", "Operation Ares", "Operation Archangel",
  "Operation Juggernaut", "Operation Red Dragon", "Operation K", "Operation Deckard", "Operation Tyrell",
  "Operation Wallace", "Operation Hyron", "Operation Ion Storm", "Operation Annihilus", "Operation Ultron",
]);

/**
 * How much one more level of a skill raises a black op's success chance, as a
 * fraction of the chance itself. Each success skill multiplies competence by
 * (1 + pct x level / 100) (Bladeburner.ts updateSkillMultipliers), so the next
 * level is worth pct / (100 + pct x level). Reaper and Evasive System raise
 * effective stats, which enter competence to the power 0.8 (Action.ts) and are
 * most of it - the combat stats carry ~90% of a black op's competence, dex and
 * agility ~60% of that. Approximations, but they only have to rank the skills.
 * Overclock and the rest add no chance at all.
 * @param {string} skill @param {number} level @param {{kill: boolean, stealth: boolean}} op
 */
export function blackOpChanceGain(skill, level, op) {
  const per = pct => pct / (100 + pct * level);
  switch (skill) {
    case "Blade's Intuition": return per(3);
    case "Digital Observer": return per(4);
    case "Short-Circuit": return op.kill ? per(5.5) : 0;
    case "Cloak": return op.stealth ? per(5.5) : 0;
    case "Reaper": return 0.8 * 0.9 * per(2);
    case "Evasive System": return 0.8 * 0.9 * 0.6 * per(4);
    default: return 0;
  }
}

/**
 * The next skill level to buy while a rank-ready black op is held back only by
 * its success chance: the most chance per skill point for THAT op
 * (blackOpChanceGain), among the skills we weight and haven't capped. The
 * ordinary weights (chooseSkill) spread points for the whole division -
 * Overclock among them - which is the wrong mix while one op is the wall.
 * @param {{name: string, level: number, cost: number}[]} skills
 * @param {number} points
 * @param {Record<string, {weight: number, cap?: number}>} weights
 * @param {string} opName
 */
export function chooseSkillForBlackOp(skills, points, weights, opName) {
  const op = { kill: BLACK_OP_KILL.has(opName), stealth: BLACK_OP_STEALTH.has(opName) };
  let best = null;
  let bestScore = 0;
  for (const s of skills) {
    const w = weights[s.name];
    if (!w || !(w.weight > 0)) continue;
    if (s.level >= (w.cap ?? Infinity)) continue;
    if (!(s.cost > 0) || !isFinite(s.cost) || s.cost > points) continue;
    const score = blackOpChanceGain(s.name, s.level, op) / s.cost;
    if (score > bestScore) { best = s; bestScore = score; }
  }
  return best;
}

// The contracts and operations as the skill chooser needs them (bitburner-src
// v3.0.1 src/Bladeburner/data/Contracts.ts, Operations.ts): kind, the
// per-level difficulty and reward factors, the kill / stealth flags, and how
// much of the competence the combat stats carry (sum of weight x decay over
// str/def/dex/agi, and over dex/agi alone, as shares of the total weight).
export const ACTION_DATA = {
  "Tracking":                     { kind: "contract", df: 1.02, rf: 1.041, kill: false, stealth: true, combat: 0.766, dexAgi: 0.671 },
  "Bounty Hunter":                { kind: "contract", df: 1.04, rf: 1.085, kill: true, stealth: false, combat: 0.728, dexAgi: 0.455 },
  "Retirement":                   { kind: "contract", df: 1.03, rf: 1.065, kill: true, stealth: false, combat: 0.728, dexAgi: 0.364 },
  "Investigation":                { kind: "op", df: 1.03, rf: 1.07, kill: false, stealth: true, combat: 0.36, dexAgi: 0.27 },
  "Undercover Operation":         { kind: "op", df: 1.04, rf: 1.09, kill: false, stealth: true, combat: 0.45, dexAgi: 0.36 },
  "Sting Operation":              { kind: "op", df: 1.04, rf: 1.095, kill: false, stealth: true, combat: 0.383, dexAgi: 0.298 },
  "Raid":                         { kind: "op", df: 1.045, rf: 1.1, kill: true, stealth: false, combat: 0.64, dexAgi: 0.32 },
  "Stealth Retirement Operation": { kind: "op", df: 1.05, rf: 1.11, kill: true, stealth: true, combat: 0.64, dexAgi: 0.48 },
  "Assassination":                { kind: "op", df: 1.06, rf: 1.14, kill: true, stealth: true, combat: 0.64, dexAgi: 0.48 },
};

/**
 * What one more level of `skill` is worth to the rank rate of the action the
 * division is earning on, as d ln(rank/s). The levers:
 *   - success skills multiply competence by (1 + pct x level / 100)
 *     (Bladeburner.ts updateSkillMultipliers); Reaper / Evasive System do the
 *     same to the stats, which enter competence to their decay (~0.8-0.9).
 *     While the action is CHANCE-bound the level control turns competence into
 *     levels, and since chance = competence / df^L, rank rate = (rf / df)^L
 *     goes as competence^(ln rf / ln df - 1) - about 1.25 for Assassination.
 *     At its max level with the chance capped (LEVEL-bound) they buy only the
 *     odd failure back.
 *   - Overclock cuts the action time by 1% of the base per level (cap 90), so
 *     level L -> L+1 is 1 / (99 - L) more attempts - worth all of it while the
 *     sleeves' Regeneration Chamber covers stamina, half without them.
 *   - Cyber's Edge raises max stamina and its regen: only worth anything when
 *     nothing else covers stamina.
 *   - Hyperdrive (exp), Hands of Midas (money), Datamancer (estimates): no rank.
 * @param {string} skill @param {number} level - the skill's current level
 * @param {{name: string, level: number, maxLevel: number, chanceMin: number}} action
 * @param {{raiseChance: number, sleevesCoverStamina: boolean}} o
 */
export function skillRateGain(skill, level, action, o) {
  const d = ACTION_DATA[action.name];
  if (!d) return 0;
  const per = pct => Math.log1p(pct / (100 + pct * level));
  const levelBound = action.level >= action.maxLevel && action.chanceMin >= o.raiseChance;
  const el = levelBound ? 0.05 : Math.log(d.rf) / Math.log(d.df) - 1;
  switch (skill) {
    case "Blade's Intuition": return el * per(3);
    case "Digital Observer": return d.kind === "op" ? el * per(4) : 0;
    case "Tracer": return d.kind === "contract" ? el * per(4) : 0;
    case "Short-Circuit": return d.kill ? el * per(5.5) : 0;
    case "Cloak": return d.stealth ? el * per(5.5) : 0;
    case "Reaper": return el * d.combat * per(2);
    case "Evasive System": return el * d.dexAgi * per(4);
    case "Overclock": return level >= 90 ? 0 : -Math.log(1 - 1 / (100 - level)) * (o.sleevesCoverStamina ? 1 : 0.5);
    case "Cyber's Edge": return o.sleevesCoverStamina ? 0 : 0.5 * per(2);
    default: return 0;
  }
}

/**
 * The next skill level by marginal rank rate per point (skillRateGain / cost),
 * among the skills the weights allow (weight > 0, under any cap). Null when
 * nothing affordable adds rate - points then wait for the next level that does,
 * rather than going to a skill that pays none.
 * @param {{name: string, level: number, cost: number}[]} skills
 * @param {number} points
 * @param {Record<string, {weight: number, cap?: number}>} weights
 * @param {{name: string, level: number, maxLevel: number, chanceMin: number}} action
 * @param {{raiseChance: number, sleevesCoverStamina: boolean}} o
 */
export function chooseSkillMarginal(skills, points, weights, action, o) {
  let best = null;
  let bestScore = 0;
  for (const s of skills) {
    const w = weights[s.name];
    if (!w || !(w.weight > 0)) continue;
    if (s.level >= (w.cap ?? Infinity)) continue;
    if (!(s.cost > 0) || !isFinite(s.cost) || s.cost > points) continue;
    const score = skillRateGain(s.name, s.level, action, o) / s.cost;
    if (score > bestScore) { best = s; bestScore = score; }
  }
  return best;
}

// ── City survey ──────────────────────────────────────────────────────────────
//
// The city choice runs on ESTIMATED populations, and an estimate only improves
// in the city the division is in (Field Analysis, Investigation, Undercover,
// Tracking). A city that is never visited keeps the estimate it started with -
// anywhere from half to one and a half times the truth - plus whatever random
// events have done since. A live BN14 save had Aevum at an estimated 0.87e9
// against a real 5.7e9, while the division sat in a 0.93e9 city: every contract
// and operation succeeds in proportion to (population / 1e9)^0.7, so that was
// a 3.6x competence penalty nobody could see. A survey visits each city now and
// then and Field-Analyses it until its estimate stops moving.

/**
 * The city to survey next, or null: the calm city whose last survey is oldest
 * and older than `intervalMs` (never = 0), the current city first on a tie (no
 * move needed).
 * @param {{city: string, chaos: number}[]} cities
 * @param {Record<string, number>} surveyedAt - city -> time of its last survey
 * @param {string} current
 * @param {{now: number, intervalMs: number, maxChaos: number}} o
 * @returns {string | null}
 */
export function chooseSurveyCity(cities, surveyedAt, current, o) {
  if (!(o.intervalMs > 0)) return null;
  const due = cities
    .filter(c => c.chaos <= o.maxChaos && o.now - (surveyedAt[c.city] ?? 0) >= o.intervalMs)
    .sort((a, b) => (surveyedAt[a.city] ?? 0) - (surveyedAt[b.city] ?? 0)
      || Number(b.city === current) - Number(a.city === current));
  return due[0]?.city ?? null;
}

/**
 * One upkeep tick of a survey. Field Analysis moves the estimate by a few
 * percent every 30s until it reaches the real population, where the game
 * clamps it (City.ts improvePopulationEstimateByPercentage) - so the survey is
 * done once the estimate has held within `tolerance` for `stableMs` OF
 * ANALYSIS. Time nobody spends on Field Analysis (a rest, a black op) proves
 * nothing and restarts the still-clock; `maxAnalysisMs` of analysis, or
 * `maxMs` overall, ends it regardless.
 * @param {{city: string, since: number, pop: number, stillSince: number, analysedMs: number, at: number}} prev
 * @param {{now: number, population: number, analysing: boolean}} s
 * @param {{tolerance: number, stableMs: number, maxAnalysisMs: number, maxMs: number}} o
 * @returns {{state: typeof prev, done: boolean}}
 */
export function nextSurveyState(prev, s, o) {
  const dt = Math.max(0, s.now - prev.at);
  const analysedMs = prev.analysedMs + (s.analysing ? dt : 0);
  const moved = !(prev.pop > 0) || Math.abs(s.population - prev.pop) / prev.pop > o.tolerance;
  const stillSince = moved || !s.analysing ? s.now : prev.stillSince;
  const state = { ...prev, pop: moved ? s.population : prev.pop, stillSince, analysedMs, at: s.now };
  const done = s.now - stillSince >= o.stableMs || analysedMs >= o.maxAnalysisMs || s.now - prev.since >= o.maxMs;
  return { state, done };
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
export const SLEEVE_FIELD_ANALYSIS = "Field Analysis";
// Not a Bladeburner action: the gym, for the player's weakest combat stat (a
// sleeve's work exp is shared with the player and every other sleeve - see
// lib/sleeves-logic.js). lib/sleeves.js maps it to setToGymWorkout.
export const SLEEVE_GYM = "Gym";

/**
 * Are attempts short enough that infiltration is worth a sleeve? Infiltrating
 * adds sqrt(n)/2 attempts a minute to every contract and operation and does
 * nothing else - no exp, no rank (SleeveInfiltrateWork.ts). Worth it only
 * while something actually being worked (the player's action, a sleeve-held
 * contract) is running low; with hundreds queued the sleeve is better at the
 * gym. With nothing in use (the player training or analysing) every action
 * counted is checked instead. Unknown counts read as low, so a missing reading
 * keeps the old default.
 * @param {Record<string, number>} counts - attempts remaining per action name
 * @param {string[]} names - the actions in use
 * @param {number} below
 */
export function needInfiltration(counts, names, below) {
  const check = names.length ? names : Object.keys(counts);
  if (!check.length) return true;
  return check.some(n => !((counts[n] ?? -1) >= below));
}

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
 * The sleeves left over after diplomacy and the chamber: Field Analysis while
 * the division surveys a city (`analysis`, see nextSurveyState), infiltration
 * while attempts are short (`infiltrate`, see needInfiltration - true when
 * unset), else the gym (SLEEVE_GYM).
 *
 * @param {{minChance: number, maxContractSleeves: number,
 *          current?: Record<number, string | null | undefined>,
 *          diplomacy?: boolean, regen?: boolean, support?: boolean,
 *          analysis?: boolean, infiltrate?: boolean, maxInfiltrators?: number}} o
 *   current - the contract each sleeve is already on (index -> name)
 *   maxInfiltrators - at most this many infiltrate; the others go to the gym
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

  const rest = o.diplomacy ? SLEEVE_DIPLOMACY
    : o.regen ? REGEN_CHAMBER
    : o.analysis ? SLEEVE_FIELD_ANALYSIS
    : o.infiltrate === false ? SLEEVE_GYM
    : SLEEVE_INFILTRATE;
  // Infiltration pays sqrt(n) / 2 attempts a minute for n sleeves
  // (Bladeburner.ts infiltrateSynthoidCommunities: n^-0.5 / 2 each), so two
  // already give 71% of what eight do: past `maxInfiltrators` the rest train.
  let infiltrators = 0;
  return sleeves.map(s => {
    const p = plan.get(s.index);
    if (p) return p;
    if (rest === SLEEVE_INFILTRATE && infiltrators++ >= (o.maxInfiltrators ?? Infinity)) return { index: s.index, action: SLEEVE_GYM };
    return { index: s.index, action: rest };
  });
}
