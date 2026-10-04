// lib/hacknet-logic.js
//
// The PURE decision core behind lib/hacknet.js, the hacknet-server manager
// (BitNode 9 / SF9). Zero Netscript calls, so it costs 0GB and is unit-tested
// under Node (tests/hacknet-logic.test.mjs), like lib/batch-logic.js and
// lib/grafting-logic.js. The helper gathers game state, hands it here, and
// executes what comes back.
//
// Two decisions live here:
//
//   FLEET GROWTH  - rankUpgrades() scores every purchasable step (a new server,
//                   +1 level, x2 RAM, +1 core on each server) by MARGINAL hash
//                   rate per dollar, and pickUpgrade() takes the best one that
//                   fits the budget AND pays for itself - at the "Sell for Money"
//                   rate - inside a payback horizon. That horizon is the brake:
//                   the first servers pay back in seconds, the last cores of a
//                   maxed fleet in days, and buying simply stops where the line
//                   is drawn (CONFIG.hacknet.maxPaybackMs). A NEW server is
//                   scored and payback-tested as the bundle it opens up - its
//                   own cheap levels, RAM and cores - not as its first level
//                   (newServerBundle).
//
//   HASH SPENDING - planHashSpend() decides what this tick's hashes become.
//                   "Sell for Money" is the universal sink (never sit on a full
//                   cache: unsold hashes at capacity are production thrown
//                   away); the INVESTMENTS - study/gym multipliers, a target's
//                   min-security / max-money, coding contracts - are taken in
//                   priority order when affordable, and the best unaffordable
//                   one is SAVED for only while it costs at most a fraction of
//                   hash capacity (dearer ones are reported as `blocked`, the
//                   helper's cue to buy cache). cashPriority collapses all of
//                   that to "sell everything" - the daemon sets it while cash is
//                   the bottleneck (the cold boot, saving for an aug).
//
// hashGainRate() transcribes the game's HacknetServer.calculateHashGainRate so
// the helper still ranks upgrades when Formulas.exe is absent (it prefers
// ns.formulas.hacknetServers.hashGainRate when present - see lib/formulas.js).

// The game's HacknetServerConstants (src/Hacknet/data/Constants.ts). The caps
// bound what rankUpgrades will propose; the rate constant is the formula's.
export const HACKNET_SERVER = {
  hashesPerLevel: 0.001,
  maxLevel: 300,
  maxRam: 8192,
  maxCores: 128,
  maxCache: 15,
  maxServers: 20,
};

/**
 * Hashes per second a hacknet server produces (the game's formula). Running
 * scripts on the server cuts its output in proportion to the RAM they use.
 * @param {number} level @param {number} ramUsed @param {number} maxRam
 * @param {number} cores @param {number} [mult] player hacknet production multiplier
 */
export function hashGainRate(level, ramUsed, maxRam, cores, mult = 1) {
  if (level <= 0 || maxRam <= 0) return 0;
  const baseGain = HACKNET_SERVER.hashesPerLevel * level;
  const ramMultiplier = Math.pow(1.07, Math.log2(maxRam));
  // Hacknet SERVERS: +20% per extra core (the game's HacknetServer formula). The
  // /16 that stood here is the hacknet NODE money formula's, and undervalued a
  // core about threefold on the no-Formulas path.
  const coreMultiplier = 1 + (cores - 1) / 5;
  const ramRatio = Math.max(0, 1 - ramUsed / maxRam);
  return baseGain * ramMultiplier * coreMultiplier * ramRatio * mult;
}

/**
 * What the game multiplies the formula above by that the helper can't read: the
 * BitNode's HacknetNodeMoney (calculateHashGainRate ends in
 * `* currentNodeMults.HacknetNodeMoney` - 0.05 in BN4, 0.2 in BN5-7, 0 in BN8),
 * measured off a server we own as (the rate the game reports) / (the rate this
 * file computes). Only the no-Formulas path needs it - ns.formulas' version
 * already carries the multiplier; without it every payback there came out too
 * short by that factor. 1 when there is nothing to measure against.
 * @param {{level: number, ram: number, cores: number, ramUsed: number, production: number}[]} servers
 * @param {number} [mult] player hacknet production multiplier
 */
