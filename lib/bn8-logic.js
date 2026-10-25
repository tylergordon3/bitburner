// lib/bn8-logic.js
//
// The pure half of bn8/daemon.js's install batch - when to stop trading and
// buy - so it can be unit-tested under Node. 0GB: no Netscript in here.
//
// Why a batch at all (bitburner-src v3.0.1): every queued aug multiplies the
// price of every later one by 1.9 (x0.96 with SF11.1 - AugmentationHelpers.ts
// getBaseAugmentationPriceMultiplier), and an install in BN8 takes ALL the
// money back to $250m and re-initialises the stock market (Prestige.ts, the
// BitNode8StartingMoney block and initStockMarket). Buying as the money
// trickled in bought the cheapest augs first - the worst order there is (a $10m
// charisma aug bought first made a $4.4b one cost $161b) - and took capital out
// of a book compounding at 40% an hour. So a run buys NOTHING; it trades until
// another hour of waiting is worth less than an install, then sells the book
// and buys the lot dearest first (lib/daemon-lib.js nextAugPurchase already
// orders that way).
//
// "Worth less": N augs cost roughly step^N, so money buys augs by its LOG, and
// a book growing at r an hour adds ln(1 + r) / ln(step) augs an hour. When that
// falls under minAugsPerHour (the market is saturated: every good stock at its
// share cap, ~$12t of total market cap) a fresh run - 4S kept, the trader back
// at full compounding from $250m - earns augs faster than waiting does.

/** The game's price step per queued aug. @param {number} sf11Level */
export function augPriceStep(sf11Level) {
  const lvl = Math.max(0, Math.min(3, Math.floor(Number(sf11Level) || 0)));
  return 1.9 * [1, 0.96, 0.94, 0.93][lvl];
}

/**
 * Keep a history of a quantity (gross wealth - net worth plus everything spent;
 * hacking exp): append this sample, drop what is older than `keepMs`, and at
 * most one sample per `minGapMs`. Pure - returns a new array.
 * @param {{t: number, v: number}[]} samples @param {{t: number, v: number}} sample
 * @param {number} keepMs @param {number} [minGapMs]
 */
export function recordSample(samples, sample, keepMs, minGapMs = 0) {
  const out = (samples ?? []).filter(s => sample.t - s.t <= keepMs && s.t <= sample.t);
  // The newest sample is always the latest reading; every other one is at least
  // minGapMs from its elder - so the previous latest is replaced while it is
  // still that close to the one before it, and kept once it is not.
  const n = out.length;
  if (n >= 2 && out[n - 1].t - out[n - 2].t < minGapMs) out[n - 1] = sample;
  else out.push(sample);
  return out;
}

/**
 * The newest sample at least `windowMs` older than the latest, or null.
 * @param {{t: number, v: number}[]} samples oldest first @param {number} windowMs
 */
function anchorFor(samples, windowMs) {
  const cur = samples[samples.length - 1];
  let anchor = null;
  for (const s of samples) if (cur.t - s.t >= windowMs) anchor = s;
  return anchor;
}

/**
 * Augs an hour that waiting is currently worth: the log growth of gross wealth
 * over the last `windowMs` (from the newest sample at least that old), over
 * the log of the price step. Null until a full window has been seen.
 * @param {{t: number, v: number}[]} samples oldest first
 * @param {number} windowMs @param {number} step augPriceStep
 */
export function augsPerHour(samples, windowMs, step) {
  if (!samples?.length || !(step > 1)) return null;
  const cur = samples[samples.length - 1];
  const anchor = anchorFor(samples, windowMs);
  if (!anchor || !(anchor.v > 0) || !(cur.v > 0)) return null;
  const hours = (cur.t - anchor.t) / 3_600_000;
  if (!(hours > 0)) return null;
  return Math.log(cur.v / anchor.v) / hours / Math.log(step);
}

/**
 * The linear rate an hour over the last `windowMs` (hacking exp), or 0 before a
 * full window has been seen.
 * @param {{t: number, v: number}[]} samples oldest first @param {number} windowMs
 */
