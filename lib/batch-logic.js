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
// flight is then fixed by timing alone (batchDepth), and the money fraction per
// batch is whatever fills the botnet's RAM at that depth (chooseFraction).
//
// That is the whole difference from the old "largest batch that fits, every 200
// ms" loop, whose batches interleaved: each hack after the first landed on a
// server already hacked by the previous one, and the first landing hack tripped
// a re-prep that blocked launching for a full grow-time.

/**
 * Thread counts and RAM for one H/W1/G/W2 batch that steals `moneyFraction` of
 * a prepped target's money.
 *
 * @param {object} p
 * @param {number} p.moneyFraction     fraction of max money to steal
 * @param {number} p.hackPct           fraction one hack thread steals (prepped state)
 * @param {(remaining: number) => number} p.growThreadsFor
 *        grow threads (1 core) to bring `remaining` (fraction of max) back to full
 * @param {{hack: number, grow: number, weaken: number}} p.ramPerThread
 * @param {number} p.securityPerHack   security added per hack thread (0.002)
 * @param {number} p.securityPerGrow   security added per grow thread (0.004)
 * @param {number} p.weakenAmount      security removed per weaken thread (0.05)
 * @param {number} [p.maxHackFraction] never plan to steal more than this (0.9)
 * @returns {null | {moneyFraction: number, hackedFraction: number, hackThreads: number,
 *   growThreads: number, weaken1Threads: number, weaken2Threads: number, ram: number,
 *   securityAdded: number}}
 */
export function planBatch(p) {
  const maxHack = p.maxHackFraction ?? 0.9;
  if (!(p.hackPct > 0) || !(p.moneyFraction > 0)) return null;

  let hackThreads = Math.max(1, Math.floor(p.moneyFraction / p.hackPct));
  // The cap applies to the hack itself, not just to the grow that repairs it -
  // a strong player against a weak target would otherwise over-hack.
  if (hackThreads * p.hackPct > maxHack) {
    hackThreads = Math.max(1, Math.floor(maxHack / p.hackPct));
  }
  const hackedFraction = Math.min(maxHack, hackThreads * p.hackPct);

  const growThreads = Math.max(1, Math.ceil(p.growThreadsFor(1 - hackedFraction)));
  const weaken1Threads = Math.max(1, Math.ceil((hackThreads * p.securityPerHack) / p.weakenAmount));
  const weaken2Threads = Math.max(1, Math.ceil((growThreads * p.securityPerGrow) / p.weakenAmount));

  const ram =
    hackThreads * p.ramPerThread.hack +
    growThreads * p.ramPerThread.grow +
    (weaken1Threads + weaken2Threads) * p.ramPerThread.weaken;

  return {
    moneyFraction: p.moneyFraction,
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
 * The largest money fraction whose batch fits `ramBudget`, trying `fractions`
 * largest-first. Returns the plan (with .moneyFraction) or null if even the
 * smallest doesn't fit.
 * @param {{fractions: number[], ramBudget: number, planFor: (f: number) => any}} p
 */
export function chooseFraction(p) {
  const sorted = [...p.fractions].filter(f => f > 0).sort((a, b) => b - a);
  for (const f of sorted) {
    const plan = p.planFor(f);
    if (plan && plan.ram <= p.ramBudget) return plan;
  }
  return null;
}

/**
 * The steady-state plan for one target: the depth timing allows, and the
 * largest fraction that still lets `depth` batches share `totalRam`. When even
 * the smallest fraction can't be carried at full depth, depth is reduced to
 * what the smallest batch allows (never below 1); null when one batch of the
 * smallest fraction doesn't fit at all.
 *
 * `maxDepth` caps the number of concurrent batches (each is four processes; a
 * five-minute weaken at 1.2 s launches would otherwise mean ~250 batches in the
 * air). When it binds, launches are spread evenly - the interval stretches to
 * lastLanding / maxDepth - and the fraction grows to fill RAM with fewer,
 * fatter batches.
 *
 * @param {{fractions: number[], totalRam: number, lastLanding: number,
 *   launchInterval: number, planFor: (f: number) => any, maxDepth?: number}} p
 * @returns {null | {plan: any, depth: number, ramBudget: number, launchInterval: number}}
 */
export function planCycle(p) {
  let launchInterval = p.launchInterval;
  if (p.maxDepth > 0) launchInterval = Math.max(launchInterval, p.lastLanding / p.maxDepth);
  const fullDepth = batchDepth(p.lastLanding, launchInterval);

  const byDepth = chooseFraction({ fractions: p.fractions, ramBudget: p.totalRam / fullDepth, planFor: p.planFor });
  if (byDepth) return { plan: byDepth, depth: fullDepth, ramBudget: p.totalRam / fullDepth, launchInterval };

  const smallest = Math.min(...p.fractions.filter(f => f > 0));
  const plan = p.planFor(smallest);
  if (!plan || !(plan.ram > 0) || plan.ram > p.totalRam) return null;
  const depth = Math.max(1, Math.min(fullDepth, Math.floor(p.totalRam / plan.ram)));
  return { plan, depth, ramBudget: plan.ram, launchInterval };
}

/**
 * Dollars per GB·ms a target yields in steady state - the RAM-bound botnet's
 * real objective. Per batch: fraction × maxMoney × chance; each batch holds
 * plan.ram for ~weakenTime. Throughput per GB is therefore independent of how
 * much RAM we have, which is what makes this a fair comparison between targets.
 * @param {{maxMoney: number, hackChance: number, plan: {hackedFraction: number, ram: number} | null, weakenTime: number}} p
 */
export function targetScore(p) {
  if (!p.plan || !(p.plan.ram > 0) || !(p.weakenTime > 0) || !(p.maxMoney > 0)) return 0;
  return (p.plan.hackedFraction * p.maxMoney * p.hackChance) / (p.plan.ram * p.weakenTime);
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
 * Place every leg's threads across hosts, largest free RAM first, as one plan -
 * so a batch is launched entirely or not at all (a hack leg without its grow and
 * weaken legs is worse than no batch). `hosts` is not mutated.
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
 * Drop in-flight batches whose last leg has landed.
 * @template {{doneAt: number}} T
 * @param {T[]} inFlight @param {number} now @returns {T[]}
 */
export function pruneInFlight(inFlight, now) {
  return inFlight.filter(b => b.doneAt > now);
}