export function fleetRateFactor(servers, mult = 1) {
  let factor = null;
  for (const s of servers) {
    // An idle server only: the game refreshes a server's hashRate and its
    // ramUsed at different moments, so a busy one measures noise.
    if (s.ramUsed > 0 || !(s.production >= 0) || !isFinite(s.production)) continue;
    const ours = hashGainRate(s.level, 0, s.ram, s.cores, mult);
    // The LARGEST reading: a server bought this instant reports 0 until the
    // game's next hacknet pass, and must not zero the whole fleet's estimate.
    if (ours > 0) factor = Math.max(factor ?? 0, s.production / ours);
  }
  return factor ?? 1;
}

// The game's hacknet-server price curve (src/Hacknet/data/Constants.ts and
// formulas/HacknetServers.ts), for pricing upgrades on a server we don't own
// yet - the API only quotes the servers that exist.
const SERVER_COST = { base: 50e3, ramBase: 200e3, coreBase: 1e6, levelMult: 1.1, ramMult: 1.4, coreMult: 1.55 };

/** Price of level -> level + 1. @param {number} level @param {number} [costMult] */
export function levelUpgradeCost(level, costMult = 1) {
  if (level + 1 > HACKNET_SERVER.maxLevel) return Infinity;
  return 10 * SERVER_COST.base * Math.pow(SERVER_COST.levelMult, level) * costMult;
}

/** Price of ram -> ram * 2. @param {number} ram @param {number} [costMult] */
export function ramUpgradeCost(ram, costMult = 1) {
  if (ram * 2 > HACKNET_SERVER.maxRam) return Infinity;
  return ram * SERVER_COST.ramBase * Math.pow(SERVER_COST.ramMult, Math.round(Math.log2(ram))) * costMult;
}

/** Price of cores -> cores + 1. @param {number} cores @param {number} [costMult] */
export function coreUpgradeCost(cores, costMult = 1) {
  if (cores + 1 > HACKNET_SERVER.maxCores) return Infinity;
  return SERVER_COST.coreBase * Math.pow(SERVER_COST.coreMult, cores - 1) * costMult;
}

/**
 * What a NEW server is worth: itself plus the upgrades it makes available.
 *
 * A bare level-1 server makes 0.001 hashes/s, so priced alone the sixth one
 * ($16.8m for $250/s) takes 19 hours to pay back and is never bought - while
 * the fleet keeps paying ten times that per hash for the 40th level and 11th
 * core of the servers it has. But a server is not bought for its first level:
 * it restarts the whole price curve. Brought to the same 41 / 64GB / 11 cores
 * the sixth server costs $460m for $46k/s - under three hours. Scored bare,
 * a 6-hour horizon stops the fleet at 5 servers; scored like this it reaches 9.
 *
 * So: walk the new server up its cheapest-hash-first upgrade path and return
 * the point where the whole bundle is cheapest per hash/s. Pure.
 * @param {{
 *   purchaseCost: number,
 *   rate: (level: number, ramUsed: number, ram: number, cores: number) => number,
 *   costMults?: {level?: number, ram?: number, cores?: number},
 *   limits?: typeof HACKNET_SERVER,
 *   maxSteps?: number,
 * }} c
 * @returns {{cost: number, gain: number}} cost Infinity / gain 0 when unpriced
 */
export function newServerBundle({ purchaseCost, rate, costMults = {}, limits = HACKNET_SERVER, maxSteps = 600 }) {
  const s = { level: 1, ram: 1, cores: 1 };
  let cost = purchaseCost;
  let gain = rate(1, 0, 1, 1);
  if (!(cost > 0) || !isFinite(cost) || !(gain > 0)) return { cost: Infinity, gain: 0 };
  let best = { cost, gain };

  for (let i = 0; i < maxSteps; i++) {
    const steps = [
      s.level < limits.maxLevel
        ? { cost: levelUpgradeCost(s.level, costMults.level ?? 1), next: { ...s, level: s.level + 1 } } : null,
      s.ram < limits.maxRam
        ? { cost: ramUpgradeCost(s.ram, costMults.ram ?? 1), next: { ...s, ram: s.ram * 2 } } : null,
      s.cores < limits.maxCores
        ? { cost: coreUpgradeCost(s.cores, costMults.cores ?? 1), next: { ...s, cores: s.cores + 1 } } : null,
    ];
    let step = null;
    let stepScore = 0;
    for (const o of steps) {
      if (!o || !(o.cost > 0) || !isFinite(o.cost)) continue;
      const score = (rate(o.next.level, 0, o.next.ram, o.next.cores) - gain) / o.cost;
      if (score > stepScore) { step = o; stepScore = score; }
    }
    // The next step costs more per hash than the bundle so far: every further
    // one only dilutes it.
    if (!step || stepScore <= best.gain / best.cost) break;
    Object.assign(s, step.next);
    cost += step.cost;
    gain = rate(s.level, 0, s.ram, s.cores);
    best = { cost, gain };
  }
  return best;
}

