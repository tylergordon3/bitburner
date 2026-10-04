// lib/batch-logic.js
//
// PURE planning core for the HGW batcher - no Netscript, no imports, so it is
// unit-testable under Node (tests/batch-logic.test.mjs) and costs 0 import RAM,
// exactly like lib/crime-logic.js and lib/grafting-logic.js. hacking/manager.js
// gathers the per-target numbers from the game (hack %, grow threads, leg times,
// free RAM per host) and delegates every sizing and scheduling decision here.
//
// ── The model ────────────────────────────────────────────────────────────────
// A batch is four legs fired against a PREPPED target (min security, max money)
// and timed so they LAND in the order H, W1, G, W2, `spacing` ms apart-ish. Each
// batch restores the target to the prepped state before the next batch's hack
// lands, so the correctness condition for running many batches concurrently is
// purely about ORDERING: batch N+1's first landing must come after batch N's last.
// Since every batch against one target has the same leg durations, that holds
// whenever launches are spaced by at least the landing span plus a margin -
// legSchedule().launchInterval. The number of batches a target can carry in
// flight is then fixed by timing alone (batchDepth), and the bite each batch
// takes is whatever fills the botnet's RAM at that depth (largestBatch).
//
// That is the whole difference from the old "largest batch that fits, every 200
// ms" loop, whose batches interleaved: each hack after the first landed on a
// server already hacked by the previous one, and the first landing hack tripped
// a re-prep that blocked launching for a full grow-time.

/**
 * Thread counts and RAM for one H/W1/G/W2 batch against a prepped target, sized
 * either by the fraction of its money to steal (`moneyFraction`) or directly by
 * the number of hack threads (`hackThreads`, which wins when both are given -
 * it is what largestBatch searches over, and it has no rounding to argue with).
 *
 * @param {object} p
 * @param {number} [p.moneyFraction]   fraction of max money to steal
 * @param {number} [p.hackThreads]     ...or the hack thread count itself
 * @param {number} p.hackPct           fraction one hack thread steals (prepped state)
 * @param {(remaining: number) => number} p.growThreadsFor
 *        grow threads (1 core) to bring `remaining` (fraction of max) back to full
 * @param {{hack: number, grow: number, weaken: number}} p.ramPerThread
 * @param {number} p.securityPerHack   security added per hack thread (0.002)
 * @param {number} p.securityPerGrow   security added per grow thread (0.004)
 * @param {number} p.weakenAmount      security removed per weaken thread (0.05)
 * @param {number} [p.maxHackFraction] never plan to steal more than this (0.9)
 * @param {number} [p.growPadding]     extra grow threads, as a fraction (0.02 = +2%)
 * @returns {null | {moneyFraction: number, hackedFraction: number, hackThreads: number,
 *   growThreads: number, weaken1Threads: number, weaken2Threads: number, ram: number,
 *   securityAdded: number}}
 */
export function planBatch(p) {
  const maxHack = p.maxHackFraction ?? 0.9;
  const byThreads = p.hackThreads >= 1;
  if (!(p.hackPct > 0) || !(byThreads || p.moneyFraction > 0)) return null;

  let hackThreads = Math.max(1, Math.floor(byThreads ? p.hackThreads : p.moneyFraction / p.hackPct));
  // The cap applies to the hack itself, not just to the grow that repairs it -
  // a strong player against a weak target would otherwise over-hack.
  if (hackThreads * p.hackPct > maxHack) {
    hackThreads = Math.max(1, Math.floor(maxHack / p.hackPct));
  }
  const hackedFraction = Math.min(maxHack, hackThreads * p.hackPct);

  // Padded past the exact count on purpose (growPadding). A batch's grow only
  // ever repairs its own hack, so with the exact count ANY shortfall - the hack
  // landing a little stronger than planned because the hacking level rose
  // during the weaken-time it was in flight, a grow split across hosts - stays,
  // and the next one stacks on it until the drift check drains the target. A
  // grow that slightly over-restores (the excess is clamped at max money) makes
  // each batch close some of whatever gap it finds instead.
  const growThreads = Math.max(1, Math.ceil(p.growThreadsFor(1 - hackedFraction) * (1 + (p.growPadding ?? 0))));
  const weaken1Threads = Math.max(1, Math.ceil((hackThreads * p.securityPerHack) / p.weakenAmount));
  const weaken2Threads = Math.max(1, Math.ceil((growThreads * p.securityPerGrow) / p.weakenAmount));

  const ram =
    hackThreads * p.ramPerThread.hack +
    growThreads * p.ramPerThread.grow +
    (weaken1Threads + weaken2Threads) * p.ramPerThread.weaken;

  return {
    moneyFraction: p.moneyFraction ?? hackedFraction,
    hackedFraction,
    hackThreads,
    growThreads,
    weaken1Threads,
    weaken2Threads,
    ram,
    // What the target looks like while this batch is "open" (hack landed, W2 not
    // yet): the worst case the drift check has to tolerate.
    securityAdded: hackThreads * p.securityPerHack + growThreads * p.securityPerGrow,
  };
}

