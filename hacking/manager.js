// hacking/manager.js
//
// The HGW batching botnet - the daemon's core money engine, run OFF-home (exec'd
// by each bnX/daemon.js via ensureHelper) so its ~11GB never competes with the
// daemon for home RAM. globalThis is shared across hosts, so from wherever it
// lands it drives the whole rooted network.
//
// This file is the Netscript I/O shell; every sizing and scheduling decision is
// the pure lib/batch-logic.js (0GB, unit-tested). The shape of the loop:
//
//   1. SNAPSHOT - one walk of the network per tick (rooting and script copies on
//      a throttle, since neither changes tick to tick), giving every step below
//      the same view of free RAM.
//   2. SHARE    - the optional faction-rep ns.share slice (manageShare), placed
//      before sizing so the botnet plans around it.
//   3. RANK     - targets scored by the INCOME they would actually yield with
//      the whole botnet behind them ($/ms, incomeRate), re-ranked every
//      targetRescoreMs rather than every tick.
//   4. SPILL    - the top targets are serviced in rank order, each planned
//      against the RAM the ones above it don't claim, up to maxTargets. One
//      target can only absorb so much: timing fixes its launch interval, so it
//      pays at most maxHackFraction of its money per interval however much RAM
//      exists. At a low hacking level (where n00dles is the best server in
//      reach) that ceiling is small enough to leave most of a purchased fleet
//      idle, which is exactly what this step exists to prevent.
//   5. PREP     - when no batches are in flight against a target and it isn't
//      at min security / max money, launch one joint weaken+grow pass sized so
//      the weaken also covers the grow's own security (prepPlan), then WAIT
//      WITHOUT BLOCKING: the loop keeps ticking (share, the other targets) and
//      simply doesn't launch batches against it until those legs have landed.
//   6. BATCH    - a CONTINUOUS scheduler, per target. Leg delays come from
//      legSchedule so the four legs land H, W1, G, W2; launches are spaced by
//      the landing span plus a margin, which guarantees batch N+1's first
//      landing follows batch N's last. That ordering is the whole correctness
//      condition: each batch restores the prepped state before the next one's
//      hack lands. Timing then fixes how many batches are in flight
//      (batchDepth), and the money fraction per batch is the largest that lets
//      that many batches share the target's RAM budget (planCycle). A batch is
//      allocated across hosts as a whole (allocate) and launched entirely or not
//      at all, so targets never end up sharing a half-launched batch.
//   7. DRIFT    - while batches fly, each target is checked against the worst
//      case one OPEN batch of its own can explain (driftDetected). Real drift
//      stops launching against it, its window drains in ~one weaken-time, and
//      step 5 re-preps it; the other targets carry on.
//
// The old loop launched "the largest batch that fits" every 200ms; those batches
// interleaved (each hack after the first hit an already-hacked server) and the
// first landing hack tripped a re-prep that blocked launching for a grow-time.
//
// Formulas.exe (lib/formulas.js) gives exact steal-%, grow threads, success
// chance and leg timings at the prepped state; without it the ns.* analysis
// approximations are used and hack chance is taken as 1 for ranking. Publishes
// globalThis.gordHackState for the dashboard. Pass --reset to kill stale worker
// scripts across the network before starting.

import { allServers, root } from "../lib/net.js";
import { CONFIG } from "../lib/config.js";
import { emitEvent } from "../lib/events.js";
import { reservedHosts } from "../lib/ns-utils.js";
import * as F from "../lib/formulas.js";
import * as B from "../lib/batch-logic.js";

const H = CONFIG.hacking;
const SH = CONFIG.share;
const HOME = CONFIG.paths.home;
const HACK = CONFIG.paths.hack;
const GROW = CONFIG.paths.grow;
const WEAKEN = CONFIG.paths.weaken;
const SHARE = CONFIG.paths.share;

// Per-thread RAM of the worker scripts, read once in main(); config fallbacks
// until then.
const RAM = { hack: H.fallbackRam.hack, grow: H.fallbackRam.grow, weaken: H.fallbackRam.weaken };
// share.js per-thread RAM: 1.6 (base) + 2.4 (ns.share) = 4.0GB; real value read in main().
let _shareThreadRam = 4.0;

// ── Network snapshot ─────────────────────────────────────────────────────────

/**
 * Per-host RAM (GB) the node daemon wants kept free on a SHARED host, published
 * on globalThis - e.g. space carved out of home so the gang manager can run
 * there. Distinct from reservedHosts (which excludes a whole host); this just
 * shrinks how much of a host the botnet will fill.
 */
function reservedRamFor(server) {
  const m = globalThis.gordReservedRam;
  const v = m && m[server];
  return typeof v === "number" && v > 0 ? v : 0;
}