/**
 * How long an upgrade takes to earn its price back, selling every hash it adds.
 * @param {number} cost @param {number} gainPerSec extra hashes/s
 * @param {number} dollarsPerHash
 */
export function paybackMs(cost, gainPerSec, dollarsPerHash) {
  if (!(gainPerSec > 0) || !(dollarsPerHash > 0)) return Infinity;
  return (cost / (gainPerSec * dollarsPerHash)) * 1000;
}

/**
 * @typedef {{index: number, level: number, ram: number, cores: number, cache: number, ramUsed: number}} FleetServer
 * @typedef {{level: number, ram: number, cores: number}} UpgradeCosts
 *   Price of +1 level / x2 RAM / +1 core on that server (Infinity or <= 0 = unavailable).
 * @typedef {{kind: "server" | "level" | "ram" | "core", index: number, cost: number, gain: number, score: number,
 *   bundleCost?: number, bundleGain?: number}} Candidate
 *   `cost` / `gain` are what this one purchase costs and adds. A new server also
 *   carries the bundle it is scored and payback-tested on (newServerBundle).
 */

/**
 * Every purchasable step, scored by marginal hashes/s per dollar, best first.
 * A new server is scored on its bundle - see newServerBundle.
 * @param {{
 *   servers: FleetServer[],
 *   costs: UpgradeCosts[],
 *   purchaseCost: number,
 *   rate: (level: number, ramUsed: number, ram: number, cores: number) => number,
 *   limits?: typeof HACKNET_SERVER,
 *   costMults?: {level?: number, ram?: number, cores?: number},
 *   bundle?: {cost: number, gain: number},
 * }} c  `costs` is parallel to `servers`; `purchaseCost` is the next server's price;
 *   `costMults` are the player's hacknet cost multipliers (for the bundle's prices);
 *   `bundle` is newServerBundle's answer for this purchaseCost, when the caller
 *   already has it (it only changes when a server is bought).
 * @returns {Candidate[]}
 */
export function rankUpgrades({ servers, costs, purchaseCost, rate, limits = HACKNET_SERVER, costMults = {}, bundle: known }) {
  /** @type {Candidate[]} */
  const out = [];
  const push = (kind, index, cost, gain) => {
    if (!(cost > 0) || !isFinite(cost) || !(gain > 0)) return;
    out.push({ kind, index, cost, gain, score: gain / cost });
  };

  if (servers.length < limits.maxServers) {
    const gain = rate(1, 0, 1, 1);
    const bundle = known ?? newServerBundle({ purchaseCost, rate, costMults, limits });
    if (purchaseCost > 0 && isFinite(purchaseCost) && gain > 0 && bundle.gain > 0) {
      out.push({
        kind: "server", index: servers.length, cost: purchaseCost, gain,
        score: bundle.gain / bundle.cost, bundleCost: bundle.cost, bundleGain: bundle.gain,
      });
    }
  }

  servers.forEach((s, i) => {
    const c = costs[i] ?? { level: Infinity, ram: Infinity, cores: Infinity };
    const now = rate(s.level, s.ramUsed, s.ram, s.cores);
    if (s.level < limits.maxLevel) push("level", s.index, c.level, rate(s.level + 1, s.ramUsed, s.ram, s.cores) - now);
    if (s.ram < limits.maxRam) push("ram", s.index, c.ram, rate(s.level, s.ramUsed, s.ram * 2, s.cores) - now);
    if (s.cores < limits.maxCores) push("core", s.index, c.cores, rate(s.level, s.ramUsed, s.ram, s.cores + 1) - now);
  });

  return out.sort((a, b) => b.score - a.score);
}

