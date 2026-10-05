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
 * @param {number[]} [p.hosts]  the room (GB) on each of the fleet's hosts - what
 *        makes the plan PACKING-AWARE. A grow that finds no host to take it whole
 *        is split, and a split grow has to be padded (splitGrowPadding), so:
 *        - a grow NO host can hold is planned as the split grow it is bound to
 *          be (`split`), padding included;
 *        - otherwise the plan records how many of its grows the hosts can seat
 *          whole at once (`growSeats`) and what the padding would add
 *          (`splitExtra`, GB), and costAt bills the batches past that number.
 * @param {number} [p.minSecurity]     the target's, for that padding
 * @returns {null | {moneyFraction: number, hackedFraction: number, hackThreads: number,
 *   growThreads: number, weaken1Threads: number, weaken2Threads: number, ram: number,
 *   split: boolean, securityAdded: number, growSeats?: number, splitExtra?: number}}
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
  let growThreads = Math.max(1, Math.ceil(p.growThreadsFor(1 - hackedFraction) * (1 + (p.growPadding ?? 0))));
  const weaken1Threads = Math.max(1, Math.ceil((hackThreads * p.securityPerHack) / p.weakenAmount));
  let weaken2Threads = Math.max(1, Math.ceil((growThreads * p.securityPerGrow) / p.weakenAmount));
  const rt = p.ramPerThread;

  // The batch as a pool of gigabytes would carry it - what targets are RANKED on
  // (incomeCurve), so that knowing the hosts changes how a target's share is
  // spent and not which target gets it.
  const nominalRam = hackThreads * rt.hack + growThreads * rt.grow + (weaken1Threads + weaken2Threads) * rt.weaken;

  // How the batch sits on the fleet's hosts (costAt / stolenAt work from this).
  let packing = null;
  let split = false;
  if (p.hosts) {
    const growRam = growThreads * rt.grow;
    const hackRam = hackThreads * rt.hack;
    // Seats: how many batches of a full window can have that leg WHOLE on some
    // host. A host seats one per whole batch it holds, and one more if what is
    // left over still takes the leg (the rest of that batch goes in pieces,
    // elsewhere). Counting grows alone said a 64GB host seats two 25GB grows -
    // but the first one's batch is 53GB, and the second grow has 11GB to go in.
    let growSeats = 0;   // batches whose grow can sit whole
    let pairSeats = 0;   // ...and whose hack can sit whole beside it
    let hackSeats = 0;   // hack legs on their own (for a grow that is split anyway)
    for (const room of p.hosts) {
      const whole = Math.floor(room / nominalRam + 1e-9);
      const left = room - whole * nominalRam + 1e-9;
      growSeats += whole + (left >= growRam ? 1 : 0);
      pairSeats += whole + (left >= growRam + hackRam ? 1 : 0);
      hackSeats += Math.floor(room / hackRam + 1e-9);
    }
    const padded = splitGrowPadding({
      growThreads, minSecurity: p.minSecurity ?? 0, securityPerGrow: p.securityPerGrow, weakenAmount: p.weakenAmount,
    });
    const extraGrow = padded.growThreads - growThreads;
    const extraWeaken = Math.max(0, padded.weaken2Threads - weaken2Threads);
    // A grow NO host can hold is a split grow, always: it is planned as one.
    split = growSeats === 0;
    if (split) {
      growThreads += extraGrow;
      weaken2Threads += extraWeaken;
    }
    packing = {
      growSeats,
      splitExtra: split ? 0 : extraGrow * rt.grow + extraWeaken * rt.weaken,
      // A grow that is split anyway is placed after the hack (the manager's
      // placeBatch), which then has the pick of the hosts.
      wholeHacks: split ? hackSeats : pairSeats,
    };
  }

  const ram =
    hackThreads * rt.hack +
    growThreads * rt.grow +
    (weaken1Threads + weaken2Threads) * rt.weaken;

  return {
    moneyFraction: p.moneyFraction ?? hackedFraction,
    hackedFraction,
    hackThreads,
    growThreads,
    weaken1Threads,
    weaken2Threads,
    ram,
    nominalRam,
    ...packing,
    split,
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
 * What ONE batch of `plan` has to be budgeted at when `depth` of them fly at
 * once: its RAM - plus, for a plan made knowing the fleet's hosts (planBatch's
 * `hosts`), its share of the padding the grows that cannot sit whole will need.
 * Only `growSeats` of them can; on a 1TB fleet of one 512GB host and eight of
 * 64GB, half the grows of a six-batch window were split, each launched with
 * padding nobody had budgeted, and the window never filled.
 * @param {any} plan @param {number} [depth]
 */