let _netAt = 0;
let _netServers = /** @type {string[]} */ ([]);
let _rootAt = 0;
// Hosts that already hold the worker scripts. Reset by a manager restart, which
// is also when the scripts on home could have changed.
const _copied = new Set();

/**
 * @typedef {{host: string, max: number, free: number}} Worker
 * @typedef {{now: number, servers: string[], rooted: string[], reserved: Set<string>,
 *            workers: Worker[], totalUsable: number, capacity: number,
 *            hacking: number}} Snapshot
 */

/**
 * One consistent view of the botnet for this tick. The network walk and the
 * rooting pass are throttled (topology and port-opener ownership change on a
 * scale of minutes); free RAM is read fresh every tick.
 * @param {NS} ns @param {number} now @returns {Snapshot}
 */
function buildSnapshot(ns, now) {
  if (_netServers.length === 0 || now - _netAt >= H.networkRescanMs) {
    _netServers = allServers(ns);
    _netAt = now;
  }
  // Purchased servers can be DELETED out from under the cached list - an aug
  // install wipes the whole fleet - and every other ns call on a gone hostname
  // THROWS ("Invalid host"). serverExists is the one probe that just returns
  // false, so drop casualties here, forget their file copies, and force a full
  // rescan next tick.
  const live = _netServers.filter(s => ns.serverExists(s));
  if (live.length !== _netServers.length) {
    for (const gone of _netServers) if (!live.includes(gone)) _copied.delete(gone);
    _netServers = live;
    _netAt = 0;
  }
  if (now - _rootAt >= H.rootRetryMs) {
    _rootAt = now;
    for (const server of _netServers) {
      if (ns.hasRootAccess(server)) continue;
      try { root(ns, server); } catch { /* missing port openers / level - retry later */ }
    }
  }

  const reserved = reservedHosts();
  const rooted = _netServers.filter(s => ns.hasRootAccess(s));
  const workers = [];
  let totalUsable = 0;
  let capacity = 0;
  for (const host of rooted) {
    if (reserved.has(host)) continue;
    const max = ns.getServerMaxRam(host);
    if (max <= 0) continue;
    // Workers import nothing, so the three files are all a host needs.
    if (host !== HOME && !_copied.has(host)) {
      ns.scp([HACK, GROW, WEAKEN], host, HOME);
      _copied.add(host);
    }
    let reserve = reservedRamFor(host);
    if (host === HOME) reserve += H.reserveHomeRam;
    const free = Math.max(0, max - ns.getServerUsedRam(host) - reserve);
    workers.push({ host, max, free });
    totalUsable += free;
    // What this host could give the botnet if nothing else were on it. Free RAM
    // swings wildly within a launch cycle (and collapses to nearly nothing
    // during a big prep), so TARGET RANKING is done against this stable number -
    // otherwise a prep in flight makes every target look unaffordable and the
    // ranking empties out. Per-target RAM BUDGETS still come from free RAM.
    capacity += Math.max(0, max - reserve);
  }
  return { now, servers: _netServers, rooted, reserved, workers, totalUsable, capacity, hacking: ns.getHackingLevel() };
}

/** Re-read free RAM for a few hosts after something outside our plan ran there. */
function refreshWorkers(ns, snap, hosts) {
  for (const host of hosts) {
    const w = snap.workers.find(x => x.host === host);
    if (!w) continue;
    let reserve = reservedRamFor(host);
    if (host === HOME) reserve += H.reserveHomeRam;
    w.free = Math.max(0, w.max - ns.getServerUsedRam(host) - reserve);
  }
  snap.totalUsable = snap.workers.reduce((s, w) => s + w.free, 0);
}

/** Apply an allocation's post-launch free RAM to the snapshot. */
function applyAllocation(snap, alloc) {
  for (const w of snap.workers) {
    const free = alloc.freeAfter.get(w.host);
    if (free !== undefined) w.free = free;
  }
  snap.totalUsable = snap.workers.reduce((s, w) => s + w.free, 0);
}

// ── Faction-rep sharing (ns.share) ────────────────────────────────────────────
//
// While the daemon is farming faction rep, dedicate a small capped slice of the
// botnet to share.js. Running share.js occupies real RAM (it shows up in each
// host's usedRam), so the snapshot's free RAM already excludes it - the botnet
// naturally works around the shared portion without any separate reservation.
// See CONFIG.share for the full rationale and the diminishing-returns math.

// Last-published set of share hosts, so we only log on change (see manageShare).
let _lastShareHosts = "";

/** true when the daemon's current action is faction WORK. */
function farmingRep() {
  if (!SH?.enabled) return false;
  const action = globalThis.gordState?.action;
  if (typeof action !== "string") return false;
  return (SH.repActionPrefixes ?? []).some(p => action.startsWith(p));
}

