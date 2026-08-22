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
//   3. RANK     - targets scored in $ per GB-second (targetScore), re-ranked
//      every targetRescoreMs rather than every tick.
//   4. PREP     - when no batches are in flight against the target and it isn't
//      at min security / max money, launch one joint weaken+grow pass sized so
//      the weaken also covers the grow's own security (prepPlan), then WAIT
//      WITHOUT BLOCKING: the loop keeps ticking (share, runner-up prep) and
//      simply doesn't launch batches until the prep legs have landed.
//   5. BATCH    - a CONTINUOUS scheduler. Leg delays come from legSchedule so
//      the four legs land H, W1, G, W2; launches are spaced by the landing span
//      plus a margin, which guarantees batch N+1's first landing follows batch
//      N's last. That ordering is the whole correctness condition: each batch
//      restores the prepped state before the next one's hack lands. Timing
//      then fixes how many batches are in flight (batchDepth), and the money
//      fraction per batch is the largest that lets that many batches share the
//      botnet's RAM (planCycle). A batch is allocated across hosts as a whole
//      (allocate) and launched entirely or not at all.
//   6. DRIFT    - while batches fly, the target is checked against the worst
//      case one OPEN batch can explain (driftDetected). Real drift stops
//      launching, the window drains in ~one weaken-time, and step 4 re-preps.
//   7. RUNNER-UP - spare RAM beyond what the primary's cycle needs preps the
//      second-best target, so a target switch doesn't start with a cold prep.
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
 *            workers: Worker[], totalUsable: number, hacking: number}} Snapshot
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
  }
  return { now, servers: _netServers, rooted, reserved, workers, totalUsable, hacking: ns.getHackingLevel() };
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

let _rank = { at: 0, list: /** @type {{target: string, score: number}[]} */ ([]) };

/**
 * Hackable targets ranked by $ per GB-second (batch-logic targetScore), which is
 * what a RAM-bound botnet actually maximises - the old money/minSec/hackTime
 * heuristic ignored what a batch COSTS, so a money-rich, grow-expensive server
 * could outrank a better one. Re-ranked every targetRescoreMs; scores only move
 * with hacking level.
 * @param {NS} ns @param {Snapshot} snap @param {number} now
 */