export function costAt(plan, depth = 1) {
  if (!(depth > plan.growSeats)) return plan.ram;
  return plan.ram + plan.splitExtra * (depth - plan.growSeats) / depth;
}

/**
 * The fraction of the target's money ONE batch of `plan` takes on average when
 * `depth` of them fly at once: `hackedFraction`, unless the plan was made
 * knowing the fleet's hosts and they cannot seat that many hack legs whole.
 *
 * A hack leg split across hosts lands as several hack() calls in the same
 * instant, one after another, and each takes its percentage of what the ones
 * before it LEFT - so the parts of a bite f add up to less than f, down to
 * 1 - e^-f for many small parts (a 50% bite in pieces takes 39%). The grow was
 * sized for the whole bite either way. Left out, a thin window looked best as
 * one fat batch whose hack had to go onto four small hosts, and paid 2.4% less
 * than the nine batches it replaced.
 * @param {any} plan @param {number} [depth]
 */
export function stolenAt(plan, depth = 1) {
  if (!(depth > plan.wholeHacks)) return plan.hackedFraction;
  const pieces = 1 - Math.exp(-plan.hackedFraction);
  return (plan.wholeHacks * plan.hackedFraction + (depth - plan.wholeHacks) * pieces) / depth;
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
 * A plan is fitted by what it costs with `depth` of them in flight (costAt): its
 * RAM, or - when the plan was made knowing the fleet's hosts - the thread slots
 * it will occupy on them.
 *
 * `from` is a thread count already known to fit a SMALLER budget (planCycle
 * walks its depths from deep to shallow, and the bite only grows): the search
 * gallops up from there instead of bisecting from one.
 *
 * @param {{ramBudget: number, maxThreads: number, planFor: (hackThreads: number) => any,
 *          depth?: number, from?: number}} p
 */
export function largestBatch(p) {
  const fits = plan => !!plan && costAt(plan, p.depth) <= p.ramBudget;
  const max = Math.max(1, Math.floor(p.maxThreads));
  let lo = 1;
  let best = p.planFor(1);
  if (!fits(best)) return null;
  let hi = max;
  if (p.from > 1) {
    const start = Math.min(max, Math.floor(p.from));
    const plan = p.planFor(start);
    if (fits(plan)) {
      lo = start;
      best = plan;
      for (let step = 1; lo + step < max; step *= 2) {
        const next = p.planFor(lo + step);
        if (!fits(next)) { hi = lo + step - 1; break; }
        lo += step;
        best = next;
      }
    } else {
      hi = start - 1;
    }
  }
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const plan = p.planFor(mid);
    if (fits(plan)) {
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
 * fattest batch that still lets `depth` of them share `totalRam`. When the RAM
 * can't carry a full window of EFFICIENT batches (efficientThreads), the window
 * is thinned instead - fewer batches at the efficient size - whenever that
 * steals more (never below one batch); null when not even a one-thread batch
 * fits.
 *
 * `maxDepth` caps the number of concurrent batches (each is four processes; a
 * five-minute weaken at 1.2 s launches would otherwise mean ~250 batches in the
 * air). When it binds, launches are spread evenly - the interval stretches to
 * lastLanding / maxDepth - and the bite grows to fill RAM with fewer, fatter
 * batches.
 *
 * A thin window's batch is not fixed at the efficient size either: every depth
 * below the full one is tried with the FATTEST batch that lets that many share
 * the RAM, and the depth that steals most wins when it beats the efficient-size
 * window by THIN_MARGIN. The efficient size alone left a small fleet holding
 * whatever a whole number of those batches came to - two of 45GB on 120GB, one
 * of 30GB on 56GB (a 128GB fleet averaged ~67% of its RAM in use) - where three
 * of 40GB, or one of 54GB, steal more.
 *
 * @param {{totalRam: number, lastLanding: number, launchInterval: number,
 *   maxThreads: number, planFor: (hackThreads: number) => any, maxDepth?: number,
 *   keepDepth?: number}} p  keepDepth: the depth of the window now in flight
 * @returns {null | {plan: any, depth: number, ramBudget: number, launchInterval: number}}
 */
export function planCycle(p) {
  const fresh = freshCycle(p);
  if (!fresh || !(p.keepDepth > 0) || fresh.depth === p.keepDepth) return fresh;
  // A window with batches in the air keeps its DEPTH while a window of that
  // depth steals nearly what the best one would (SHAPE_HOLD) - its bite still
  // follows the budget. Two shapes that steal about the same (eighty batches of
  // 2.7% or thirty-five of 6.3%) trade places on a 3% wobble of the budget, and
  // every swap to the shallower one stops launching until the window has
  // emptied down to it: a 4TB fleet flew at two thirds of its RAM.
  let launchInterval = p.launchInterval;
  if (p.maxDepth > 0) launchInterval = Math.max(launchInterval, p.lastLanding / p.maxDepth);
  const depth = Math.min(Math.floor(p.keepDepth), batchDepth(p.lastLanding, launchInterval));
  const plan = largestBatch({ maxThreads: p.maxThreads, planFor: p.planFor, ramBudget: p.totalRam / depth, depth });
  if (!plan || depth * stolenAt(plan, depth) < fresh.depth * stolenAt(fresh.plan, fresh.depth) * (1 - SHAPE_HOLD)) return fresh;
  return { plan, depth, ramBudget: p.totalRam / depth, launchInterval };
}

// How much less a window of the depth already in flight may steal (on paper)
// than the best window, and still be kept.
const SHAPE_HOLD = 0.05;

/** planCycle, with no window in flight to be loyal to. */
function freshCycle(p) {
  let launchInterval = p.launchInterval;
  if (p.maxDepth > 0) launchInterval = Math.max(launchInterval, p.lastLanding / p.maxDepth);
  const fullDepth = batchDepth(p.lastLanding, launchInterval);
  const fit = { maxThreads: p.maxThreads, planFor: p.planFor };

  const byDepth = largestBatch({ ...fit, ramBudget: p.totalRam / fullDepth, depth: fullDepth });
  const full = byDepth ? { plan: byDepth, depth: fullDepth, ramBudget: p.totalRam / fullDepth, launchInterval } : null;

  // A budget too small for the EFFICIENT batch at full depth is better spent on
  // fewer, fatter batches than on a full window of tiny ones: a one-thread
  // batch still needs its grow and two weaken threads, so most of its RAM steals
  // nothing. Income is depth x bite either way, so compare them directly.
  const efficient = efficientThreads(p);
  if (full && byDepth.hackThreads >= efficient) return full;

  // The plain thin window: as many batches of the efficient size as fit.
  let plain = full;
  const sized = largestBatch({ ...fit, maxThreads: efficient, ramBudget: p.totalRam });
  if (sized) {
    const depth = Math.max(1, Math.min(fullDepth, Math.floor(p.totalRam / sized.ram)));
    const thin = { plan: sized, depth, ramBudget: sized.ram, launchInterval };
    plain = full && fullDepth * byDepth.hackedFraction >= depth * sized.hackedFraction ? full : thin;
  }
  if (!plain) return null;

  // ...and the depth x fattest-batch that steals most, which replaces it when it
  // is clearly better (THIN_MARGIN): the two are compared on paper, and a plan
  // that fills its RAM to the last gigabyte on paper does not quite do so on
  // real hosts.
  let best = null;
  let stolen = plain.depth * plain.plan.hackedFraction * (1 + THIN_MARGIN);
  // The most one batch can take: no depth below stolen / that can catch up.
  const cap = p.planFor(Math.max(1, Math.floor(p.maxThreads)))?.hackedFraction ?? 1;
  let from = byDepth ? byDepth.hackThreads : 1;
  for (let depth = fullDepth - 1; depth >= 1 && depth * cap > stolen; depth--) {
    const plan = largestBatch({ ...fit, ramBudget: p.totalRam / depth, depth, from });
    if (!plan) continue;
    from = plan.hackThreads;
    // Strictly more: of two depths that steal the same, the deeper one's smaller
    // batches pack onto hosts more easily.
    const takes = depth * stolenAt(plan, depth);
    if (takes > stolen) {
      stolen = takes;
      best = { plan, depth, ramBudget: p.totalRam / depth, launchInterval };
    }
  }
  return best ?? plain;
}

// How much more a searched thin window has to steal (on paper) than the plain
// one of efficient-size batches before it is used instead.
const THIN_MARGIN = 0.03;

// Past this many hack threads the fixed overhead of a batch (one grow, two
// weakens, each rounded up) is long since spread thin, so the search for the
// most RAM-efficient size stops here.
const EFFICIENT_SEARCH_MAX = 64;

/**
 * The hack thread count (up to EFFICIENT_SEARCH_MAX) at which a batch steals the
 * most per GB. Small batches are dominated by rounding - the grow and both
 * weakens are at least a thread each - so efficiency climbs with the first few
 * dozen hack threads before the grow's own growth turns it back down.
 * @param {{maxThreads: number, planFor: (hackThreads: number) => any}} p
 */
export function efficientThreads(p) {
  const rates = [];
  for (const threads of threadLadder(Math.min(p.maxThreads, EFFICIENT_SEARCH_MAX))) {
    const plan = p.planFor(threads);
    if (!plan || !(plan.ram > 0)) continue;
    rates.push({ threads, rate: plan.hackedFraction / plan.ram });
  }
  if (!rates.length) return 1;
  // The SMALLEST size within a few percent of the best: the curve is flat near
  // its top, and a smaller batch packs onto hosts whole and wastes less of the
  // budget to rounding (the window holds a whole number of them).
  const best = Math.max(...rates.map(r => r.rate));
  return rates.find(r => r.rate >= best * (1 - EFFICIENT_TOLERANCE)).threads;
}

const EFFICIENT_TOLERANCE = 0.05;

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

// ── Sharing RAM between targets ──────────────────────────────────────────────
//
// A target's income is LINEAR in its hack threads but its RAM is not: the grow
// that repairs a 50% bite needs far more than five times the threads of the one
// that repairs 10% (it grows from half, not from nine tenths). So a target's
// income-per-GB falls as its bite gets fatter, and the right split of a fleet
// between targets is the one where the LAST gigabyte earns the same everywhere.
//
// The manager used to do the opposite: rank targets by what each would earn with
// the whole fleet, hand the top one the fattest bite it could take, and spill
// only what it could not absorb. On a big fleet that spends most of the RAM on
// the worst part of the best target's curve (a 50% bite) while the next target
// gets scraps - and which target counts as "best with everything" moves with
// every change in fleet size, taking the allocation with it.

/**
 * What an unprepped target's income is worth next to a prepped one's: over a
 * planning horizon it earns nothing for `prepMs` of it. 1 when no prep is needed.
 * @param {number} prepMs @param {number} horizonMs
 */
export function prepDiscount(prepMs, horizonMs) {
  if (!(prepMs > 0)) return 1;
  if (!(horizonMs > 0)) return 0;
  return horizonMs / (horizonMs + prepMs);
}

/**
 * Hack thread counts to sample a target's income curve at: every count up to 4,
 * then roughly x1.5 steps, always ending on `maxThreads`.
 * @param {number} maxThreads
 */
export function threadLadder(maxThreads) {
  const max = Math.max(1, Math.floor(maxThreads));
  const out = [];
  for (let h = 1; h < max; h = h < 4 ? h + 1 : Math.ceil(h * 1.5)) out.push(h);
  out.push(max);
  return out;
}

/**
 * A target's income at a ladder of bite sizes, each run at full depth: the
 * points (RAM held in steady state, $/ms) the allocator works from.
 * @param {{maxMoney: number, hackChance: number, lastLanding: number, launchInterval: number,
 *   maxThreads: number, planFor: (hackThreads: number) => any, maxDepth?: number}} p
 * @returns {{ram: number, income: number, threads: number}[]}
 */
export function incomeCurve(p) {
  let launchInterval = p.launchInterval;
  if (p.maxDepth > 0) launchInterval = Math.max(launchInterval, p.lastLanding / p.maxDepth);
  const depth = batchDepth(p.lastLanding, launchInterval);
  const points = [];
  for (const threads of threadLadder(p.maxThreads)) {
    const plan = p.planFor(threads);
    if (!plan || !(plan.ram > 0)) continue;
    const income = incomeRate({ maxMoney: p.maxMoney, hackChance: p.hackChance, plan, launchInterval });
    if (income > 0) points.push({ ram: depth * (plan.nominalRam ?? plan.ram), income, threads });
  }
  return points;
}

// ── When money is not the point (BN8) ────────────────────────────────────────
//
// In BitNode 8 a script hack pays nothing (ScriptHackMoneyGain 0) and the stock
// trader is the whole economy. What the batcher is FOR there is (a) moving the
// stocks the trader holds or wants, and (b) hacking exp towards the world
// daemon's level. Both fit the allocator unchanged - it only needs each
// target's curve in the unit that matters:
//
// (a) A hack() or grow() carrying { stock: true } moves the second-order
//     forecast of the server's company by 0.1 with probability
//     (money moved by that call) / (the server's MAX money) - one roll per call,
//     whatever its thread count (bitburner-src PlayerInfluencing.ts). The money
//     counted is what leaves or enters the SERVER: a hack that pays $0 counts in
//     full, a failed hack and a grow on a full server count for nothing. So the
//     expected push is 0.1 x the fraction of max money cycled, and a batch
//     cycles its bite once (the workers flag only the leg that pushes the wished
//     way). Forecast moved per millisecond = bite x chance / launch interval:
//     incomeCurve with a max money of 1.
// (b) Every thread that lands is worth the same exp on a given server -
//     (3 + 0.3 x base security) x multipliers, a quarter of it for a failed hack
//     (Hacking.ts calculateHackingExpGain) - so exp per millisecond is threads
//     landed per interval (expCurve), and per GB it barely depends on the bite:
//     what matters is which server (short legs, high base security) and that
//     the RAM is full.

/**
 * The trader's wish list as weights, when it asks for its servers to be WORKED
 * ahead of everything else (`prefer`) and the list is fresh; null otherwise -
 * and then nothing about the ranking changes.
 *
 * Each list is "most valuable first" (positions held, then by the size of the
 * stock's moves), and that order is all the manager is told, so the weight
 * falls by `decay` per place: a server further down gets RAM ahead of one above
 * it only where it turns a gigabyte into that much more forecast.
 *
 * @param {{up?: string[], down?: string[], prefer?: boolean, updatedAt?: number} | null | undefined} wishes
 * @param {number} now @param {number} maxAgeMs @param {number} decay per place, 0..1
 * @returns {Map<string, number> | null} host -> weight (1 for the head of a list)
 */
export function preferredWishes(wishes, now, maxAgeMs, decay) {
  if (!wishes || wishes.prefer !== true) return null;
  if (!(now - wishes.updatedAt < maxAgeMs) || !(now - wishes.updatedAt > -maxAgeMs)) return null;
  const weights = new Map();
  for (const list of [wishes.up, wishes.down]) {
    if (!Array.isArray(list)) continue;
    list.forEach((host, place) => {
      const weight = Math.pow(decay, place);
      if (typeof host === "string" && weight > (weights.get(host) ?? 0)) weights.set(host, weight);
    });
  }
  return weights;
}

/**
 * Hacking exp one landed thread is worth on a server, up to the multipliers
 * every server shares. The game's figure is 3 + 0.3 x BASE security; the
 * manager does not read that (ns.getServerBaseSecurityLevel is another 0.1GB)
 * and a server's minimum is a third of its base, rounded - so this is within a
 * rounding step of it, which is plenty for ranking.
 * @param {number} minSecurity
 */
export function expPerThread(minSecurity) {
  return 3 + 0.9 * Math.max(1, minSecurity);
}

/**
 * incomeCurve's twin for hacking exp: at each bite on the ladder, the RAM the
 * full window holds and the exp it lands per millisecond.
 * @param {{minSecurity: number, hackChance: number, lastLanding: number, launchInterval: number,
 *   maxThreads: number, planFor: (hackThreads: number) => any, maxDepth?: number}} p
 * @returns {{ram: number, income: number, threads: number}[]}
 */
export function expCurve(p) {
  let launchInterval = p.launchInterval;
  if (p.maxDepth > 0) launchInterval = Math.max(launchInterval, p.lastLanding / p.maxDepth);
  const depth = batchDepth(p.lastLanding, launchInterval);
  const each = expPerThread(p.minSecurity);
  const chance = Math.min(1, Math.max(0, p.hackChance));
  const points = [];
  for (const threads of threadLadder(p.maxThreads)) {
    const plan = p.planFor(threads);
    if (!plan || !(plan.ram > 0)) continue;
    const landed = plan.hackThreads * (chance + (1 - chance) / 4)
      + plan.growThreads + plan.weaken1Threads + plan.weaken2Threads;
    points.push({ ram: depth * (plan.nominalRam ?? plan.ram), income: (landed * each) / launchInterval, threads });
  }
  return points;
}

/**
 * The upper concave hull of an income curve, starting at the origin. Thread
 * rounding makes the raw curve bumpy (and a one-thread batch is mostly weaken
 * overhead, so the curve starts convex); the hull is the curve a budget can
 * actually buy along, with strictly falling slopes.
 * @param {{ram: number, income: number}[]} points
 */
export function concaveHull(points) {
  const sorted = points
    .filter(p => p.ram > 0 && p.income > 0)
    .sort((a, b) => a.ram - b.ram || b.income - a.income);
  const hull = [{ ram: 0, income: 0 }];
  for (const p of sorted) {
    if (p.income <= hull[hull.length - 1].income) continue; // more RAM for no more income
    while (hull.length >= 2) {
      const a = hull[hull.length - 2];
      const b = hull[hull.length - 1];
      // Drop b when it sits on or under the chord a -> p.
      if ((b.income - a.income) * (p.ram - a.ram) <= (p.income - a.income) * (b.ram - a.ram)) hull.pop();
      else break;
    }
    hull.push(p);
  }
  return hull;
}

/**
 * Split `totalRam` between targets so the marginal gigabyte earns the same on
 * each: every hull segment of every target is a "next slice of RAM at this
 * $/ms per GB", and the slices are taken best first until the RAM runs out
 * (the greedy that is exact for concave curves).
 *
 * @param {object} p
 * @param {number} p.totalRam
 * @param {{key: string, points: {ram: number, income: number}[], minRam: number}[]} p.curves
 *        minRam: the smallest batch that target can run (a one-thread plan)
 * @param {number} p.maxTargets
 * @param {number} [p.minTargetRam]  a target after the first isn't opened for less
 * @param {(key: string) => number} [p.bonus]  multiplier on a target's slopes -
 *        the incumbents' edge, so a rescore doesn't swap a prepped target for a
 *        marginally better unprepped one
 * @returns {{key: string, ram: number, income: number}[]} best earner first
 */
export function allocateRam(p) {
  const hulls = p.curves.map(curve => {
    const hull = concaveHull(curve.points);
    const mult = p.bonus ? p.bonus(curve.key) : 1;
    return { key: curve.key, minRam: curve.minRam, hull, mult, ceiling: hull[hull.length - 1].income * mult };
  });
  const greedy = fillBySlope(p, hulls);
  if (hulls.length <= p.maxTargets) return greedy.list;

  // More candidates than slots. Best-slope-first fills the slots with the most
  // RAM-EFFICIENT targets, which is right while RAM is what runs out - but with
  // RAM to spare it is the slots that run out, and they should go to the targets
  // that can earn the most. Try that set too and keep whichever pays more.
  const richest = [...hulls].sort((a, b) => b.ceiling - a.ceiling).slice(0, p.maxTargets);
  const byCeiling = fillBySlope(p, richest);
  return byCeiling.weighted > greedy.weighted ? byCeiling.list : greedy.list;
}

/**
 * allocateRam's greedy over one set of candidate targets.
 * @returns {{list: {key: string, ram: number, income: number}[], weighted: number}}
 */
function fillBySlope(p, hulls) {
  const segments = [];
  const multOf = new Map();
  for (const { key, minRam, hull, mult } of hulls) {
    multOf.set(key, mult);
    for (let i = 1; i < hull.length; i++) {
      const ram = hull[i].ram - hull[i - 1].ram;
      const income = hull[i].income - hull[i - 1].income;
      segments.push({ key, index: i, ram, income, slope: (income / ram) * mult, minRam });
    }
  }
  segments.sort((a, b) => b.slope - a.slope || a.index - b.index);

  /** @type {Map<string, {key: string, ram: number, income: number, next: number}>} */
  const open = new Map();
  const skipped = new Set();
  let left = p.totalRam;
  for (const seg of segments) {
    if (left <= 0) break;
    if (skipped.has(seg.key)) continue;
    const take = Math.min(seg.ram, left);
    let entry = open.get(seg.key);
    if (!entry) {
      // Opening a target: its first slice must at least carry one batch, and a
      // target after the first must be worth the bother.
      const floor = Math.max(seg.minRam, open.size > 0 ? (p.minTargetRam ?? 0) : 0);
      if (seg.index !== 1 || open.size >= p.maxTargets || take < floor) {
        skipped.add(seg.key);
        continue;
      }
      entry = { key: seg.key, ram: 0, income: 0, next: 1 };
      open.set(seg.key, entry);
    }
    if (entry.next !== seg.index) continue; // an earlier slice was only part-taken
    entry.ram += take;
    entry.income += seg.income * (take / seg.ram);
    entry.next = take === seg.ram ? seg.index + 1 : Infinity;
    left -= take;
  }

  const list = [...open.values()]
    .map(({ key, ram, income }) => ({ key, ram, income }))
    .sort((a, b) => b.income - a.income);
  return { list, weighted: list.reduce((sum, e) => sum + e.income * multOf.get(e.key), 0) };
}

/**
 * Hold a set of planned windows to a budget of worker PROCESSES. Every batch in
 * flight is `perBatch` of them (four legs, more when a leg is split) and every
 * one is a script the game has to start and keep, so depth is not free even
 * where RAM is: the windows are taken best earner first, the one that crosses
 * the budget is cut down to what is left of it, and the rest are dropped.
 *
 * @template {{depth: number, income: number}} T
 * @param {T[]} windows best first; income is what the window earns at `depth`
 * @param {number} maxProcesses @param {number} [perBatch]
 * @returns {{kept: (T & {depth: number, income: number})[], processes: number, income: number,
 *            trimmed: boolean}} trimmed: the budget cut something
 */
export function capProcesses(windows, maxProcesses, perBatch = 4) {
  const kept = [];
  let slots = Math.max(0, Math.floor(maxProcesses / perBatch));
  let income = 0;
  let trimmed = false;
  for (const w of windows) {
    if (!(w.depth > 0)) continue;
    const depth = Math.min(w.depth, slots);
    if (depth < w.depth) trimmed = true;
    if (depth <= 0) continue;
    // A window's income is one bite per launch interval: linear in its depth.
    const part = w.income * (depth / w.depth);
    kept.push({ ...w, depth, income: part });
    slots -= depth;
    income += part;
  }
  const used = kept.reduce((sum, w) => sum + w.depth, 0);
  return { kept, processes: used * perBatch, income, trimmed };
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