/** @param {Snapshot} snap - hosts the botnet may draw share threads from (not home/reserved). */
function shareEligibleHosts(snap) {
  return snap.workers.filter(w => w.host !== HOME);
}

/**
 * Total share RAM (GB) to dedicate this tick. A fraction of eligible network RAM
 * (the "use a couple, not all" cap), further capped by targetBonus so we never
 * chase the flat tail of the 1 + ln(threads)/25 curve. Returns 0 below the floor.
 * @param {Worker[]} hosts
 */
function shareBudgetRam(hosts) {
  const totalRam = hosts.reduce((sum, h) => sum + h.max, 0);
  if (totalRam <= 0) return 0;

  // Invert bonus = 1 + ln(T)/25 at targetBonus to get the thread count past
  // which extra share isn't worth the money-RAM, then convert to RAM.
  const targetThreads = Math.exp(25 * (SH.targetBonus - 1));
  const budget = Math.min(SH.fraction * totalRam, targetThreads * _shareThreadRam, SH.maxRam);
  return budget >= SH.minRam ? budget : 0;
}

/**
 * Spread `budgetRam` over the fewest servers (largest-first, so it stays "a
 * couple"), hard-capped at maxServers. Whole or partial per host. Returns a
 * { host: reservedGB } plan.
 * @param {Worker[]} hosts @param {number} budgetRam
 */
function planShare(hosts, budgetRam) {
  const sorted = [...hosts].sort((a, b) => b.max - a.max);
  const plan = {};
  let remaining = budgetRam;
  for (const h of sorted) {
    if (Object.keys(plan).length >= SH.maxServers) break;
    if (remaining < _shareThreadRam) break;
    const give = Math.min(h.max, remaining);
    const threads = Math.floor(give / _shareThreadRam);
    if (threads <= 0) continue;
    plan[h.host] = threads * _shareThreadRam;
    remaining -= plan[h.host];
  }
  return plan;
}

/** @param {NS} ns @param {string} host - threads of share.js currently on host. */
function shareThreadsOn(ns, host) {
  let t = 0;
  for (const p of ns.ps(host)) if (p.filename === SHARE) t += p.threads;
  return t;
}

/**
 * Reconcile running share.js against the current plan. Runs BEFORE the botnet
 * allocation each tick, and returns the hosts it touched so the caller can
 * refresh their free RAM in the snapshot.
 *
 * Each host is started at most once (while it has 0 share threads) and left
 * alone thereafter - we accept whatever thread count actually fit rather than
 * re-evicting to chase an exact number, so a host that also runs another helper
 * never thrashes. share stops on a host only when it leaves the plan.
 * @param {NS} ns @param {Snapshot} snap @returns {string[]} hosts touched
 */
function manageShare(ns, snap) {
  const eligible = shareEligibleHosts(snap);
  const plan = farmingRep() ? planShare(eligible, shareBudgetRam(eligible)) : {};
  const touched = [];

  // Stop share on any host no longer in the plan. Kill by pid (via ns.ps/ns.kill,
  // already used here) rather than ns.scriptKill, so this adds no manager RAM.
  for (const host of snap.rooted) {
    if (plan[host]) continue;
    for (const p of ns.ps(host)) {
      if (p.filename === SHARE) { ns.kill(p.pid); touched.push(host); }
    }
  }

  // Start share on wanted hosts that aren't sharing yet.
  for (const [host, gb] of Object.entries(plan)) {
    const want = Math.floor(gb / _shareThreadRam);
    if (want <= 0 || shareThreadsOn(ns, host) > 0) continue;

    if (host !== HOME) ns.scp(SHARE, host, HOME);

    const capacity = () =>
      Math.floor((ns.getServerMaxRam(host) - ns.getServerUsedRam(host)) / _shareThreadRam);

    let threads = Math.min(want, capacity());
    if (threads <= 0) {
      // No free room - this host is dedicated to share now, so evict its botnet
      // scripts (rep is the priority) and take what the plan wants.
      for (const p of ns.ps(host)) {
        if ([HACK, GROW, WEAKEN].includes(p.filename)) ns.kill(p.pid);
      }
      threads = Math.min(want, capacity());
    }
    if (threads > 0) ns.exec(SHARE, host, threads);
    touched.push(host);
  }

  // Actual running totals (may be < plan if a host was partly occupied).
  const servers = Object.keys(plan).filter(h => shareThreadsOn(ns, h) > 0);
  const threads = servers.reduce((s, h) => s + shareThreadsOn(ns, h), 0);
  const bonus = 1 + Math.log(Math.max(1, threads)) / 25;

  // Log only on change so the per-tick loop doesn't spam.
  const key = servers.slice().sort().join(",");
  if (key !== _lastShareHosts) {
    _lastShareHosts = key;
    if (key) {
      ns.print(`[share] ${servers.length} server(s), ${threads} threads -> faction rep x${bonus.toFixed(3)} (+${((bonus - 1) * 100).toFixed(1)}%)`);
    } else {
      ns.print("[share] off (not farming faction rep)");
    }
  }

  globalThis.gordShareState = { active: servers.length > 0, servers, threads, bonus };
  return touched;
}

