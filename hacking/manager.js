// hacking/manager.js
//
// The HGW batching botnet - the daemon's core money engine, run OFF-home (exec'd
// by each bnX/daemon.js via ensureHelper) so its ~12GB never competes with the
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
//      (batchDepth), and the bite per batch is the fattest that lets that many
//      batches share the target's RAM budget, sized to the hack thread
//      (planCycle / largestBatch). A batch is
//      allocated across hosts as a whole (allocate) and launched entirely or not
//      at all, so targets never end up sharing a half-launched batch.
//   7. DRIFT    - while batches fly, each target is checked against the worst
//      case one OPEN batch of its own can explain (driftDetected). Drift LATCHES
//      (stillDraining): nothing more is launched against the target until every
//      batch in flight has landed (~one weaken-time), then step 5 re-preps it;
//      the other targets carry on.
//
// The old loop launched "the largest batch that fits" every 200ms; those batches
// interleaved (each hack after the first hit an already-hacked server) and the
// first landing hack tripped a re-prep that blocked launching for a grow-time.
//
// Formulas.exe (lib/formulas.js) gives exact steal-%, grow threads, success
// chance and leg timings at the prepped state; without it the ns.* analysis
// readings are scaled from the current security to the prepped one
// (preppedScale) and hack chance is taken as 1 for ranking. Publishes
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

// Security one weaken thread removes (1-core host). ASKED of the game rather
// than taken as the 0.05 constant, because a BitNode multiplier scales it
// (ServerWeakenRate): x2 in BN11, where the constant would waste half of every
// weaken leg, and x1/1.02^level in BN12, where it would leave every batch
// under-weakened and the target climbing. ns.weakenAnalyze is 1GB; the manager
// is not told which node it is in, and learning that (ns.getResetInfo) costs the
// same 1GB while still not giving BN12's level-dependent rate. Read once.
let _weakenAmount = 0;

/** @param {NS} ns */
function weakenAmount(ns) {
  if (!(_weakenAmount > 0)) {
    let perThread = 0;
    try { perThread = ns.weakenAnalyze(1); } catch { /* fall back to the constant */ }
    _weakenAmount = perThread > 0 ? perThread : H.weakenAmount;
  }
  return _weakenAmount;
}

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
// host's usedRam), so the snapshot's free RAM already excludes it. The part of
// the plan that ISN'T running yet - a busy host fills up as its legs land - is
// held back from the botnet's view of that host (applyShareHolds), so new legs
// stop landing there and the share can grow into it.
// See CONFIG.share for the full rationale and the diminishing-returns math.

// Last-published share hosts + thread count, so we only log on change (see manageShare).
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
 * chase the flat tail of the 1 + ln(1 + threads)/25 curve. Returns 0 below the floor.
 * @param {Worker[]} hosts
 */
