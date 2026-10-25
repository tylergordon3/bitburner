// lib/sleeves-logic.js
//
// Pure decisions behind lib/sleeves.js - no Netscript, so it's 0GB to import and
// unit-tested under Node (tests/sleeves-logic.test.mjs). Same split as
// lib/crime-logic.js and lib/bladeburner-logic.js: the manager reads the game,
// these functions decide.

/**
 * The order to (re)assign the roster in this tick. The game refuses a contract
 * to a sleeve while ANOTHER sleeve is still on it (NetscriptFunctions/Sleeve.ts
 * setToBladeburnerAction throws), so when the plan moves a contract from sleeve
 * j to sleeve i < j, walking the roster by index asks i first, the call throws,
 * and i falls through to the crime ladder for the tick (a BN14 save: one sleeve
 * mugging among the Bladeburner roster). Sleeves giving a contract UP go first;
 * everyone else keeps index order.
 * @param {number} count
 * @param {Record<number, string | null | undefined>} current - the contract each sleeve is on
 * @param {Map<number, {contract?: string}> | null | undefined} plan
 * @returns {number[]}
 */
export function assignmentOrder(count, current, plan) {
  const all = Array.from({ length: count }, (_, i) => i);
  if (!plan) return all;
  const releasing = i => !!current[i] && plan.get(i)?.contract !== current[i];
  return [...all.filter(releasing), ...all.filter(i => !releasing(i))];
}

/**
 * Should a sleeve with a little shock recover before working, so it can be sold
 * augmentations? The game sells none while shock > 0 (Sleeve.ts), and in a mode
 * that works through shock (Bladeburner: workShockBelow 100) the passive decay -
 * ~0.0005/s - loses to the 0.5 a death on a failed contract or as a black op's
 * casualty adds. Active recovery (~15 minutes a point) is worth it only while
 * the sleeve has augs left to buy and a batch of them is affordable:
 *   offersLeft - augs still on offer when this sleeve was last shock-free
 *                (undefined: never seen, assume some are)
 *   batchCost  - what its next batch cost then (undefined: assume affordable)
 * @param {number} shock
 * @param {{maxShock: number, offersLeft?: number, batchCost?: number, budget: number, money: number, minMoney: number}} o
 *   budget - what this tick's aug pass may spend (augMaxSpendFraction of spendable)
 */
export function wantsAugRecovery(shock, o) {
  if (!(shock > 0) || shock > o.maxShock) return false;
  if (o.offersLeft === 0) return false;
  if (!(o.money >= o.minMoney)) return false;
  return o.batchCost === undefined || o.batchCost <= o.budget;
}

/**
 * The cost of a sleeve's next aug batch: its `batchMin` cheapest offers (or all
 * of them, if fewer) - the same batching lib/sleeves.js buyAugs applies.
 * @param {number[]} costs @param {number} batchMin
 */
export function nextBatchCost(costs, batchMin) {
  const sorted = [...costs].sort((a, b) => a - b);
  return sorted.slice(0, Math.min(batchMin, sorted.length)).reduce((s, c) => s + c, 0);
}

/**
 * The gym stat to train for the PLAYER: a sleeve's work exp is shared with the
 * player (and every other sleeve) at its sync, the player's own multipliers not
 * applied (Work.ts applySleeveGains), so a sleeve at the gym trains the player
 * too. The player's weakest combat stat by level goes first: on a Bladeburner
 * node every success chance takes the four at equal weight, to the power 0.8,
 * and agility also sets max stamina.
 * @param {{strength: number, defense: number, dexterity: number, agility: number}} skills
 * @returns {"str" | "def" | "dex" | "agi"}
 */
export function weakestPlayerStat(skills) {
  const stats = /** @type {const} */ ([["str", "strength"], ["def", "defense"], ["dex", "dexterity"], ["agi", "agility"]]);
  let best = stats[0];
  for (const s of stats) if ((skills[s[1]] ?? 0) < (skills[best[1]] ?? 0)) best = s;
  return best[0];
}

/**
 * The lowest success chance a sleeve's crime is ranked at. For money it is
 * crimeMinChance, the gym-graduation bar. For KARMA it must not be: a sleeve's
 * failed crime costs only the attempt (SleeveCrimeWork.ts pays karma on success
 * alone), so the rate - chance x karma / time - already says it all, and
 * homicide at 39% (3 karma / 3s) earns 6x a certain mug (0.25 / 4s). With the
 * 0.5 bar a BN13 and a BN14 roster at str ~77 mugged for 25-40 hours. Only a
 * near-hopeless chance (karmaMinChance) still sends the sleeve to the gym.
 * @param {"money" | "karma"} metric
 * @param {{crimeMinChance: number, karmaMinChance?: number}} o
 */
export function crimeMinChanceFor(metric, o) {
  return metric === "karma" ? (o.karmaMinChance ?? 0) : o.crimeMinChance;
}

/**
 * How many sleeves work for the Bladeburner division this tick, by mode:
 * all of them in Bladeburner mode; during a gang's karma bootstrap the first
 * `bootstrapSleeves` (when the division is up), so the player's stamina and
 * attempt counts are covered while the rest commit homicide; none otherwise.
 * @param {"gang" | "blade" | "mirror"} mode @param {number} count
 * @param {{bladeUp: boolean, bootstrapSleeves: number}} o
 */
export function bladeSleeveCount(mode, count, o) {
  if (mode === "blade") return count;
  if (mode === "gang" && o.bladeUp) return Math.max(0, Math.min(count, o.bootstrapSleeves));
  return 0;
}