// ── Per-target math (Formulas when present, ns.* approximations otherwise) ───

/**
 * @typedef {{hackTime: number, growTime: number, weakenTime: number}} Times
 * @typedef {{times: Times, hackPct: number, hackChance: number, useFormulas: boolean,
 *            plan: (fraction: number) => any,
 *            growNeeded: (money: number, maxMoney: number, security: number) => number}} TargetMath
 */

/**
 * Everything batch-logic needs to know about one target, evaluated at the
 * PREPPED state a batch actually hits. Without Formulas.exe the current-state
 * ns.* approximations are used (hackAnalyze reads current security,
 * growthAnalyze ignores it) and hack chance is taken as 1.
 *
 * That fallback is noticeably worse on FAST targets - the small servers this
 * scheduler now also works. Their whole cycle is a couple of seconds, so the
 * "current" state is never the prepped one (a previous batch's hack has just
 * landed), the hack is planned ~0.5% smaller than the one that lands, and the
 * grow sized to match leaves the target a little short each cycle; money settles
 * a few percent under max rather than at it. It self-limits well inside the
 * prepped threshold, and SF-5 grants Formulas.exe - the exact path - at the start
 * of every node, so this is an edge-case cost, not the normal one.
 * @param {NS} ns @param {string} target @returns {TargetMath}
 */
function targetMath(ns, target) {
  const useFormulas = F.hasFormulas(ns);

  const times = useFormulas
    ? F.batchTimes(ns, target)
    : { hackTime: ns.getHackTime(target), growTime: ns.getGrowTime(target), weakenTime: ns.getWeakenTime(target) };
  const hackPct = useFormulas ? F.hackPercent(ns, target) : ns.hackAnalyze(target);
  const hackChance = useFormulas ? F.hackChance(ns, target) : 1;

  const growThreadsFor = useFormulas
    ? (remaining) => F.growThreadsToFull(ns, target, remaining)
    : (remaining) => Math.ceil(ns.growthAnalyze(target, 1 / Math.max(0.01, remaining)));

  const plan = (fraction) => B.planBatch({
    moneyFraction: fraction,
    hackPct,
    growThreadsFor,
    ramPerThread: RAM,
    securityPerHack: H.securityPerHack,
    securityPerGrow: H.securityPerGrow,
    weakenAmount: H.weakenAmount,
    maxHackFraction: H.maxHackFraction,
  });

  // Grow threads a PREP needs: from the current money, at the CURRENT security
  // (the prep's grow legs run before their accompanying weaken lands).
  const growNeeded = (money, maxMoney, security) => {
    if (maxMoney <= 0 || money >= maxMoney) return 0;
    if (useFormulas) return F.growThreadsToFull(ns, target, money / maxMoney, security);
    return Math.ceil(ns.growthAnalyze(target, maxMoney / Math.max(money, 1)));
  };

  return { times, hackPct, hackChance, useFormulas, plan, growNeeded };
}

/** @param {NS} ns @param {string} target */
function readTarget(ns, target) {
  return {
    money: ns.getServerMoneyAvailable(target),
    maxMoney: ns.getServerMaxMoney(target),
    security: ns.getServerSecurityLevel(target),
    minSecurity: ns.getServerMinSecurityLevel(target),
  };
}

function prepped(state) {
  return B.isPrepped({
    ...state,
    moneyThreshold: H.prepMoneyThreshold,
    securityTolerance: H.prepSecurityTolerance,
  });
}

// ── Target ranking ───────────────────────────────────────────────────────────

let _rank = { at: 0, ram: 0, list: /** @type {{target: string, score: number}[]} */ ([]) };

/**
 * The batch plan for one target given `ramBudget`: the leg schedule (fixed by
 * the target's leg times) and the cycle that fills the budget (depth from
 * timing, money fraction from RAM). cycle is null when not even the smallest
 * batch fits.
 * @param {TargetMath} math @param {number} ramBudget
 */
function cycleFor(math, ramBudget) {
  const schedule = B.legSchedule({ ...math.times, spacing: H.batchSpacingMs, margin: H.launchMarginMs });
  const cycle = B.planCycle({
    fractions: H.moneyFractions,
    totalRam: ramBudget,
    lastLanding: schedule.lastLanding,
    launchInterval: schedule.launchInterval,
    maxDepth: H.maxDepth,
    planFor: math.plan,
  });
  return { schedule, cycle };
}