function shareBudgetRam(hosts) {
  const totalRam = hosts.reduce((sum, h) => sum + h.max, 0);
  if (totalRam <= 0) return 0;

  // The thread count at targetBonus - past it extra share isn't worth the
  // money-RAM - converted to RAM.
  const targetThreads = B.shareThreadsFor(SH.targetBonus);
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
 * allocation each tick, and returns the hosts it touched (so the caller can
 * refresh their free RAM in the snapshot) plus, per host, the RAM the plan
 * still wants there and couldn't take yet.
 *
 * Share only ever takes FREE RAM. It used to evict the botnet's legs from a
 * full host, which killed one or two legs out of every batch in flight there -
 * on every target - and left each of those batches' hack or grow to land
 * without its weaken. Now a planned host is topped up as its legs land
 * (batch-logic shareTopUp decides when a chunk is worth a process), and the
 * shortfall is held out of the botnet's free RAM meanwhile so nothing new lands
 * in its way. share stops on a host only when it leaves the plan.
 * @param {NS} ns @param {Snapshot} snap
 * @returns {{touched: string[], holds: Map<string, number>}}
 */
function manageShare(ns, snap) {
  const eligible = shareEligibleHosts(snap);
  const plan = farmingRep() ? planShare(eligible, shareBudgetRam(eligible)) : {};
  const touched = [];
  const holds = new Map();

  // Stop share on any host no longer in the plan. Kill by pid (via ns.ps/ns.kill,
  // already used here) rather than ns.scriptKill, so this adds no manager RAM.
  for (const host of snap.rooted) {
    if (plan[host]) continue;
    for (const p of ns.ps(host)) {
      if (p.filename === SHARE) { ns.kill(p.pid); touched.push(host); }
    }
  }

  // Start, or top up, share on the planned hosts - out of free RAM only.
  for (const [host, gb] of Object.entries(plan)) {
    const want = Math.floor(gb / _shareThreadRam);
    const have = shareThreadsOn(ns, host);
    if (want <= have) continue;

    // The snapshot's free RAM, not max - used: it already leaves out whatever the
    // daemon reserved on this host (gordReservedRam).
    const free = snap.workers.find(w => w.host === host)?.free ?? 0;
    const start = B.shareTopUp({
      want, have,
      freeThreads: Math.floor(free / _shareThreadRam),
      maxProcesses: SH.maxProcessesPerHost,
    });
    let started = 0;
    if (start > 0) {
      if (host !== HOME) ns.scp(SHARE, host, HOME);
      // The trailing arg only makes each top-up's args unique (see execAll).
      if (ns.exec(SHARE, host, start, performance.now()) !== 0) {
        started = start;
        touched.push(host);
      }
    }
    const missing = want - have - started;
    if (missing > 0) holds.set(host, missing * _shareThreadRam);
  }

  // Actual running totals (below the plan while a busy host is still filling).
  const servers = Object.keys(plan).filter(h => shareThreadsOn(ns, h) > 0);
  const threads = servers.reduce((s, h) => s + shareThreadsOn(ns, h), 0);
  const bonus = B.shareBonus(threads);

  // Log only on change (a host set, or a top-up) so the per-tick loop doesn't spam.
  const planned = Object.keys(plan).length;
  const key = servers.length ? `${servers.slice().sort().join(",")}:${threads}` : (planned ? "waiting" : "");
  if (key !== _lastShareHosts) {
    _lastShareHosts = key;
    if (servers.length) {
      ns.print(`[share] ${servers.length} server(s), ${threads} threads -> faction rep x${bonus.toFixed(3)} (+${((bonus - 1) * 100).toFixed(1)}%)`);
    } else if (planned) {
      ns.print(`[share] ${planned} server(s) planned - waiting for botnet legs to land and free the RAM`);
    } else {
      ns.print("[share] off (not farming faction rep)");
    }
  }

  globalThis.gordShareState = { active: servers.length > 0, servers, threads, bonus };
  return { touched, holds };
}

/**
 * Take the share plan's not-yet-running RAM out of what the botnet may use on
 * those hosts this tick (see manageShare).
 * @param {Snapshot} snap @param {Map<string, number>} holds
 */
function applyShareHolds(snap, holds) {
  for (const w of snap.workers) {
    const hold = holds.get(w.host);
    if (hold > 0) w.free = Math.max(0, w.free - hold);
  }
  snap.totalUsable = snap.workers.reduce((s, w) => s + w.free, 0);
}

// ── Per-target math (Formulas when present, ns.* approximations otherwise) ───

/**
 * @typedef {{hackTime: number, growTime: number, weakenTime: number}} Times
 * @typedef {{times: Times, hackPct: number, hackChance: number, useFormulas: boolean,
 *            maxThreads: number, plan: (hackThreads: number) => any,
 *            growNeeded: (money: number, maxMoney: number, security: number) => number}} TargetMath
 */

/**
 * Everything batch-logic needs to know about one target, evaluated at the
 * PREPPED state a batch actually hits.
 *
 * Without Formulas.exe the ns.* analysis functions are all there is, and every
 * one of them describes the target at its CURRENT security (growthAnalyze too -
 * the game's numCycleForGrowth reads the live server). With batches in flight
 * that is rarely the prepped state: a hack or a grow has just landed. So the
 * readings are scaled to min security with the game's own formulas
 * (batch-logic preppedScale), from calls this function already makes. What the
 * fallback still lacks is the hack's success chance (taken as 1 for ranking)
 * and the exact grow thread count: growthAnalyze ignores the $1-per-thread the
 * game adds before multiplying, so it asks for a thread or so too many - the
 * safe direction.
 * @param {NS} ns @param {string} target @returns {TargetMath}
 */
function targetMath(ns, target) {
  const useFormulas = F.hasFormulas(ns);

  let times, hackPct, growThreadsFor;
  if (useFormulas) {
    times = F.batchTimes(ns, target);
    hackPct = F.hackPercent(ns, target);
    growThreadsFor = (remaining) => F.growThreadsToFull(ns, target, remaining);
  } else {
    const k = B.preppedScale({
      security: ns.getServerSecurityLevel(target),
      minSecurity: ns.getServerMinSecurityLevel(target),
      requiredLevel: ns.getServerRequiredHackingLevel(target),
    });
    times = {
      hackTime: ns.getHackTime(target) * k.time,
      growTime: ns.getGrowTime(target) * k.time,
      weakenTime: ns.getWeakenTime(target) * k.time,
    };
    hackPct = ns.hackAnalyze(target) * k.hackPct;
    growThreadsFor = (remaining) => Math.ceil(ns.growthAnalyze(target, 1 / Math.max(0.01, remaining)) * k.growThreads);
  }
  const hackChance = useFormulas ? F.hackChance(ns, target) : 1;

  const plan = (hackThreads) => B.planBatch({
    hackThreads,
    hackPct,
    growThreadsFor,
    ramPerThread: RAM,
    securityPerHack: H.securityPerHack,
    securityPerGrow: H.securityPerGrow,
    weakenAmount: weakenAmount(ns),
    maxHackFraction: H.maxHackFraction,
    growPadding: H.growPadding,
  });

  // Grow threads a PREP needs: from the current money, at the CURRENT security
  // (the prep's grow legs land before their accompanying weaken does) - which is
  // exactly what growthAnalyze reads, so the fallback needs no scaling here.
  const growNeeded = (money, maxMoney, security) => {
    if (maxMoney <= 0 || money >= maxMoney) return 0;
    if (useFormulas) return F.growThreadsToFull(ns, target, money / maxMoney, security);
    return Math.ceil(ns.growthAnalyze(target, maxMoney / Math.max(money, 1)));
  };

  const maxThreads = B.maxHackThreads(hackPct, H.maxHackFraction);
  return { times, hackPct, hackChance, useFormulas, maxThreads, plan, growNeeded };
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

/**
 * Roughly how long until `target` could carry its first batch: 0 when it is
 * prepped, otherwise one weaken-time (at its current security) per prep pass,
 * the passes being how many times the whole botnet has to be thrown at it. An
 * estimate for ranking only - later passes are faster than the first, and the
 * prep rarely gets the whole botnet.
 * @param {NS} ns @param {string} target @param {TargetMath} math @param {number} capacity
 */
function prepEstimateMs(ns, target, math, capacity) {
  const state = readTarget(ns, target);
  if (prepped(state)) return 0;
  const grow = math.growNeeded(state.money, state.maxMoney, state.security);
  const excess = Math.max(0, state.security - state.minSecurity);
  const weaken = Math.ceil((excess + grow * H.securityPerGrow) / weakenAmount(ns));
  const threads = Math.floor(capacity / Math.max(RAM.grow, RAM.weaken));
  const passes = Math.max(1, Math.ceil((grow + weaken) / Math.max(1, threads)));
  return passes * ns.getWeakenTime(target);
}

let _rank = { at: 0, ram: 0, list: /** @type {{target: string, score: number, ram: number}[]} */ ([]) };

/**
 * The batch plan for one target given `ramBudget`: the leg schedule (fixed by
 * the target's leg times) and the cycle that fills the budget (depth from
 * timing, hack threads from RAM). cycle is null when not even a one-thread
 * batch fits.
 * @param {TargetMath} math @param {number} ramBudget
 */
function cycleFor(math, ramBudget) {
  const schedule = B.legSchedule({ ...math.times, spacing: H.batchSpacingMs, margin: H.launchMarginMs });
  const cycle = B.planCycle({
    totalRam: ramBudget,
    lastLanding: schedule.lastLanding,
    launchInterval: schedule.launchInterval,
    maxDepth: H.maxDepth,
    maxThreads: math.maxThreads,
    planFor: math.plan,
  });
  return { schedule, cycle };
}

/**
 * The targets worth working and how much of the botnet each should hold: the
 * fleet's RAM split so that the last gigabyte earns the same on every target
 * (batch-logic allocateRam, over each target's income curve). Best earner first.
 *
 * This is the third version of this ranking. money/minSec/hackTime ignored what
 * a batch costs. $ per GB-second fixed that but parked a big botnet on the most
 * RAM-efficient server with most of the fleet idle. Income-with-the-whole-fleet
 * fixed THAT, but handed the winner the fattest bite it could take and spilled
 * only the remainder - and a fat bite is the expensive end of a target's curve
 * (the grow that repairs 50% costs far more than five grows that repair 10%),
 * so most of a large fleet went on the worst gigabytes of one server while the
 * next-best target got scraps. The allocation spends each gigabyte where it
 * earns most, which reduces to "the most efficient target" on a tiny botnet and
 * to "everything, as fat as it goes" on a huge one.
 *
 * Targets we are already working get an edge (targetStickiness), and one that
 * would have to be prepped first is marked down by how long that takes
 * (prepEstimateMs / prepDiscount): a re-rank must not swap a prepped target for
 * an unprepped one that is a hair better, and a small fleet fresh from an
 * install must not spend its first hour growing the richest server in reach.
 *
 * Re-ranked every targetRescoreMs, and immediately when the botnet's usable RAM
 * moves by more than half (a purchased-server upgrade, an aug install wiping the
 * fleet), since the split is a function of that RAM.
 * @param {NS} ns @param {Snapshot} snap @param {number} capacity @param {number} now
 * @param {Set<string>} incumbents targets with batches in flight or a prep under way
 */
function rankTargets(ns, snap, capacity, now, incumbents) {
  const stale = now - _rank.at >= H.targetRescoreMs
    || Math.abs(capacity - _rank.ram) > _rank.ram * 0.5;
  if (_rank.list.length && !stale) return _rank.list;

  const curves = [];
  /** @type {Map<string, number>} what each target's income per GB is multiplied by */
  const weight = new Map();
  for (const server of snap.rooted) {
    if (server.startsWith(H.excludeTargetPrefix)) continue;
    const maxMoney = ns.getServerMaxMoney(server);
    if (maxMoney <= 0) continue;
    if (ns.getServerRequiredHackingLevel(server) > snap.hacking) continue;

    const m = targetMath(ns, server);
    const schedule = B.legSchedule({ ...m.times, spacing: H.batchSpacingMs, margin: H.launchMarginMs });
    const points = B.incomeCurve({
      maxMoney,
      hackChance: m.hackChance,
      lastLanding: schedule.lastLanding,
      launchInterval: schedule.launchInterval,
      maxDepth: H.maxDepth,
      maxThreads: m.maxThreads,
      planFor: m.plan,
    });
    if (!points.length) continue;
    // The smallest thing this target can run at all: a single one-thread batch.
    curves.push({ key: server, points, minRam: m.plan(1)?.ram ?? Infinity });
    weight.set(server, incumbents.has(server)
      ? 1 + H.targetStickiness
      : B.prepDiscount(prepEstimateMs(ns, server, m, capacity), H.prepHorizonMs));
  }

  const list = B.allocateRam({
    totalRam: capacity,
    curves,
    maxTargets: H.maxTargets,
    minTargetRam: H.minTargetRam,
    bonus: key => weight.get(key) ?? 1,
  }).map(a => ({ target: a.key, score: a.income, ram: a.ram }));
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
  // All the way to max money, even from inside the "prepped" money threshold: a
  // prep is running anyway (for security, say), and a batch's grow only repairs
  // its own hack, so a target that starts batching at 96% STAYS at 96%.
  const growNeeded = math.growNeeded(state.money, state.maxMoney, state.security);

  const plan = B.prepPlan({
    excessSecurity: excess,
    growNeeded,
    totalThreads,
    weakenAmount: weakenAmount(ns),
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

  // execAll kills whatever it started when any exec fails, so a failure means
  // NOTHING is running - don't wait out a weaken-time for legs that aren't there.
  if (!execAll(ns, alloc.assignments, target, "prep")) {
    return { launched: false, until: now + H.waitForRamMs, ...plan };
  }
  applyAllocation(snap, alloc);

  // Legs run at the CURRENT security, so wait on the current-state times.
  const wait = (plan.weaken > 0 ? ns.getWeakenTime(target) : ns.getGrowTime(target)) + H.prepSleepPadMs;
  return { launched: true, until: now + wait, ...plan };
}

/**
 * Launch one batch of `cycle.plan` against `target`, entirely or not at all.
 * Returns the in-flight record, or null if it didn't fit / launch.
 * @param {NS} ns @param {Snapshot} snap @param {string} target
 * @param {any} cycle @param {ReturnType<typeof B.landingDelays>} timing
 * @param {number} minSecurity the target's @param {number} id @param {number} now
 */
function launchBatch(ns, snap, target, cycle, timing, minSecurity, id, now) {
  const plan = cycle.plan;
  // Delays from the CURRENT leg times (lib/batch-logic.js landingDelays), so each
  // leg lands on its slot whatever the target's security is right now.
  const d = timing.delays;

  // The grow should go whole onto one host (batch-logic allocate does that when
  // it can). When no host has the room it gets split, and a split grow lands
  // weaker than planned - so that batch carries extra grow threads, and the
  // weaken to cover them (splitGrowPadding).
  let growThreads = plan.growThreads;
  let weaken2Threads = plan.weaken2Threads;
  if (!snap.workers.some(w => Math.floor(w.free / RAM.grow) >= growThreads)) {
    const padded = B.splitGrowPadding({
      growThreads, minSecurity, securityPerGrow: H.securityPerGrow, weakenAmount: weakenAmount(ns),
    });
    growThreads = padded.growThreads;
    weaken2Threads = Math.max(weaken2Threads, padded.weaken2Threads);
  }
  const extraGrow = growThreads - plan.growThreads;
  const extraRam = extraGrow * RAM.grow + (weaken2Threads - plan.weaken2Threads) * RAM.weaken;

  // PLACEMENT order, not landing order (the delays decide that): the grow first,
  // while the hosts are at their roomiest; the weakens, which split harmlessly,
  // take what is left.
  const legs = [
    { script: GROW, threads: growThreads, ram: RAM.grow, delay: d.grow },
    { script: HACK, threads: plan.hackThreads, ram: RAM.hack, delay: d.hack },
    { script: WEAKEN, threads: plan.weaken1Threads, ram: RAM.weaken, delay: d.weaken1 },
    { script: WEAKEN, threads: weaken2Threads, ram: RAM.weaken, delay: d.weaken2 },
  ];
  const alloc = B.allocate(snap.workers, legs);
  if (!alloc.ok) return null;
  if (!execAll(ns, alloc.assignments, target, `batch-${id}`)) return null;
  applyAllocation(snap, alloc);

  return {
    target,
    id,
    ram: plan.ram + extraRam,
    moneyFraction: plan.hackedFraction,
    securityAdded: plan.securityAdded + extraGrow * H.securityPerGrow,
    launchedAt: now,
    doneAt: timing.lastLanding + H.landingPadMs,
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
    nextWindowAt: new Map(),               // target -> when its next batch's first leg is due to LAND
    draining: new Set(),                   // targets latched in a drift drain (no launches until empty)
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
  _rank = { at: 0, ram: 0, list: [] };
  _lastShareHosts = "";
  _weakenAmount = 0;
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
 * @param {number} budgetRam the RAM its batches may hold @param {number} now
 * @param {number} [prepRam] the RAM a prep pass may use (defaults to the budget)
 */
function serviceTarget(ns, s, snap, target, budgetRam, now, prepRam = budgetRam) {
  const math = targetMath(ns, target);
  const state = readTarget(ns, target);
  const open = s.inFlight.filter(b => b.target === target);
  const { schedule, cycle } = cycleFor(math, budgetRam);

  // Drift: is the target worse off than its own open batches can explain? Once
  // it is, it stays "draining" until nothing of ours is in flight (stillDraining).
  const drift = open.length > 0 && B.driftDetected({
    ...state,
    openMoneyFraction: Math.max(...open.map(b => b.moneyFraction)),
    openSecurity: Math.max(...open.map(b => b.securityAdded)),
    moneyTolerance: H.driftMoneyTolerance,
    securityTolerance: H.driftSecurityTolerance,
  });
  const wasDraining = s.draining.has(target);
  const draining = B.stillDraining({ wasDraining, openCount: open.length, drift });
  if (draining && !wasDraining) {
    s.draining.add(target);
    ns.print(`[drift] ${target}: money ${((state.money / Math.max(1, state.maxMoney)) * 100).toFixed(0)}% ` +
      `sec +${(state.security - state.minSecurity).toFixed(2)} - no launches until its ${open.length} batch(es) land`);
  } else if (!draining) {
    s.draining.delete(target);
  }

  let mode;
  if ((s.prepUntil.get(target) ?? 0) > now) {
    mode = "Prepping";
  } else if (open.length === 0 && !prepped(state)) {
    const res = launchPrep(ns, snap, target, state, math, prepRam, now);
    s.prepUntil.set(target, res.until);
    mode = res.launched ? "Prepping" : "Waiting for RAM (prep)";
    if (res.launched) {
      ns.print(`[prep] ${target}: weaken x${res.weaken}, grow x${res.grow}${res.complete ? "" : " (partial)"} | ` +
        `sec ${state.security.toFixed(2)}/${state.minSecurity} money ${((state.money / state.maxMoney) * 100).toFixed(0)}%`);
    }
  } else if (draining) {
    // Stop launching against this target; its window drains within a weaken-time
    // and the branch above re-preps it once nothing of ours is in flight.
    mode = "Draining (drift)";
  } else if (!cycle) {
    mode = "Waiting for RAM";
  } else if (open.length < cycle.depth && now >= (s.nextWindowAt.get(target) ?? 0) - schedule.firstLanding - H.launchLeadMs) {
    // Each batch owns a LANDING window; windows are launchInterval apart, which
    // is what keeps one batch's legs from interleaving with the next's. The
    // launch itself can happen any time early enough to reach the window, so it
    // opens launchLeadMs ahead of the latest moment that would still make it.
    const windowAt = s.nextWindowAt.get(target) ?? 0;
    const cur = { hackTime: ns.getHackTime(target), growTime: ns.getGrowTime(target), weakenTime: ns.getWeakenTime(target) };
    const timing = B.landingDelays(schedule, cur, now, windowAt);
    // Launching now would miss the window only because security is raised this
    // instant (another batch is between its hack and its weaken): a tick or two
    // later the leg times are back to prepped and the window is reachable. Wait
    // for that while the lead lasts; after it, take the slip.
    const raised = cur.weakenTime - math.times.weakenTime > H.batchSpacingMs / 4;
    const waitForCalm = timing.slip > 1 && raised && now < windowAt - schedule.firstLanding + H.launchLeadMs;
    const batch = waitForCalm ? null : launchBatch(ns, snap, target, cycle, timing, state.minSecurity, s.batchId, now);
    if (waitForCalm) {
      mode = "Batching";
    } else if (batch) {
      s.batchId++;
      s.inFlight.push(batch);
      s.nextWindowAt.set(target, timing.base + cycle.launchInterval);
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
    const share = manageShare(ns, snap);
    refreshWorkers(ns, snap, share.touched);
    applyShareHolds(snap, share.holds);
  } catch (e) {
    ns.print(`[share] disabled this tick (error): ${String(e)}`);
  }

  s.inFlight = B.pruneInFlight(s.inFlight, now);

  // What the botnet can plan with right now: RAM free this tick plus what our own
  // in-flight batches are holding (they release it as they land). Ranking uses
  // snap.capacity instead - see buildSnapshot.
  // Capped at capacity: a batch counts its whole RAM until its LAST leg lands,
  // though its earlier legs freed theirs on landing, so the sum runs a little
  // over - enough to plan one batch more than the botnet can ever hold.
  const budgetRam = Math.min(snap.capacity, snap.totalUsable + s.inFlight.reduce((sum, b) => sum + b.ram, 0));

  // Targets we are committed to: batches in flight, or a prep whose legs are out.
  const incumbents = new Set(s.inFlight.map(b => b.target));
  for (const [target, until] of s.prepUntil) if (until > now) incumbents.add(target);
  const ranked = rankTargets(ns, snap, snap.capacity, now, incumbents);
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
    // serviced below, just no longer first. The new primary keeps its landing
    // window: if it was already being serviced as a secondary, forgetting the
    // window would launch straight into its previous batch's landings.
  }

  // Service the targets best earner first, each within its share of the botnet
  // (rankTargets). The shares were cut from the botnet's capacity; scale them to
  // what is actually plannable this tick, and never past what is left.
  const scale = _rank.ram > 0 ? budgetRam / _rank.ram : 1;
  // Nothing of ours in the air at all (a cold start, or after an install): there
  // are no batches to starve, so a prep may use everything not yet claimed and
  // finish in one pass. Once batches fly, a prep stays inside its target's share.
  const coldStart = s.inFlight.length === 0;
  const serviced = [];
  let claimed = 0;
  for (const { target, ram } of ranked) {
    if (serviced.length >= H.maxTargets) break;
    const left = budgetRam - claimed;
    // The primary always gets serviced, however little RAM there is; opening a
    // further target is only worth it above minTargetRam.
    if (serviced.length > 0 && left < H.minTargetRam) break;
    const budget = Math.min(ram * scale, left);
    const res = serviceTarget(ns, s, snap, target, budget, now, coldStart ? left : budget);
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