/**
 * Exec delays for the four legs so they land H, W1, G, W2 around the weaken
 * time, plus the timing facts the scheduler needs. Landing offsets relative to
 * W: hack at -2·spacing, weaken1 at 0, grow at +2·spacing, weaken2 at
 * +3·spacing - the hack and grow legs get a double gap because their shorter
 * durations make them the jittery ones.
 *
 * @param {{hackTime: number, growTime: number, weakenTime: number, spacing: number, margin?: number}} t
 * @returns {{delays: {hack: number, weaken1: number, grow: number, weaken2: number},
 *   landings: {hack: number, weaken1: number, grow: number, weaken2: number},
 *   firstLanding: number, lastLanding: number, span: number, launchInterval: number}}
 */
export function legSchedule(t) {
  const s = t.spacing;
  const W = t.weakenTime;
  const delays = {
    hack: Math.max(0, W - 2 * s - t.hackTime),
    weaken1: 0,
    grow: Math.max(0, W + 2 * s - t.growTime),
    weaken2: 3 * s,
  };
  // Re-derive landings from the (possibly clamped) delays so they're exact.
  const landings = {
    hack: delays.hack + t.hackTime,
    weaken1: delays.weaken1 + W,
    grow: delays.grow + t.growTime,
    weaken2: delays.weaken2 + W,
  };
  const firstLanding = Math.min(landings.hack, landings.weaken1, landings.grow, landings.weaken2);
  const lastLanding = Math.max(landings.hack, landings.weaken1, landings.grow, landings.weaken2);
  const span = lastLanding - firstLanding;
  // Launching this far apart guarantees batch N+1's first landing follows batch
  // N's last, for equal leg durations; the margin absorbs timer jitter and the
  // slow shortening of leg times as hacking level rises.
  const launchInterval = span + (t.margin ?? s);
  return { delays, landings, firstLanding, lastLanding, span, launchInterval };
}

/**
 * The exec delays that land a batch exactly on its window, whatever the target's
 * security is at the moment of launch.
 *
 * A leg's duration is fixed when it starts, at the CURRENT security - and with
 * other batches in flight that is often not the prepped minimum (a hack or a
 * grow has landed and its weaken hasn't yet). Delays computed from the prepped
 * times, as legSchedule's are, then land the leg late by the difference, which
 * for a fat batch is seconds against a 200ms spacing: batches arrive W1,G,H,W2
 * and the target drifts. So the delays are computed here from the leg times as
 * they are NOW (the workers pass them to the game as additionalMsec, which locks
 * the duration at launch): each leg is told to land at `base + its offset in the
 * window`, where `base` is the window's planned start - or the earliest start
 * every leg can still reach, if that is later.
 *
 * @param {{landings: {hack: number, weaken1: number, grow: number, weaken2: number},
 *          firstLanding: number, span: number}} schedule - legSchedule() at prepped times
 * @param {{hackTime: number, growTime: number, weakenTime: number}} cur - leg times now
 * @param {number} now
 * @param {number} windowAt - absolute time this batch's first landing is due
 *   (0 = no slot yet: land as soon as possible)
 * @returns {{base: number, slip: number, lastLanding: number,
 *   delays: {hack: number, weaken1: number, grow: number, weaken2: number}}}
 *   base = when the first leg lands; slip = how far past windowAt that is
 */