function rankTargets(ns, snap, now) {
  if (_rank.list.length && now - _rank.at < H.targetRescoreMs) return _rank.list;

  const list = [];
  for (const server of snap.rooted) {
    if (server.startsWith(H.excludeTargetPrefix)) continue;
    const maxMoney = ns.getServerMaxMoney(server);
    if (maxMoney <= 0) continue;
    if (ns.getServerRequiredHackingLevel(server) > snap.hacking) continue;

    const m = targetMath(ns, server);
    const score = B.targetScore({
      maxMoney,
      hackChance: m.hackChance,
      plan: m.plan(H.scoreFraction),
      weakenTime: m.times.weakenTime,
    });
    if (score > 0) list.push({ target: server, score });
  }
  list.sort((a, b) => b.score - a.score);
  _rank = { at: now, list };
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

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  // Read from HOME explicitly: this script usually runs off-home, on a host
  // that may not hold the worker files yet (they're copied in buildSnapshot).
  RAM.hack = ns.getScriptRam(HACK, HOME) || RAM.hack;
  RAM.grow = ns.getScriptRam(GROW, HOME) || RAM.grow;
  RAM.weaken = ns.getScriptRam(WEAKEN, HOME) || RAM.weaken;
  _shareThreadRam = ns.getScriptRam(SHARE, HOME) || _shareThreadRam;

  if (ns.args.includes("--reset")) killOldHackScripts(ns);

  /** Batches whose legs haven't all landed yet (any target). */
  let inFlight = /** @type {any[]} */ ([]);
  /** target -> time its prep legs will have landed. */
  const prepUntil = new Map();
  let nextLaunchAt = 0;
  let currentTarget = "";
  let batchId = 0;
  let lastMode = "";
  let lastLogAt = 0;

  while (true) {
    const now = Date.now();
    const snap = buildSnapshot(ns, now);

    // Share is an optional side mode and must NEVER be able to stop the core
    // hacking loop (e.g. a stale config on a runner). On error, log and keep going.
    try {
      refreshWorkers(ns, snap, manageShare(ns, snap));
    } catch (e) {
      ns.print(`[share] disabled this tick (error): ${String(e)}`);
    }

    inFlight = B.pruneInFlight(inFlight, now);

    const ranked = rankTargets(ns, snap, now);
    const target = ranked[0]?.target ?? H.defaultTarget;
    if (target !== currentTarget) {
      if (currentTarget) ns.print(`[target] ${currentTarget} -> ${target}`);
      currentTarget = target;
      nextLaunchAt = 0; // in-flight batches on the old target drain harmlessly
    }

    const math = targetMath(ns, target);
    const state = readTarget(ns, target);
    const open = inFlight.filter(b => b.target === target);
    const openRam = open.reduce((s, b) => s + b.ram, 0);
    const schedule = B.legSchedule({ ...math.times, spacing: H.batchSpacingMs, margin: H.launchMarginMs });
    // RAM the botnet can devote to this target: free now plus what our own
    // in-flight batches are holding.
    const cycle = B.planCycle({
      fractions: H.moneyFractions,
      totalRam: snap.totalUsable + openRam,
      lastLanding: schedule.lastLanding,
      launchInterval: schedule.launchInterval,
      maxDepth: H.maxDepth,
      planFor: math.plan,
    });

    let mode;
    if ((prepUntil.get(target) ?? 0) > now) {
      mode = "Prepping";
    } else if (open.length === 0 && !prepped(state)) {
      const res = launchPrep(ns, snap, target, state, math, Infinity, now);
      prepUntil.set(target, res.until);
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
      // Stop launching; the window drains within a weaken-time and the branch
      // above re-preps once nothing is in flight.
      mode = "Draining (drift)";
    } else if (!cycle) {
      mode = "Waiting for RAM";
    } else if (now >= nextLaunchAt && open.length < cycle.depth) {
      const batch = launchBatch(ns, snap, target, cycle, schedule, batchId, now);
      if (batch) {
        batchId++;
        inFlight.push(batch);
        nextLaunchAt = now + cycle.launchInterval;
        mode = "Batching";
      } else {
        // Free RAM is there in total but not in the right places (or an exec
        // failed); try again next tick rather than waiting out a whole interval.
        mode = "Waiting for RAM (fragmented)";
      }
    } else {
      mode = open.length > 0 ? "Batching" : "Idle";
    }

    // Runner-up prep with RAM the primary's cycle doesn't need, so a target
    // switch starts batching immediately instead of with a cold prep.
    let runnerUp = null;
    if (H.prepRunnerUp && cycle) {
      runnerUp = ranked.find(r => r.target !== target)?.target ?? null;
      if (runnerUp && (prepUntil.get(runnerUp) ?? 0) <= now) {
        const primaryStillNeeds = Math.max(0, cycle.depth * cycle.plan.ram - openRam);
        const spare = snap.totalUsable - primaryStillNeeds;
        if (spare >= H.runnerUpMinRam) {
          const st2 = readTarget(ns, runnerUp);
          if (!prepped(st2)) {
            const res = launchPrep(ns, snap, runnerUp, st2, targetMath(ns, runnerUp), spare, now);
            prepUntil.set(runnerUp, res.until);
          }
        }
      }
    }

    if (mode !== lastMode || now - lastLogAt >= 30_000) {
      lastMode = mode;
      lastLogAt = now;
      ns.print(
        `[${mode}] ${target} | in flight ${open.length}/${cycle?.depth ?? 0} | ` +
        `bite ${cycle ? (cycle.plan.hackedFraction * 100).toFixed(2) : "-"}% = ${cycle ? ns.format.ram(cycle.plan.ram) : "-"} ` +
        `every ${cycle ? (cycle.launchInterval / 1000).toFixed(1) : "-"}s | ` +
        `free ${ns.format.ram(snap.totalUsable)} | money ${((state.money / Math.max(1, state.maxMoney)) * 100).toFixed(0)}% sec +${(state.security - state.minSecurity).toFixed(2)}`
      );
    }

    globalThis.gordHackState = {
      mode,
      target,
      score: ranked[0]?.score ?? 0,
      formulas: math.useFormulas,
      batchId,
      inFlight: open.length,
      depth: cycle?.depth ?? 0,
      fraction: cycle?.plan.hackedFraction ?? 0,
      batchRam: cycle?.plan.ram ?? 0,
      launchIntervalMs: cycle?.launchInterval ?? 0,
      weakenTimeMs: math.times.weakenTime,
      moneyPercent: state.maxMoney > 0 ? state.money / state.maxMoney : 0,
      security: state.security,
      minSecurity: state.minSecurity,
      prepUntil: prepUntil.get(target) ?? 0,
      runnerUp,
      freeRam: snap.totalUsable,
      updatedAt: now,
    };

    await ns.sleep(H.batchSpacingMs);
  }
}