export function ratePerHour(samples, windowMs) {
  if (!samples?.length) return 0;
  const cur = samples[samples.length - 1];
  const anchor = anchorFor(samples, windowMs);
  if (!anchor) return 0;
  const hours = (cur.t - anchor.t) / 3_600_000;
  return hours > 0 ? Math.max(0, (cur.v - anchor.v) / hours) : 0;
}

/**
 * Exp a skill level takes (the game's calculateExp, without its float fix-up).
 * @param {number} level @param {number} mult the skill's multiplier (player x BitNode)
 */
export function expForLevel(level, mult) {
  if (!(mult > 0)) return Infinity;
  return Math.max(0, Math.exp((level / mult + 200) / 32) - 534.6);
}

/**
 * Hours until hacking `level` at the exp rate now - Infinity when no exp is
 * coming in. 0 when it is already there.
 * @param {{level: number, exp: number, mult: number, expPerHour: number}} o
 */
export function hoursToLevel(o) {
  const need = expForLevel(o.level, o.mult) - (o.exp ?? 0);
  if (!(need > 0)) return 0;
  if (!(o.expPerHour > 0)) return Infinity;
  return need / o.expPerHour;
}

/**
 * Should the book be released for the install batch now?
 * @param {object} o
 * @param {number} o.elapsedMs        since the last install (or the node's start)
 * @param {number} o.netWorth
 * @param {number | null} o.augsPerHour  augsPerHour(); null until a window is seen
 * @param {boolean} o.finalRun        The Red Pill is installed: there is no next install
 * @param {number} o.installedAugs
 * @param {boolean} o.daedalusJoined
 * @param {boolean} o.redPillOwned    bought or installed
 * @param {number} o.hoursToDaedalus  hoursToLevel at Daedalus's hacking gate
 * @param {any} cfg CONFIG.stocks.treasury.release
 * @returns {{release: boolean, reason: string | null, why: string}}
 */
export function releaseDecision(o, cfg) {
  const hold = why => ({ release: false, reason: null, why });
  const go = (reason, why) => ({ release: true, reason, why });
  if (o.finalRun) return hold("The Red Pill is in: no more installs, every dollar is compute");
  if (o.elapsedMs < cfg.minRunMs) return hold("too early in the run");
  const late = o.elapsedMs >= cfg.maxRunMs;

  // The run that can reach Daedalus: hold for the invite (and so for The Red
  // Pill, which is bought in this batch) while the hacking gate is in sight.
  const daedalusRun = o.installedAugs >= cfg.daedalusAugs && !o.redPillOwned && !o.daedalusJoined;
  if (daedalusRun && o.hoursToDaedalus * 3_600_000 <= cfg.daedalusWaitMs &&
      o.elapsedMs < cfg.maxRunMs + cfg.daedalusWaitMs) {
    return hold(`hacking ${cfg.daedalusHacking} for Daedalus in ~${o.hoursToDaedalus.toFixed(1)}h`);
  }

  if (o.netWorth < cfg.minNetWorth && !late) return hold("building capital");
  if (o.augsPerHour !== null && o.augsPerHour < cfg.minAugsPerHour) {
    return go("saturated", `waiting buys ${o.augsPerHour.toFixed(2)} augs/h (< ${cfg.minAugsPerHour})`);
  }
  if (late) return go("time", "run reached maxRunMs");
  return hold(o.augsPerHour === null ? "measuring growth" : `waiting buys ${o.augsPerHour.toFixed(2)} augs/h`);
}

/**
 * The install batch's next phase. "raise": the book is being sold (the trader
 * holds everything in cash, fenced); "buy": the fence opens inside the
 * daemon's tick for buyAugs alone, and the install waits until a tick buys
 * nothing more. Pure.
 * @param {{phase: string, since: number} | null} batch
 * @param {{now: number, bookValue: number, netWorth: number}} o
 * @param {any} cfg CONFIG.stocks.treasury.release
 */
export function batchPhase(batch, o, cfg) {
  if (!batch) return null;
  if (batch.phase === "raise") {
    const sold = !(o.bookValue > Math.max(1, o.netWorth) * 1e-4);
    if (sold || o.now - batch.since >= cfg.liquidateTimeoutMs) return { ...batch, phase: "buy", since: o.now, lastQueued: -1 };
  }
  return batch;
}