export function landingDelays(schedule, cur, now, windowAt) {
  const L = schedule.landings;
  const offset = {
    hack: L.hack - schedule.firstLanding,
    weaken1: L.weaken1 - schedule.firstLanding,
    grow: L.grow - schedule.firstLanding,
    weaken2: L.weaken2 - schedule.firstLanding,
  };
  const duration = { hack: cur.hackTime, weaken1: cur.weakenTime, grow: cur.growTime, weaken2: cur.weakenTime };
  const legs = /** @type {("hack" | "weaken1" | "grow" | "weaken2")[]} */ (["hack", "weaken1", "grow", "weaken2"]);

  const earliest = now + Math.max(...legs.map(k => duration[k] - offset[k]));
  const base = Math.max(windowAt || 0, earliest);
  const delays = { hack: 0, weaken1: 0, grow: 0, weaken2: 0 };
  for (const k of legs) delays[k] = base + offset[k] - now - duration[k];
  return { base, slip: windowAt > 0 ? base - windowAt : 0, lastLanding: base + schedule.span, delays };
}

/**
 * How many batches are in flight at once when one launches every
 * `launchInterval` and each occupies its RAM until its last landing.
 * @param {number} lastLanding  ms from launch to the batch's final leg landing
 * @param {number} launchInterval
 */
export function batchDepth(lastLanding, launchInterval) {
  if (!(launchInterval > 0)) return 1;
  return Math.max(1, Math.ceil(lastLanding / launchInterval));
}

/**
 * The most hack threads a batch may carry: as many as steal `maxHackFraction` of
 * the target's money, and never fewer than one.
 * @param {number} hackPct  fraction one hack thread steals (prepped state)
 * @param {number} maxHackFraction
 */
export function maxHackThreads(hackPct, maxHackFraction) {
  if (!(hackPct > 0)) return 1;
  return Math.max(1, Math.floor(maxHackFraction / hackPct));
}

/**
 * The fattest batch that fits `ramBudget`: a binary search over the hack thread
 * count, 1..maxThreads (a batch's RAM only ever rises with its hack threads).
 * Returns the plan, or null if not even a one-thread batch fits.
 *
 * This replaced a fixed ladder of money fractions (50%, 25%, 10%, 5%, ...) whose
 * rungs were 2-2.5x apart: a budget just short of a rung dropped to the one
 * below, so the best target could be left holding barely 40% of the RAM it had
 * been handed (a 25.6TB fleet took 9.9% bites on 17TB because the 25% rung
 * needed more), and a budget hovering AT a rung flapped between two bites that
 * differed by a factor of two. Sizing by thread fills the budget to within one
 * hack thread.
 *
 * @param {{ramBudget: number, maxThreads: number, planFor: (hackThreads: number) => any}} p
 */