/**
 * Hackable targets ranked by the INCOME each would yield with the whole botnet
 * behind it ($/ms, batch-logic incomeRate) - by what we would actually earn, not
 * by how efficiently the RAM is spent.
 *
 * This is the second correction to this ranking. money/minSec/hackTime ignored
 * what a batch costs; $ per GB-second (the version before this one) fixed that
 * but maximised RAM EFFICIENCY, and the most efficient target is not the richest
 * - it is usually the cheapest, which on a botnet with RAM to spare means
 * parking on n00dles and leaving the fleet idle. Income ranking prefers the
 * server that pays most with the RAM we have, and step() spills what that target
 * cannot absorb onto the next ones in this same list.
 *
 * Re-ranked every targetRescoreMs, and immediately when the botnet's usable RAM
 * moves by more than half (a purchased-server upgrade, an aug install wiping the
 * fleet), since the ranking is now a function of that RAM.
 * @param {NS} ns @param {Snapshot} snap @param {number} capacity @param {number} now
 */
function rankTargets(ns, snap, capacity, now) {
  const stale = now - _rank.at >= H.targetRescoreMs
    || Math.abs(capacity - _rank.ram) > _rank.ram * 0.5;
  if (_rank.list.length && !stale) return _rank.list;

  const list = [];
  for (const server of snap.rooted) {
    if (server.startsWith(H.excludeTargetPrefix)) continue;
    const maxMoney = ns.getServerMaxMoney(server);
    if (maxMoney <= 0) continue;
    if (ns.getServerRequiredHackingLevel(server) > snap.hacking) continue;

    const m = targetMath(ns, server);
    const { cycle } = cycleFor(m, capacity);
    if (!cycle) continue;                       // not even the smallest batch fits
    const score = B.incomeRate({
      maxMoney,
      hackChance: m.hackChance,
      plan: cycle.plan,
      launchInterval: cycle.launchInterval,
    });
    if (score > 0) list.push({ target: server, score });
  }
  list.sort((a, b) => b.score - a.score);
  _rank = { at: now, ram: capacity, list };
  return list;
}

// ── Launching ────────────────────────────────────────────────────────────────

/**
 * Exec every assignment; on any failure kill what was launched and report
 * false, so a batch is never left half-launched.
 * @param {NS} ns @param {any[]} assignments @param {string} target @param {string} tag
 */
function execAll(ns, assignments, target, tag) {
  const pids = [];
  for (const a of assignments) {
    const delay = Math.max(0, Math.floor(a.leg.delay ?? 0));
    // The trailing performance.now() keeps each exec's args unique, so several
    // legs of the same script can run on one host at once.
    const pid = ns.exec(a.script, a.host, a.threads, target, delay, tag, performance.now());
    if (pid === 0) {
      for (const p of pids) ns.kill(p);
      return false;
    }
    pids.push(pid);
  }
  return true;
}

/**
 * One prep pass: joint weaken + grow sized by prepPlan, using up to `ramCap` of
 * the snapshot's free RAM. Partial allocation is fine here (whatever lands
 * helps; the next pass finishes the job). Returns when its legs will have
 * landed, i.e. when the target should be re-read.
 * @param {NS} ns @param {Snapshot} snap @param {string} target
 * @param {TargetMath} math @param {number} ramCap @param {number} now
 */
function launchPrep(ns, snap, target, state, math, ramCap, now) {
  const threadRam = Math.max(RAM.grow, RAM.weaken);
  const totalThreads = Math.floor(Math.min(snap.totalUsable, ramCap) / threadRam);
  const excess = Math.max(0, state.security - state.minSecurity);
  const growNeeded = state.money >= state.maxMoney * H.prepMoneyThreshold
    ? 0
    : math.growNeeded(state.money, state.maxMoney, state.security);

  const plan = B.prepPlan({
    excessSecurity: excess,
    growNeeded,
    totalThreads,
    weakenAmount: H.weakenAmount,
    securityPerGrow: H.securityPerGrow,
  });
  if (plan.weaken + plan.grow <= 0) {
    return { launched: false, until: now + H.waitForRamMs, ...plan };
  }

  const alloc = B.allocate(snap.workers, [
    { script: WEAKEN, threads: plan.weaken, ram: RAM.weaken, delay: 0 },
    { script: GROW, threads: plan.grow, ram: RAM.grow, delay: 0 },
  ]);
  if (!alloc.assignments.length) return { launched: false, until: now + H.waitForRamMs, ...plan };

  execAll(ns, alloc.assignments, target, "prep");
  applyAllocation(snap, alloc);

  // Legs run at the CURRENT security, so wait on the current-state times.
  const wait = (plan.weaken > 0 ? ns.getWeakenTime(target) : ns.getGrowTime(target)) + H.prepSleepPadMs;
  return { launched: true, until: now + wait, ...plan };
}