/**
 * The best-scoring candidate that fits the budget and pays back in time, or
 * null with the reason nothing did.
 * @param {Candidate[]} ranked from rankUpgrades
 * @param {{budget: number, dollarsPerHash: number, maxPaybackMs: number}} c
 * @returns {{pick: Candidate | null, reason: string}}
 */
export function pickUpgrade(ranked, { budget, dollarsPerHash, maxPaybackMs }) {
  if (ranked.length === 0) return { pick: null, reason: "fleet maxed" };
  let sawAffordable = false;
  for (const c of ranked) {
    if (c.cost > budget) continue;
    sawAffordable = true;
    // A new server pays back as the bundle it opens up, not as its first level.
    if (paybackMs(c.bundleCost ?? c.cost, c.bundleGain ?? c.gain, dollarsPerHash) <= maxPaybackMs) {
      return { pick: c, reason: "ok" };
    }
  }
  return { pick: null, reason: sawAffordable ? "payback too slow" : "over budget" };
}

/**
 * @typedef {{name: string, target?: string, cost: number, priority: number}} Investment
 *   A hash upgrade worth buying now; lower priority number = wanted more.
 * @typedef {{name: string, target?: string, count: number}} HashAction
 */

/**
 * What to do with this tick's hashes. See the file header for the policy.
 * @param {{
 *   hashes: number,
 *   capacity: number,
 *   sellCost: number,
 *   investments?: Investment[],
 *   cashPriority?: boolean,
 *   investMaxCapacityFraction?: number,
 *   sellAboveCapacityFraction?: number,
 * }} c  `sellCost` is the hashes per "Sell for Money"; cashPriority => sell everything.
 * @returns {{actions: HashAction[], saving: Investment | null, blocked: Investment | null, sellCount: number}}
 */
export function planHashSpend({
  hashes,
  capacity,
  sellCost,
  investments = [],
  cashPriority = false,
  investMaxCapacityFraction = 0.5,
  sellAboveCapacityFraction = 0.9,
}) {
  /** @type {HashAction[]} */
  const actions = [];
  let left = hashes;
  /** @type {Investment | null} */
  let saving = null;
  /** @type {Investment | null} */
  let blocked = null;

  if (!cashPriority) {
    const wanted = investments
      .filter(i => i.cost > 0 && isFinite(i.cost))
      .sort((a, b) => a.priority - b.priority || a.cost - b.cost);

    for (const inv of wanted) {
      if (inv.cost <= left) {
        actions.push({ name: inv.name, target: inv.target, count: 1 });
        left -= inv.cost;
        continue;
      }
      if (inv.cost <= capacity * investMaxCapacityFraction) {
        // Worth waiting for: hold what we have and buy nothing cheaper and less
        // wanted in the meantime, or we'd never accumulate to it.
        saving = inv;
        break;
      }
      // Too dear for the cache we have - the helper's cue to buy cache. Keep
      // looking: something less wanted may still be affordable.
      if (!blocked) blocked = inv;
    }
  }

  // Sell the rest - all of it, unless we're saving. (A saved-for investment
  // costs at most investMaxCapacityFraction of capacity and we hold less than
  // that, so the near-capacity sell-down below can't trigger while saving in
  // the normal case; it covers a cache that shrank, e.g. after a server was
  // lost, so the fleet never sits full.)
  let sellCount = 0;
  if (sellCost > 0) {
    const sellable = saving
      ? Math.max(0, left - Math.max(saving.cost, sellAboveCapacityFraction * capacity))
      : left;
    sellCount = Math.floor(sellable / sellCost);
    if (sellCount > 0) actions.push({ name: "Sell for Money", count: sellCount });
  }

  return { actions, saving, blocked, sellCount };
}

/**
 * Whether the daemon's current activity makes a hash multiplier worth buying:
 * studying (any of the university actions) or gym training.
 * @param {string | undefined} action the daemon's published gordState.action
 */
export function activityHints(action) {
  const a = typeof action === "string" ? action.toLowerCase() : "";
  return {
    studying: a.includes("study"),
    training: a.includes("training"),
  };
}