export function largestBatch(p) {
  let best = p.planFor(1);
  if (!best || !(best.ram <= p.ramBudget)) return null;
  let lo = 1;
  let hi = Math.max(1, Math.floor(p.maxThreads));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const plan = p.planFor(mid);
    if (plan && plan.ram <= p.ramBudget) {
      lo = mid;
      best = plan;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * The steady-state plan for one target: the depth timing allows, and the
 * fattest batch that still lets `depth` of them share `totalRam`. When even a
 * one-hack-thread batch can't be carried at full depth, depth is reduced to
 * what that smallest batch allows (never below 1); null when one of those
 * doesn't fit at all.
 *
 * `maxDepth` caps the number of concurrent batches (each is four processes; a
 * five-minute weaken at 1.2 s launches would otherwise mean ~250 batches in the
 * air). When it binds, launches are spread evenly - the interval stretches to
 * lastLanding / maxDepth - and the bite grows to fill RAM with fewer, fatter
 * batches.
 *
 * @param {{totalRam: number, lastLanding: number, launchInterval: number,
 *   maxThreads: number, planFor: (hackThreads: number) => any, maxDepth?: number}} p
 * @returns {null | {plan: any, depth: number, ramBudget: number, launchInterval: number}}
 */
export function planCycle(p) {
  let launchInterval = p.launchInterval;
  if (p.maxDepth > 0) launchInterval = Math.max(launchInterval, p.lastLanding / p.maxDepth);
  const fullDepth = batchDepth(p.lastLanding, launchInterval);

  const byDepth = largestBatch({ ramBudget: p.totalRam / fullDepth, maxThreads: p.maxThreads, planFor: p.planFor });
  if (byDepth) return { plan: byDepth, depth: fullDepth, ramBudget: p.totalRam / fullDepth, launchInterval };

  const plan = p.planFor(1);
  if (!plan || !(plan.ram > 0) || plan.ram > p.totalRam) return null;
  const depth = Math.max(1, Math.min(fullDepth, Math.floor(p.totalRam / plan.ram)));
  return { plan, depth, ramBudget: plan.ram, launchInterval };
}

/**
 * Dollars per millisecond a target actually yields once its cycle is running:
 * one batch lands every `launchInterval`, and each takes `hackedFraction` of max
 * money (times the hack's success chance).
 *
 * This is what targets are RANKED by, and the ranking is deliberately evaluated
 * on a cycle planned against the botnet's WHOLE RAM (see the manager's
 * rankTargets), because a target's income has a hard ceiling that dollars-per-GB
 * cannot see: the interval is set by timing alone, so no amount of RAM makes a
 * small server pay more than maxHackFraction × maxMoney per interval. Ranking by
 * $/GB·ms picks the most RAM-EFFICIENT target, which on a big botnet is how you
 * end up parked on n00dles with most of the fleet idle; ranking by income picks
 * the one that pays most, and the RAM it can't absorb spills to the next target.
 *
 * @param {{maxMoney: number, hackChance: number,
 *   plan: {hackedFraction: number} | null, launchInterval: number}} p
 */
export function incomeRate(p) {
  if (!p.plan || !(p.launchInterval > 0) || !(p.maxMoney > 0)) return 0;
  return (p.plan.hackedFraction * p.maxMoney * p.hackChance) / p.launchInterval;
}

/**
 * Joint weaken/grow sizing for a prep pass, so the weaken also covers the
 * security the grow itself adds (the old code sized weaken for the current
 * excess only and needed two or three more passes to settle).
 *
 * Solve: w·weakenAmount ≥ excess + g·securityPerGrow, w + g ≤ totalThreads.
 * Grow is capped at `growNeeded` so a big botnet doesn't burn thousands of
 * threads over-growing a server that's already at max money.
 *
 * @param {{excessSecurity: number, growNeeded: number, totalThreads: number,
 *   weakenAmount: number, securityPerGrow: number}} p
 * @returns {{weaken: number, grow: number, complete: boolean}}
 *   complete: this pass brings the target fully to prepped state (if all land).
 */
export function prepPlan(p) {
  const T = Math.max(0, Math.floor(p.totalThreads));
  const excess = Math.max(0, p.excessSecurity);
  const need = Math.max(0, Math.ceil(p.growNeeded));
  if (T <= 0) return { weaken: 0, grow: 0, complete: excess === 0 && need === 0 };

  const perGrow = p.securityPerGrow / p.weakenAmount; // weaken threads per grow thread
  const gMax = Math.floor((T - excess / p.weakenAmount) / (1 + perGrow));
  const grow = Math.max(0, Math.min(need, gMax));
  const wantWeaken = Math.ceil((excess + grow * p.securityPerGrow) / p.weakenAmount);
  const weaken = Math.min(T - grow, wantWeaken);
  const complete = weaken >= wantWeaken && grow >= need;
  return { weaken, grow, complete };
}

/**
 * Place every leg's threads across hosts as one plan - so a batch is launched
 * entirely or not at all (a hack leg without its grow and weaken legs is worse
 * than no batch). `hosts` is not mutated.
 *
 * A leg goes WHOLE onto one host when any host has room for it - the tightest
 * such host, which keeps the roomy ones free for the next big leg - and is only
 * split across hosts (largest free RAM first) when none does. Splitting is not
 * free for a grow: its later parts land weaker than planned (see
 * splitGrowPadding, which the caller applies when a split can't be avoided).
 *
 * @param {{host: string, free: number}[]} hosts
 * @param {{script: string, threads: number, ram: number, [k: string]: any}[]} legs
 *        ram = per-thread RAM of that leg's script
 * @returns {{ok: boolean, assignments: {host: string, script: string, threads: number, leg: any}[],
 *   unplaced: number, freeAfter: Map<string, number>}}
 */
export function allocate(hosts, legs) {
  const free = new Map(hosts.map(h => [h.host, h.free]));
  const assignments = [];
  let unplaced = 0;

  for (const leg of legs) {
    let remaining = Math.max(0, Math.floor(leg.threads));
    if (remaining === 0) continue;
    const order = [...free.entries()].sort((a, b) => b[1] - a[1]);
    // Largest-first order, so the LAST host that fits the whole leg is the tightest.
    const need = remaining * leg.ram;
    const whole = order.filter(([, room]) => Math.floor(room / leg.ram) >= remaining).pop();
    if (whole) {
      assignments.push({ host: whole[0], script: leg.script, threads: remaining, leg });
      free.set(whole[0], whole[1] - need);
      continue;
    }
    for (const [host, room] of order) {
      if (remaining <= 0) break;
      const slots = Math.floor(room / leg.ram);
      if (slots <= 0) continue;
      const use = Math.min(slots, remaining);
      assignments.push({ host, script: leg.script, threads: use, leg });
      free.set(host, room - use * leg.ram);
      remaining -= use;
    }
    unplaced += remaining;
  }

  return { ok: unplaced === 0, assignments, unplaced, freeAfter: free };
}

/**
 * Is the target in the prepped state (within tolerance)?
 * @param {{money: number, maxMoney: number, security: number, minSecurity: number,
 *   moneyThreshold: number, securityTolerance: number}} s
 */
export function isPrepped(s) {
  if (!(s.maxMoney > 0)) return false;
  return s.security <= s.minSecurity + s.securityTolerance && s.money >= s.maxMoney * s.moneyThreshold;
}

/**
 * Has the target drifted beyond what the currently OPEN batch can explain?
 * With non-overlapping windows at most one batch is between its hack landing
 * and its final weaken, so the observed state is at worst max money minus that
 * batch's hacked fraction, and min security plus its added security. Anything
 * worse is real drift (a failed ordering, an outside hacker, a level jump) and
 * the caller should stop launching, let the window drain, and re-prep.
 *
 * @param {{money: number, maxMoney: number, security: number, minSecurity: number,
 *   openMoneyFraction: number, openSecurity: number,
 *   moneyTolerance: number, securityTolerance: number}} s
 */
export function driftDetected(s) {
  if (!(s.maxMoney > 0)) return false;
  const moneyFloor = s.maxMoney * (1 - s.openMoneyFraction - s.moneyTolerance);
  const securityCeiling = s.minSecurity + s.openSecurity + s.securityTolerance;
  return s.money < moneyFloor || s.security > securityCeiling;
}

/**
 * Is this target still DRAINING after a drift? Drift latches: once seen, no new
 * batch is launched until every batch already in flight has landed - only then
 * can the target be read (and re-prepped) without our own legs moving it.
 *
 * Unlatched, the check was only ever true on the ticks the state happened to be
 * out of bounds: a grow landing a second later put it back inside, launching
 * resumed into the damaged window, and the target flapped Draining/Batching
 * without ever emptying - so the re-prep the drift was supposed to trigger never
 * came.
 *
 * @param {{wasDraining: boolean, openCount: number, drift: boolean}} s
 *   openCount = this target's batches still in flight
 */
export function stillDraining(s) {
  return s.openCount > 0 && (s.wasDraining || s.drift);
}

// The game's own constants behind preppedScale (src/Hacking.ts,
// src/Server/formulas/grow.ts, src/Server/data/Constants.ts). Not knobs.
const HACK_TIME_DIFF_FACTOR = 2.5;    // skillFactor = 2.5 * requiredLevel * security + 500
const HACK_TIME_BASE_DIFF = 500;
const GROW_BASE_INCR = 0.03;          // per-thread growth log = log1p(0.03 / security)...
const GROW_MAX_LOG = 0.00349388925425578; // ...capped at log1p(0.0035)

/**
 * Factors that turn the ns.* analysis readings - which describe the target at
 * its CURRENT security - into what they would read at min security, the state
 * a batch is planned for. This is the no-Formulas.exe path's stand-in for the
 * Formulas API, built only from numbers the manager already reads:
 *
 *   leg time   ∝ 2.5·requiredLevel·security + 500     (ns.getHackTime & co.)
 *   hack %     ∝ (100 − security) / 100               (ns.hackAnalyze)
 *   grow log   ∝ min(log1p(0.03 / security), cap)     (ns.growthAnalyze threads ∝ 1/that)
 *
 * Everything else in those formulas (skill, multipliers, server growth) is the
 * same at both securities and cancels. Without this the fallback sized every
 * batch from whatever the security was that tick - raised, whenever another
 * batch was between its hack and its weaken - so it planned a smaller hack than
 * the one that landed and a grow that came up short, and money sagged.
 *
 * Multiply: a current leg time by `time`, hackAnalyze by `hackPct`, and a
 * growthAnalyze thread count by `growThreads`.
 *
 * @param {{security: number, minSecurity: number, requiredLevel: number}} s
 * @returns {{time: number, hackPct: number, growThreads: number}}
 */
export function preppedScale(s) {
  const min = s.minSecurity;
  const sec = Math.max(s.security, min);
  if (!(min > 0) || !(sec > min)) return { time: 1, hackPct: 1, growThreads: 1 };
  const req = Math.max(0, s.requiredLevel);
  const diff = x => HACK_TIME_DIFF_FACTOR * req * x + HACK_TIME_BASE_DIFF;
  const growLog = x => Math.min(Math.log1p(GROW_BASE_INCR / x), GROW_MAX_LOG);
  return {
    time: diff(min) / diff(sec),
    // At 100 security hackAnalyze is 0 and there is nothing to scale back up.
    hackPct: sec < 100 ? (100 - min) / (100 - sec) : 1,
    growThreads: growLog(sec) / growLog(min),
  };
}

/**
 * The grow and final-weaken thread counts for a batch whose grow leg has to be
 * SPLIT across hosts.
 *
 * The parts of a split grow land in the same millisecond but one after another,
 * and each raises security (0.004 a thread) for the ones behind it - while the
 * game works out a grow's strength from the security at the instant it lands.
 * So the later parts are weaker than the plan (which sized the leg as one grow
 * at min security) assumed, the batch under-restores, and since a batch's grow
 * only ever repairs its own hack, the shortfall stays and stacks. Measured: a
 * 48% bite on a min-security-10 server came back 13% short.
 *
 * This pads the leg as if EVERY thread landed at the fully raised security - an
 * over-estimate (the first part lands at min), so it holds whatever the part
 * sizes and landing order turn out to be - and sizes the weaken behind it for
 * the padded count. Servers under ~8.5 security need no padding: the game caps a
 * grow thread's strength there, raised or not.
 *
 * @param {{growThreads: number, minSecurity: number, securityPerGrow: number, weakenAmount: number}} p
 * @returns {{growThreads: number, weaken2Threads: number}}
 */
export function splitGrowPadding(p) {
  const growLog = x => Math.min(Math.log1p(GROW_BASE_INCR / x), GROW_MAX_LOG);
  const min = Math.max(p.minSecurity, 1e-9);
  const efficiency = growLog(min + p.growThreads * p.securityPerGrow) / growLog(min);
  const growThreads = Math.max(1, Math.ceil(p.growThreads / efficiency));
  return {
    growThreads,
    weaken2Threads: Math.max(1, Math.ceil((growThreads * p.securityPerGrow) / p.weakenAmount)),
  };
}

/**
 * The faction-rep multiplier `threads` share threads give (1-core hosts):
 * the game's 1 + ln(shareThreads)/25, where its shareThreads counter STARTS AT 1
 * and each sharing thread adds to it (src/NetworkShare/Share.ts) - so one thread
 * is already +2.8%, not +0%.
 * @param {number} threads
 */
export function shareBonus(threads) {
  return 1 + Math.log(1 + Math.max(0, threads)) / 25;
}

/** Share threads needed for `bonus` - shareBonus inverted. */
export function shareThreadsFor(bonus) {
  return Math.max(0, Math.exp(25 * (bonus - 1)) - 1);
}

/**
 * How many share threads to START on a host this tick, given the plan wants
 * `want` there, `have` are running and `freeThreads` more would fit right now.
 *
 * Share takes only RAM that is actually free - it never evicts the botnet's
 * legs (that used to kill half of every in-flight batch on the host, on every
 * target) - and it TOPS UP as legs land, until the plan is met (it used to keep
 * whatever happened to fit on the first tick, so a busy host shared one thread
 * for as long as the rep grind lasted). To keep that from becoming one process
 * per freed thread, a top-up waits until a worthwhile chunk fits: a
 * `maxProcesses`-th of the plan, or everything still missing.
 *
 * @param {{want: number, have: number, freeThreads: number, maxProcesses?: number}} p
 * @returns {number} threads to exec now (0 = wait)
 */
export function shareTopUp(p) {
  const want = Math.max(0, Math.floor(p.want));
  const missing = want - Math.max(0, p.have);
  if (missing <= 0) return 0;
  const fit = Math.min(missing, Math.max(0, Math.floor(p.freeThreads)));
  const chunk = Math.min(missing, Math.max(1, Math.ceil(want / Math.max(1, p.maxProcesses ?? 8))));
  return fit >= chunk ? fit : 0;
}

/**
 * Drop in-flight batches whose last leg has landed.
 * @template {{doneAt: number}} T
 * @param {T[]} inFlight @param {number} now @returns {T[]}
 */
export function pruneInFlight(inFlight, now) {
  return inFlight.filter(b => b.doneAt > now);
}