/**
 * Launch one batch of `cycle.plan` against `target`, entirely or not at all.
 * Returns the in-flight record, or null if it didn't fit / launch.
 * @param {NS} ns @param {Snapshot} snap @param {string} target
 */
function launchBatch(ns, snap, target, cycle, schedule, id, now) {
  const plan = cycle.plan;
  const d = schedule.delays;
  const legs = [
    { script: HACK, threads: plan.hackThreads, ram: RAM.hack, delay: d.hack },
    { script: WEAKEN, threads: plan.weaken1Threads, ram: RAM.weaken, delay: d.weaken1 },
    { script: GROW, threads: plan.growThreads, ram: RAM.grow, delay: d.grow },
    { script: WEAKEN, threads: plan.weaken2Threads, ram: RAM.weaken, delay: d.weaken2 },
  ];
  const alloc = B.allocate(snap.workers, legs);
  if (!alloc.ok) return null;
  if (!execAll(ns, alloc.assignments, target, `batch-${id}`)) return null;
  applyAllocation(snap, alloc);

  return {
    target,
    id,
    ram: plan.ram,
    moneyFraction: plan.hackedFraction,
    securityAdded: plan.securityAdded,
    launchedAt: now,
    doneAt: now + schedule.lastLanding + H.landingPadMs,
  };
}

/** @param {NS} ns */
function killOldHackScripts(ns) {
  for (const server of allServers(ns)) {
    if (!ns.hasRootAccess(server)) continue;
    for (const p of ns.ps(server)) {
      if ([HACK, GROW, WEAKEN].includes(p.filename)) ns.kill(p.pid);
    }
  }
}

// ── Main loop ────────────────────────────────────────────────────────────────

/** Per-process scheduler state; `step` mutates it. One per manager. */
export function newSchedulerState() {
  return {
    inFlight: /** @type {any[]} */ ([]),  // batches whose legs haven't all landed (any target)
    prepUntil: new Map(),                  // target -> time its prep legs will have landed
    nextLaunchAt: new Map(),               // target -> earliest next launch (its own cadence)
    currentTarget: "",                     // the primary, for logging a switch
    batchId: 0,
    lastMode: "",
    lastLogAt: 0,
    lastIdleWarnAt: -Infinity,   // throttle on the "nothing scored" warning
  };
}

/**
 * Forget the throttled caches (network walk, rooting, ranking, copies). Used by
 * the crash guard in main() when a tick fails on surprise game state, and by the
 * simulation tests between runs.
 */
export function resetCaches() {
  _netAt = 0;
  _netServers = [];
  _rootAt = 0;
  _copied.clear();
  _rank = { at: 0, list: [] };
  _lastShareHosts = "";
}

/**
 * Per-thread RAM of the worker scripts, read from HOME explicitly: this script
 * usually runs off-home, on a host that may not hold the worker files yet
 * (they're copied in buildSnapshot).
 * @param {NS} ns
 */
function readWorkerRam(ns) {
  RAM.hack = ns.getScriptRam(HACK, HOME) || RAM.hack;
  RAM.grow = ns.getScriptRam(GROW, HOME) || RAM.grow;
  RAM.weaken = ns.getScriptRam(WEAKEN, HOME) || RAM.weaken;
  _shareThreadRam = ns.getScriptRam(SHARE, HOME) || _shareThreadRam;
}

/**
 * One tick's work against ONE target, given the RAM budget it may claim in
 * steady state: prep it, drain it, or launch its next batch. Every target the
 * manager works runs this same body with its own budget and its own launch
 * clock, so a secondary target is not a lesser mode - it is the same scheduler.
 *
 * `claim` is the RAM this target will hold once its cycle is at full depth - what
 * the caller subtracts before budgeting the next one. It is claimed even while
 * the target is still PREPPING, since it will need that RAM as soon as the prep
 * lands, so a target lower down can't take it out from under one warming up. A
 * target that couldn't plan a cycle at all claims 0 here; step() decides what
 * that means (the primary keeps the lot for its prep, a secondary steps aside).
 *
 * @param {NS} ns @param {ReturnType<typeof newSchedulerState>} s
 * @param {Snapshot} snap @param {string} target
 * @param {number} budgetRam @param {number} now
 */
function serviceTarget(ns, s, snap, target, budgetRam, now) {
  const math = targetMath(ns, target);
  const state = readTarget(ns, target);
  const open = s.inFlight.filter(b => b.target === target);
  const { schedule, cycle } = cycleFor(math, budgetRam);

  let mode;
  if ((s.prepUntil.get(target) ?? 0) > now) {
    mode = "Prepping";
  } else if (open.length === 0 && !prepped(state)) {
    const res = launchPrep(ns, snap, target, state, math, budgetRam, now);
    s.prepUntil.set(target, res.until);
    mode = res.launched ? "Prepping" : "Waiting for RAM (prep)";
    if (res.launched) {
      ns.print(`[prep] ${target}: weaken x${res.weaken}, grow x${res.grow}${res.complete ? "" : " (partial)"} | ` +
        `sec ${state.security.toFixed(2)}/${state.minSecurity} money ${((state.money / state.maxMoney) * 100).toFixed(0)}%`);
    }
  } else if (open.length > 0 && B.driftDetected({
    ...state,
    openMoneyFraction: Math.max(...open.map(b => b.moneyFraction)),
    openSecurity: Math.max(...open.map(b => b.securityAdded)),
    moneyTolerance: H.driftMoneyTolerance,
    securityTolerance: H.driftSecurityTolerance,
  })) {
    // Stop launching against this target; its window drains within a weaken-time
    // and the branch above re-preps it once nothing of ours is in flight.
    mode = "Draining (drift)";
  } else if (!cycle) {
    mode = "Waiting for RAM";
  } else if (now >= (s.nextLaunchAt.get(target) ?? 0) && open.length < cycle.depth) {
    const batch = launchBatch(ns, snap, target, cycle, schedule, s.batchId, now);
    if (batch) {
      s.batchId++;
      s.inFlight.push(batch);
      s.nextLaunchAt.set(target, now + cycle.launchInterval);
      mode = "Batching";
    } else {
      // Free RAM is there in total but not in the right places (or an exec
      // failed); try again next tick rather than waiting out a whole interval.
      mode = "Waiting for RAM (fragmented)";
    }
  } else {
    mode = open.length > 0 ? "Batching" : "Idle";
  }

  return {
    target, mode, cycle, math, state, open,
    claim: cycle ? cycle.depth * cycle.plan.ram : 0,
  };
}

/**
 * One tick of the manager. Exported so the whole loop can be driven against a
 * fake `ns` under Node (tests/batcher-sim.test.mjs) - the one place the
 * scheduling logic is exercised end to end without the game.
 * @param {NS} ns @param {ReturnType<typeof newSchedulerState>} s @param {number} now
 * @returns {string} the mode this tick ended in (the primary target's)
 */
export function step(ns, s, now) {
  const snap = buildSnapshot(ns, now);

  // Share is an optional side mode and must NEVER be able to stop the core
  // hacking loop (e.g. a stale config on a runner). On error, log and keep going.
  try {
    refreshWorkers(ns, snap, manageShare(ns, snap));
  } catch (e) {
    ns.print(`[share] disabled this tick (error): ${String(e)}`);
  }

  s.inFlight = B.pruneInFlight(s.inFlight, now);

  // What the botnet can plan with right now: RAM free this tick plus what our own
  // in-flight batches are holding (they release it as they land). Ranking uses
  // snap.capacity instead - see buildSnapshot.
  const budgetRam = snap.totalUsable + s.inFlight.reduce((sum, b) => sum + b.ram, 0);

  const ranked = rankTargets(ns, snap, snap.capacity, now);
  if (!ranked.length) {
    // No rooted server scored anything: nothing can carry even the smallest
    // batch (a fresh node, or the fleet just vanished with an aug install), or
    // every score came back zero.
    //
    // SAY SO, in the journal, not just in a tail nobody has open. The last time
    // this state happened it was a zero multiplying every score
    // (lib/formulas.js was asking about an unrooted mock server, so hackChance
    // was always 0) and it went unnoticed for a whole run, because the old code
    // quietly fell back to a hardcoded n00dles and looked like it was working.
    if (now - s.lastIdleWarnAt >= H.idleWarnMs) {
      s.lastIdleWarnAt = now;
      const msg = `botnet idle: none of ${snap.rooted.length} rooted servers scored above zero ` +
        `(${ns.format.ram(snap.capacity)} of botnet, hacking level ${snap.hacking}) - run /tools/hack-status.js`;
      ns.print(`WARN: ${msg}`);
      emitEvent(`[!] ${msg}`, "sys");
    }
    globalThis.gordHackState = {
      mode: "Idle", target: "-", score: 0, formulas: F.hasFormulas(ns), batchId: s.batchId,
      inFlight: 0, depth: 0, fraction: 0, batchRam: 0, launchIntervalMs: 0, weakenTimeMs: 0,
      moneyPercent: 0, security: 0, minSecurity: 0, prepUntil: 0, targets: [],
      claimedRam: 0, capacityRam: snap.capacity, freeRam: snap.totalUsable, updatedAt: now,
    };
    return "Idle";
  }

  const primary = ranked[0].target;
  if (primary !== s.currentTarget) {
    if (s.currentTarget) ns.print(`[target] ${s.currentTarget} -> ${primary}`);
    s.currentTarget = primary;
    // In-flight batches on the old primary drain harmlessly; it may well still be
    // serviced below, just no longer first.
    s.nextLaunchAt.delete(primary);
  }

  // Service targets in rank order, each budgeted with the RAM the ones above it
  // don't claim. The best target takes the fattest bite it can (its own income is
  // what the ranking maximises) and only what it CANNOT absorb spills down - so
  // this never trades primary income for secondary income, it only stops the
  // remainder from idling.
  const serviced = [];
  let claimed = 0;
  for (const { target } of ranked) {
    if (serviced.length >= H.maxTargets) break;
    const budget = budgetRam - claimed;
    // The primary always gets serviced, however little RAM there is; opening a
    // further target is only worth it above minTargetRam.
    if (serviced.length > 0 && budget < H.minTargetRam) break;
    const res = serviceTarget(ns, s, snap, target, budget, now);
    serviced.push(res);
    if (res.cycle) {
      claimed += res.claim;
    } else if (serviced.length === 1) {
      // The primary couldn't plan a cycle: it's mid-prep, or the botnet is too
      // small for even its smallest batch. Either way its prep needs the RAM, so
      // claim the lot and spill nothing - letting the targets below it take that
      // RAM is how a primary prep ends up starved (the old runner-up rule was
      // "only spill once the primary has a cycle").
      claimed += budget;
    }
    // A SECONDARY with no cycle just doesn't fit its budget; it claims nothing so
    // a cheaper target further down can still use what's left.
  }

  const head = serviced[0];
  const mode = head.mode;

  if (mode !== s.lastMode || now - s.lastLogAt >= 30_000) {
    s.lastMode = mode;
    s.lastLogAt = now;
    const cycle = head.cycle;
    const state = head.state;
    ns.print(
      `[${mode}] ${head.target} | in flight ${head.open.length}/${cycle?.depth ?? 0} | ` +
      `bite ${cycle ? (cycle.plan.hackedFraction * 100).toFixed(2) : "-"}% = ${cycle ? ns.format.ram(cycle.plan.ram) : "-"} ` +
      `every ${cycle ? (cycle.launchInterval / 1000).toFixed(1) : "-"}s | ` +
      `free ${ns.format.ram(snap.totalUsable)} | money ${((state.money / Math.max(1, state.maxMoney)) * 100).toFixed(0)}% sec +${(state.security - state.minSecurity).toFixed(2)}`
    );
    if (serviced.length > 1) {
      ns.print(`[spill] ${serviced.slice(1).map(r => `${r.target} (${r.mode}, ${r.open.length}/${r.cycle?.depth ?? 0})`).join(", ")} | ` +
        `claimed ${ns.format.ram(claimed)} of ${ns.format.ram(budgetRam)}`);
    }
  }

  globalThis.gordHackState = {
    mode,
    target: head.target,
    score: ranked[0]?.score ?? 0,          // $/ms the primary is expected to earn
    formulas: head.math.useFormulas,
    batchId: s.batchId,
    inFlight: head.open.length,
    depth: head.cycle?.depth ?? 0,
    fraction: head.cycle?.plan.hackedFraction ?? 0,
    batchRam: head.cycle?.plan.ram ?? 0,
    launchIntervalMs: head.cycle?.launchInterval ?? 0,
    weakenTimeMs: head.math.times.weakenTime,
    moneyPercent: head.state.maxMoney > 0 ? head.state.money / head.state.maxMoney : 0,
    security: head.state.security,
    minSecurity: head.state.minSecurity,
    prepUntil: s.prepUntil.get(head.target) ?? 0,
    // Every target being worked this tick, primary first (the dashboard lists
    // them), plus how much of the botnet they add up to.
    targets: serviced.map(r => ({
      target: r.target,
      mode: r.mode,
      inFlight: r.open.length,
      depth: r.cycle?.depth ?? 0,
      fraction: r.cycle?.plan.hackedFraction ?? 0,
      ram: r.claim,
    })),
    claimedRam: claimed,
    capacityRam: snap.capacity,
    freeRam: snap.totalUsable,
    updatedAt: now,
  };

  return mode;
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  readWorkerRam(ns);
  if (ns.args.includes("--reset")) killOldHackScripts(ns);

  const s = newSchedulerState();
  while (true) {
    try {
      step(ns, s, Date.now());
    } catch (e) {
      // Belt-and-braces for game state changing between ticks (the deleted-fleet
      // case above is handled in buildSnapshot, but anything of that shape lands
      // here): drop the caches so the next tick rebuilds from a fresh scan, and
      // keep running instead of dying with an error modal.
      resetCaches();
      ns.print(`manager tick error (caches reset, retrying): ${String(e)}`);
    }
    await ns.sleep(H.batchSpacingMs);
  }
}
