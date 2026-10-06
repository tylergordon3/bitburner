// hacking/manager.js
//
// The HGW batching botnet - the daemon's core money engine, run OFF-home (exec'd
// by each bnX/daemon.js via ensureHelper) so its ~10GB never competes with the
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
//      targetRescoreMs rather than every tick. Two variations on it: in
//      BitNode 8 the stock trader's wished servers come first and the rest of
//      the fleet trains hacking exp (rankForStocks), and on a fleet too big for
//      the default caps the windows are deepened inside a budget of worker
//      processes (deepen).
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
//      (planCycle / largestBatch) - or, when the budget cannot carry a full
//      window, the depth x bite that steals most on the hosts there are. A
//      batch is allocated across hosts as a whole (allocate) and launched
//      entirely or not at all, so targets never end up sharing a half-launched
//      batch; one that does not fit the hosts as they are is launched smaller
//      rather than never (hacking.fitShrinkFloor).
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

import { allServers, root, sameScript } from "../lib/net.js";
import { CONFIG } from "../lib/config.js";
import { emitEvent } from "../lib/events.js";
import { reservedHosts } from "../lib/ns-utils.js";
import * as F from "../lib/formulas.js";
import * as B from "../lib/batch-logic.js";

const H = CONFIG.hacking;
// ["share"], not .share - here and for the script path below. The game's RAM
// analyser bills identifiers and dotted property names by NAME, so a `.share`
// anywhere in this file (or a local variable called `share`) is charged as
// ns.share: 2.4GB for a call only share.js makes. A string key is not an
// identifier and is free. (tests/batch-logic.test.mjs keeps it that way.)
const SH = CONFIG["share"];
const HOME = CONFIG.paths.home;
const HACK = CONFIG.paths.hack;
const GROW = CONFIG.paths.grow;
const WEAKEN = CONFIG.paths.weaken;
const SHARE = CONFIG.paths["share"];

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
 *
 * A live daemon rewrites the map every tick; one that has died (or a BitNode
 * that ended) leaves its last map behind for good - RAM held for helpers nobody
 * will ever start. So when the writer also stamps it
 * (globalThis.gordReservedRamAt, a Date.now()), holds older than
 * hacking.reservedRamMaxAgeMs are no longer honoured. Without the stamp the map
 * is trusted as it always was.
 * @param {string} server @param {number} now
 */
function reservedRamFor(server, now) {
  const m = globalThis.gordReservedRam;
  const v = m && m[server];
  if (!(typeof v === "number" && v > 0)) return 0;
  const at = globalThis.gordReservedRamAt;
  return typeof at === "number" && now - at > H.reservedRamMaxAgeMs ? 0 : v;
}

let _netAt = 0;
let _netServers = /** @type {string[]} */ ([]);
let _rootAt = 0;
// Hosts that already hold the worker scripts. Reset by a manager restart, which
// is also when the scripts on home could have changed.
const _copied = new Set();

/**
 * @typedef {{host: string, max: number, free: number, room: number}} Worker
 *   room: what the host could give the botnet if nothing else were on it
 * @typedef {{now: number, servers: string[], rooted: string[], reserved: Set<string>,
 *            workers: Worker[], totalUsable: number, capacity: number,
 *            hosts: {rooms: number[], key: number}, hacking: number}} Snapshot
 */

/** Free RAM across the workers. @param {Worker[]} workers */
function usableRam(workers) {
  let sum = 0;
  for (const w of workers) sum += w.free;
  return sum;
}

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
    let reserve = reservedRamFor(host, now);
    if (host === HOME) reserve += H.reserveHomeRam;
    const free = Math.max(0, max - ns.getServerUsedRam(host) - reserve);
    // What this host could give the botnet if nothing else were on it. Free RAM
    // swings wildly within a launch cycle (and collapses to nearly nothing
    // during a big prep), so TARGET RANKING is done against this stable number -
    // otherwise a prep in flight makes every target look unaffordable and the
    // ranking empties out. Per-target RAM BUDGETS still come from free RAM.
    const room = Math.max(0, max - reserve);
    workers.push({ host, max, free, room });
    capacity += room;
  }
  return {
    now, servers: _netServers, rooted, reserved, workers, totalUsable: usableRam(workers), capacity,
    // Batches are planned for these hosts, not for a pool of gigabytes
    // (batch-logic planBatch's `hosts`, costAt).
    hosts: hostRooms(workers),
    hacking: ns.getHackingLevel(),
  };
}

/**
 * The room on each host as the batch planner should see it, with a fingerprint
 * of the list (the plan cache's key).
 * @param {Worker[]} workers
 * @param {Record<string, number>} [taken] GB per host that is spoken for (the
 *        faction-rep plan: five hosts of a 26-host fleet can be all share.js)
 */
function hostRooms(workers, taken) {
  const rooms = [];
  let key = 0;
  for (const w of workers) {
    const room = Math.max(0, w.room - (taken?.[w.host] ?? 0));
    rooms.push(room);
    key = (key * 31 + Math.round(room * 4)) % 2147483647;
  }
  return { rooms, key };
}

/** Re-read free RAM for a few hosts after something outside our plan ran there. */
function refreshWorkers(ns, snap, hosts) {
  for (const host of hosts) {
    const w = snap.workers.find(x => x.host === host);
    if (!w) continue;
    let reserve = reservedRamFor(host, snap.now);
    if (host === HOME) reserve += H.reserveHomeRam;
    w.free = Math.max(0, w.max - ns.getServerUsedRam(host) - reserve);
  }
  snap.totalUsable = usableRam(snap.workers);
}

/** Apply an allocation's post-launch free RAM to the snapshot. */
function applyAllocation(snap, alloc) {
  for (const w of snap.workers) {
    const free = alloc.freeAfter.get(w.host);
    if (free !== undefined) w.free = free;
  }
  snap.totalUsable = usableRam(snap.workers);
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
// Hosts that may be running share.js: the ones this manager started it on, plus
// whatever the last sweep of the network found (a previous manager's leftovers).
// ns.ps builds an object per process on the host, and with a few thousand batch
// legs in the air a sweep of every rooted host on every tick was the manager's
// largest allocation; only these hosts need looking at between sweeps.
const _shareHosts = new Set();
let _shareSweepAt = -Infinity;

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
  for (const p of ns.ps(host)) if (sameScript(p.filename, SHARE)) t += p.threads;
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
 * @returns {{touched: string[], holds: Map<string, number>, plan: Record<string, number>}}
 *   plan: host -> GB the plan gives to share.js there (running or not yet)
 */
function manageShare(ns, snap) {
  const eligible = shareEligibleHosts(snap);
  const plan = farmingRep() ? planShare(eligible, shareBudgetRam(eligible)) : {};
  const touched = [];
  const holds = new Map();

  // Stop share on any host no longer in the plan. Kill by pid (via ns.ps/ns.kill,
  // already used here) rather than ns.scriptKill, so this adds no manager RAM.
  // Every rooted host is swept on the first tick and then every networkRescanMs
  // (share.js left behind by a manager that was killed); in between, only the
  // hosts known to hold it (_shareHosts).
  const sweep = snap.now - _shareSweepAt >= H.networkRescanMs;
  if (sweep) _shareSweepAt = snap.now;
  for (const host of sweep ? snap.rooted : [..._shareHosts]) {
    if (plan[host]) continue;
    _shareHosts.delete(host);
    // A tracked host can have been deleted since (ns.ps would throw on it).
    if (!sweep && !snap.rooted.includes(host)) continue;
    for (const p of ns.ps(host)) {
      if (sameScript(p.filename, SHARE)) { ns.kill(p.pid); touched.push(host); }
    }
  }

  // Start, or top up, share on the planned hosts - out of free RAM only.
  // `running` is what each ends up with (below the plan while a busy host is
  // still filling).
  /** @type {Map<string, number>} */
  const running = new Map();
  for (const [host, gb] of Object.entries(plan)) {
    const want = Math.floor(gb / _shareThreadRam);
    const have = shareThreadsOn(ns, host);
    running.set(host, have);
    if (have > 0) _shareHosts.add(host);
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
        running.set(host, have + started);
        _shareHosts.add(host);
      }
    }
    const missing = want - have - started;
    if (missing > 0) holds.set(host, missing * _shareThreadRam);
  }

  const servers = Object.keys(plan).filter(h => running.get(h) > 0);
  const threads = servers.reduce((s, h) => s + running.get(h), 0);
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
  return { touched, holds, plan };
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
  snap.totalUsable = usableRam(snap.workers);
}

// ── Per-target math (Formulas when present, ns.* approximations otherwise) ───

/**
 * @typedef {{hackTime: number, growTime: number, weakenTime: number}} Times
 * @typedef {{times: Times, hackPct: number, hackChance: number, useFormulas: boolean,
 *            maxThreads: number, safeThreads: number, plan: (hackThreads: number) => any, cache: PlanCache,
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
  const minSecurity = ns.getServerMinSecurityLevel(target);

  let times, hackPct, growThreadsFor, security = 0;
  if (useFormulas) {
    times = F.batchTimes(ns, target);
    hackPct = F.hackPercent(ns, target);
    growThreadsFor = (remaining) => F.growThreadsToFull(ns, target, remaining);
  } else {
    security = ns.getServerSecurityLevel(target);
    const k = B.preppedScale({
      security,
      minSecurity,
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
  // A batch plan is a pure function of its hack thread count and of inputs that
  // hardly ever move (planCacheFor), while the sizing searches ask for the same
  // few dozen thread counts on every tick - so each is planned once and kept.
  // (On the ns.* path each security reading gets its own entry: the target swings
  // between the same few values as batches land, and they should not evict each
  // other.)
  const cache = planCacheFor(useFormulas ? target : `${target}@${security}`, [
    hackPct, ns.getServerMaxMoney(target), minSecurity,
    _growMult, weakenAmount(ns), RAM.hack, RAM.grow, RAM.weaken, _hosts.key,
  ].join("|"));
  const plans = cache.plans;
  const plan = (hackThreads) => {
    let batch = plans.get(hackThreads);
    if (batch === undefined) {
      batch = B.planBatch({
        hackThreads,
        hackPct,
        growThreadsFor,
        ramPerThread: RAM,
        securityPerHack: H.securityPerHack,
        securityPerGrow: H.securityPerGrow,
        weakenAmount: weakenAmount(ns),
        maxHackFraction: H.maxHackFraction,
        growPadding: H.growPadding,
        hosts: _hosts.rooms,
        minSecurity,
      });
      plans.set(hackThreads, batch);
    }
    return batch;
  };

  // Grow threads a PREP needs: from the current money, at the CURRENT security
  // (the prep's grow legs land before their accompanying weaken does) - which is
  // exactly what growthAnalyze reads, so the fallback needs no scaling here.
  const growNeeded = (money, maxMoney, security) => {
    if (maxMoney <= 0 || money >= maxMoney) return 0;
    if (useFormulas) return F.growThreadsToFull(ns, target, money / maxMoney, security);
    return Math.ceil(ns.growthAnalyze(target, maxMoney / Math.max(money, 1)));
  };

  const maxThreads = B.maxHackThreads(hackPct, H.maxHackFraction);
  // The hack threads whose bite one lost grow leaves inside the drift tolerance
  // (batch-logic planCycle will not search a thin window past it for nothing).
  const safeThreads = B.maxHackThreads(hackPct, H.driftMoneyTolerance);
  // Only the ranking reads the success chance, so it is worked out on demand
  // rather than on every tick of every target.
  let chance;
  return {
    times, hackPct, useFormulas, maxThreads, safeThreads, plan, growNeeded, cache,
    get hackChance() { return chance ??= useFormulas ? F.hackChance(ns, target) : 1; },
  };
}

// ── Plan cache ───────────────────────────────────────────────────────────────
//
// largestBatch / efficientThreads / incomeCurve size a target by trying thread
// counts, and every try is a grow-thread question to the game: ~23 per target
// per tick, each one a mock server built from four getters. The answers only
// change with the inputs in the key targetMath builds - the hack % (hacking
// level, money multipliers), the target's max money and min security (hash
// upgrades move both), the player's grow multiplier (grafts, Stanek charges,
// IPvGO), the weaken rate and the worker RAM; on the ns.* path also the
// target's current security, which growthAnalyze reads. Server growth and the
// BitNode multipliers never change under a running script.
//
// A changed key drops that target's plans, and every re-rank drops them all
// (rankTargets), so nothing is trusted for longer than targetRescoreMs and the
// maps cannot grow without bound.
/** @typedef {{key: string, plans: Map<number, any>, cycle: any}} PlanCache */
/** @type {Map<string, PlanCache>} */
const _planCache = new Map();
// The player's grow multiplier, read once per tick in step().
let _growMult = 1;
// The room on each host (the snapshot's `hosts`), likewise.
let _hosts = { rooms: /** @type {number[]} */ ([]), key: 0 };

/**
 * @param {string} id target (and security, on the ns.* path) @param {string} key
 * @returns {PlanCache} `cycle` is cycleFor's: the last cycle planned from these plans
 */
function planCacheFor(id, key) {
  let entry = _planCache.get(id);
  if (!entry || entry.key !== key) {
    entry = { key, plans: new Map(), cycle: null };
    _planCache.set(id, entry);
  }
  return entry;
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

/**
 * @typedef {{target: string, score: number, ram: number, depth?: number, objective?: string}} Ranked
 *   depth: how deep this target's window may be (set only by the late-game plan,
 *   see deepen); objective: "stock" / "exp" when the ranking was not for income.
 * @typedef {Map<string, {open: number, depth: number}>} Flying
 *   per target with batches in flight: how many, and the depth of the window
 *   the latest was launched into
 */
let _rank = { at: 0, ram: 0, list: /** @type {Ranked[]} */ ([]), pushing: false, deep: false };
// A window counts as full, for the switch to the late-game plan, at this share
// of its depth (a full window is forever one batch short for a tick or two).
const DEEP_READY_FILL = 0.9;

/**
 * The batch plan for one target given `ramBudget`: the leg schedule (fixed by
 * the target's leg times) and the cycle that fills the budget (depth from
 * timing, hack threads from RAM). cycle is null when not even a one-thread
 * batch fits.
 * @param {TargetMath} math @param {number} ramBudget
 * @param {number} [thinRam] the same budget counted leg by leg (see step): what
 *        the window's shape is chosen on, and a sparse window sized on
 *        (batch-logic planCycle)
 * @param {number} [maxDepth] how deep its window may be (the late-game plan's,
 *        see deepen; hacking.maxDepth otherwise)
 */
function cycleFor(math, ramBudget, thinRam = ramBudget, maxDepth = H.maxDepth) {
  const schedule = B.legSchedule({ ...math.times, spacing: H.batchSpacingMs, margin: H.launchMarginMs });
  // A target's budget is the same from one tick to the next once its window is
  // full, and the cycle is a pure function of it, the schedule and the plans this
  // cache entry holds - so the last one is kept (a thin window's search walks
  // every depth below the full one).
  const memo = math.cache.cycle;
  if (memo && memo.ram === ramBudget && memo.thinRam === thinRam && memo.lastLanding === schedule.lastLanding
    && memo.launchInterval === schedule.launchInterval && memo.maxDepth === maxDepth) {
    return { schedule, cycle: memo.cycle };
  }
  const cycle = B.planCycle({
    totalRam: ramBudget,
    thinRam,
    lastLanding: schedule.lastLanding,
    launchInterval: schedule.launchInterval,
    maxDepth,
    maxThreads: math.maxThreads,
    safeThreads: math.safeThreads,
    planFor: math.plan,
  });
  math.cache.cycle = {
    ram: ramBudget, thinRam, lastLanding: schedule.lastLanding, launchInterval: schedule.launchInterval,
    maxDepth, cycle,
  };
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
 * @param {Flying} flying the ones with batches in flight
 * @param {Map<string, number> | null} [wishes] the trader's preferred servers
 *        (batch-logic preferredWishes); null everywhere but BitNode 8
 */
function rankTargets(ns, snap, capacity, now, incumbents, flying, wishes = null) {
  const stale = now - _rank.at >= H.targetRescoreMs
    || Math.abs(capacity - _rank.ram) > _rank.ram * 0.5
    || !!wishes !== _rank.pushing;
  if (_rank.list.length && !stale) return _rank.list;

  _planCache.clear();
  const curves = [];
  /** @type {Map<string, number>} what each target's income per GB is multiplied by */
  const weight = new Map();
  /** @type {Map<string, {maxMoney: number, m: TargetMath, schedule: any}>} */
  const cands = new Map();
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
    curves.push({ key: server, points, minRam: m.plan(1)?.nominalRam ?? Infinity });
    weight.set(server, incumbents.has(server)
      ? 1 + H.targetStickiness
      : B.prepDiscount(prepEstimateMs(ns, server, m, capacity), H.prepHorizonMs));
    cands.set(server, { maxMoney, m, schedule });
  }
  const bonus = key => weight.get(key) ?? 1;

  let list;
  let deep = false;
  if (wishes) {
    list = rankForStocks(ns, capacity, cands, weight, wishes);
  } else {
    list = B.allocateRam({
      totalRam: capacity,
      curves,
      maxTargets: H.maxTargets,
      minTargetRam: H.minTargetRam,
      bonus,
    }).map(a => ({ target: a.key, score: a.income, ram: a.ram }));
    // Ready for a deeper window: its window is FULL (nine tenths of the depth it
    // was planned at) - or, while nothing at all is in flight, it is prepped and
    // untouched (a mark-down of exactly 1 - see prepDiscount).
    const chosen = deepen(list, capacity, cands, bonus, target => {
      const f = flying.get(target);
      return f ? f.open >= f.depth * DEEP_READY_FILL : flying.size === 0 && weight.get(target) === 1;
    });
    list = chosen.list;
    deep = chosen.deep;
  }
  _rank = { at: now, ram: capacity, list, pushing: !!wishes, deep };
  return list;
}

// ── BitNode 8: the trader's stocks first, then hacking exp ───────────────────
//
// A script hack pays nothing there (ScriptHackMoneyGain 0), and the manager
// cannot see that: nothing it reads carries the multiplier, so it would go on
// ranking by an income that is not being paid - batching, and earning hacking
// exp, on whichever servers would have been rich elsewhere. What it CAN see is
// the trader (lib/stocks.js), which in that node publishes its wish list with
// `prefer` set. While that list is fresh the ranking has two other objectives
// (lib/batch-logic.js, "When money is not the point"):
//
//   1. The wished servers that are in reach, each valued by the share of its
//      max money a window cycles per millisecond - which is what moves its
//      stock's forecast, the workers flagging the leg that pushes the wished
//      way - weighted by its place in the list. They are allocated FIRST, as
//      much RAM as their windows hold.
//   2. Everything else (and the wished servers that got nothing), valued by
//      hacking exp per millisecond, with the RAM that is left. One target slot
//      is kept for this (hacking.stockPush.expSlots), so a fleet the wished
//      servers cannot fill is not left idle.
//
// The moment the list goes stale, or `prefer` is off (every other BitNode), the
// income ranking above is the only one that runs. (These windows keep the
// default caps: the late-game plan below is planned on income, and is not used
// while the trader is being worked.)

/**
 * @param {NS} ns @param {number} capacity
 * @param {Map<string, {maxMoney: number, m: TargetMath, schedule: any}>} cands
 * @param {Map<string, number>} weight the incumbents' edge / prep mark-down, per target
 * @param {Map<string, number>} wishes batch-logic preferredWishes
 */
function rankForStocks(ns, capacity, cands, weight, wishes) {
  const pushCurves = [];
  const expCurves = new Map();
  for (const [server, c] of cands) {
    // (Not called `window`: the game bills that identifier 25GB.)
    const shape = {
      hackChance: c.m.hackChance,
      lastLanding: c.schedule.lastLanding,
      launchInterval: c.schedule.launchInterval,
      maxDepth: H.maxDepth,
      maxThreads: c.m.maxThreads,
      planFor: c.m.plan,
    };
    const minRam = c.m.plan(1)?.nominalRam ?? Infinity;
    if (wishes.has(server)) {
      const points = B.incomeCurve({ ...shape, maxMoney: 1 });
      if (points.length) pushCurves.push({ key: server, points, minRam });
    }
    const points = B.expCurve({ ...shape, minSecurity: ns.getServerMinSecurityLevel(server) });
    if (points.length) expCurves.set(server, { key: server, points, minRam });
  }

  const pushSlots = Math.max(1, H.maxTargets - H.stockPush.expSlots);
  const pushed = B.allocateRam({
    totalRam: capacity,
    curves: pushCurves,
    maxTargets: pushSlots,
    minTargetRam: H.minTargetRam,
    bonus: key => (weight.get(key) ?? 1) * (wishes.get(key) ?? 0),
  }).sort((a, b) => (wishes.get(b.key) ?? 0) - (wishes.get(a.key) ?? 0));
  for (const a of pushed) expCurves.delete(a.key);

  const trained = B.allocateRam({
    totalRam: capacity - pushed.reduce((sum, a) => sum + a.ram, 0),
    curves: [...expCurves.values()],
    maxTargets: H.maxTargets - pushed.length,
    minTargetRam: H.minTargetRam,
    bonus: key => weight.get(key) ?? 1,
  });
  // score: forecast cycled / exp landed per ms, NOT dollars - `objective` says which.
  return [
    ...pushed.map(a => ({ target: a.key, score: a.income, ram: a.ram, objective: "stock" })),
    ...trained.map(a => ({ target: a.key, score: a.income, ram: a.ram, objective: "exp" })),
  ];
}

// ── Late game: deeper windows, within a budget of processes ──────────────────
//
// maxDepth 60 x maxTargets 6 is 1,440 worker processes and, on a fleet that has
// outgrown its targets, most of the botnet idle: 26 x 1PB used 1-13% of its
// RAM, and a 26 x 16TB fleet that used all of it still spread it over four or
// five targets at 60 deep where two of them at 240 pay more. Depth is what a
// big fleet is short of - a slot in the best target's window is worth more than
// one in the sixth-best's - and what depth costs is processes, not RAM. So when
// the plan with deeper windows (hacking.adaptive.maxDepth / maxTargets) is
// predicted to out-earn the default one by enough to be worth the churn, it is
// used instead, trimmed best earner first to hacking.adaptive.maxProcesses
// (batch-logic capProcesses). On a fleet whose windows are thin anyway the two
// plans are the same plan, and nothing changes. (Simulated, steady state:
// unchanged up to 2TB and at 26 x 1TB, up to +18% at 4-8TB, +0..88% on
// 26 x 16TB, +54..165% on 26 x 64TB, +120..200% on 26 x 1PB, with at most 3,000
// worker processes where there were ~1,440.)

/**
 * What a ranked list would really run: each target's cycle on its share, with
 * its window `depthCap` deep at most, held to the process budget.
 * @param {{target: string, score: number, ram: number}[]} list
 * @param {Map<string, {maxMoney: number, m: TargetMath, schedule: any}>} cands
 */
function windowsFor(list, cands, depthCap) {
  const windows = [];
  for (const entry of list) {
    const c = cands.get(entry.target);
    if (!c) continue;
    const cycle = B.planCycle({
      totalRam: entry.ram,
      lastLanding: c.schedule.lastLanding,
      launchInterval: c.schedule.launchInterval,
      maxDepth: depthCap,
      maxThreads: c.m.maxThreads,
      safeThreads: c.m.safeThreads,
      planFor: c.m.plan,
    });
    if (!cycle) continue;
    // A thin window launches `depth` batches per weaken-time, not one an interval.
    const interval = Math.max(cycle.launchInterval, c.schedule.lastLanding / cycle.depth);
    windows.push({
      ...entry,
      depth: cycle.depth,
      planned: cycle.depth,
      income: (B.stolenAt(cycle.plan, cycle.depth) * c.maxMoney * c.m.hackChance) / interval,
    });
  }
  const capped = B.capProcesses(windows, H.adaptive.maxProcesses);
  return {
    income: capped.income,
    trimmed: capped.trimmed,
    // A window the budget cut may be no deeper than what it was left; the others
    // keep the plan's ceiling (their depth is the scheduler's to choose, tick by
    // tick, as the budget moves).
    list: capped.kept.map(w => ({
      target: w.target, score: w.score, ram: w.ram, depth: w.depth < w.planned ? w.depth : depthCap,
    })),
  };
}

/**
 * The ranked list to use: `list` (the default caps) or, when it is predicted to
 * earn hacking.adaptive.minGain more, the one planned with deeper windows on
 * up to hacking.adaptive.maxTargets targets - each entry then carries the depth
 * its window may have.
 *
 * The deep plan is first ADOPTED over the targets that are `ready`, and is
 * planned over those alone. Ready is: batching with a FULL window - or, while
 * nothing at all is in flight, prepped and untouched. Why each part:
 * - It puts the fleet on fewer servers. From a cold start that means waiting on
 *   their long preps while the quick targets the default plan would have had
 *   paying get nothing, so a server that still has to be prepped does not
 *   count.
 * - A window that is still filling pays nothing yet. Switching the moment its
 *   target started batching dropped the targets that WERE paying a weaken-time
 *   before the deep window paid in their place: 5-9% off the first hour on
 *   12 x 8TB, 26 x 4TB and 26 x 16TB. From full windows the old batches of the
 *   kept targets go on landing while the deep ones are launched behind them.
 * - Planned over every candidate it could list a server nobody is working, and
 *   then never be adopted at all: a cold 26 x 1PB fleet at hacking 60 stayed on
 *   the default plan for good, at 37% of what the deep one pays.
 * Once in force it is planned over every candidate (an unprepped newcomer is
 * marked down for its prep, as in the default ranking) and kept until the
 * default plan would do as well, so the two do not trade places on a rounding
 * error or on one target's re-prep.
 * @param {{target: string, score: number, ram: number}[]} list the default plan
 * @param {number} capacity
 * @param {Map<string, {maxMoney: number, m: TargetMath, schedule: any}>} cands
 * @param {(key: string) => number} bonus allocateRam's
 * @param {(target: string) => boolean} ready
 */
function deepen(list, capacity, cands, bonus, ready) {
  const A = H.adaptive;
  if (!A?.enabled || !list.length) return { deep: false, list };
  const depthCap = Math.max(H.maxDepth, A.maxDepth);
  const targetCap = Math.max(H.maxTargets, A.maxTargets);
  const plain = windowsFor(list, cands, H.maxDepth);

  const curves = [];
  for (const [server, c] of cands) {
    if (!_rank.deep && !ready(server)) continue;
    const points = B.incomeCurve({
      maxMoney: c.maxMoney,
      hackChance: c.m.hackChance,
      lastLanding: c.schedule.lastLanding,
      launchInterval: c.schedule.launchInterval,
      maxDepth: depthCap,
      maxThreads: c.m.maxThreads,
      planFor: c.m.plan,
    });
    if (points.length) curves.push({ key: server, points, minRam: c.m.plan(1)?.nominalRam ?? Infinity });
  }
  const deepList = B.allocateRam({
    totalRam: capacity, curves, maxTargets: targetCap, minTargetRam: H.minTargetRam, bonus,
  }).map(a => ({ target: a.key, score: a.income, ram: a.ram }));
  const deep = windowsFor(deepList, cands, depthCap);

  const better = _rank.deep
    ? deep.income >= plain.income
    : deep.income > plain.income * (1 + A.minGain);
  // (The default plan too is held to the process budget, should that be set
  // below what six windows of sixty take; untrimmed it is returned as it came.)
  return { deep: better, list: better ? deep.list : plain.trimmed ? plain.list : list };
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
 * Where the four legs of `plan` would go on the hosts as they are right now.
 * @param {NS} ns @param {Snapshot} snap @param {any} plan
 * @param {{hack: number, weaken1: number, grow: number, weaken2: number}} d leg delays
 * @param {number} minSecurity the target's
 */
function placeBatch(ns, snap, plan, d, minSecurity) {
  // The grow should go whole onto one host (batch-logic allocate does that when
  // it can). When no host has the room it gets split, and a split grow lands
  // weaker than planned - so that batch carries extra grow threads, and the
  // weaken to cover them (splitGrowPadding). A plan that already knew no host
  // could ever hold its grow (plan.split) was sized with them.
  let growThreads = plan.growThreads;
  let weaken2Threads = plan.weaken2Threads;
  if (!plan.split && !snap.workers.some(w => Math.floor(w.free / RAM.grow) >= growThreads)) {
    const padded = B.splitGrowPadding({
      growThreads, minSecurity, securityPerGrow: H.securityPerGrow, weakenAmount: weakenAmount(ns),
    });
    growThreads = padded.growThreads;
    weaken2Threads = Math.max(weaken2Threads, padded.weaken2Threads);
  }
  // PLACEMENT order, not landing order (the delays decide that): the grow first,
  // while the hosts are at their roomiest; the weakens, which split harmlessly,
  // take what is left. A grow no host could ever hold gives the hack first pick
  // instead: a split hack takes less than it was sized for (each part takes its
  // share of what the parts before it left - batch-logic stolenAt), and that
  // grow was planned split, padding and all. (Not a grow that merely finds no
  // room this tick: placed first it usually fails the batch, the launch waits
  // a tick or two for a host to clear, and the grow goes out whole after all.)
  const growLeg = { script: GROW, threads: growThreads, ram: RAM.grow, delay: d.grow };
  const hackLeg = { script: HACK, threads: plan.hackThreads, ram: RAM.hack, delay: d.hack };
  const legs = [
    ...(plan.split ? [hackLeg, growLeg] : [growLeg, hackLeg]),
    { script: WEAKEN, threads: plan.weaken1Threads, ram: RAM.weaken, delay: d.weaken1 },
    { script: WEAKEN, threads: weaken2Threads, ram: RAM.weaken, delay: d.weaken2 },
  ];
  return { plan, growThreads, weaken2Threads, alloc: B.allocate(snap.workers, legs) };
}

/**
 * Launch one batch of `cycle.plan` against `target`, entirely or not at all.
 * Returns the in-flight record, or null if it didn't fit / launch.
 * @param {NS} ns @param {Snapshot} snap @param {string} target
 * @param {any} cycle @param {ReturnType<typeof B.landingDelays>} timing
 * @param {number} minSecurity the target's @param {number} id @param {number} now
 * @param {TargetMath | null} math the target's, when a batch smaller than the
 *        plan may be launched if the plan does not fit; null to wait instead
 * @param {{hack: number, weaken1: number, grow: number, weaken2: number}} landAt
 *        when each leg is due to land
 * @param {number} procsLeft worker processes left of hacking.adaptive.maxProcesses
 */
function launchBatch(ns, snap, target, cycle, timing, minSecurity, id, now, math, landAt, procsLeft) {
  // Delays from the CURRENT leg times (lib/batch-logic.js landingDelays), so each
  // leg lands on its slot whatever the target's security is right now.
  const d = timing.delays;

  let placed = placeBatch(ns, snap, cycle.plan, d, minSecurity);
  const least = Math.ceil(cycle.plan.hackThreads * H.fitShrinkFloor);
  if (!placed.alloc.ok && math && least < cycle.plan.hackThreads
    && snap.totalUsable >= cycle.plan.ram * H.fitShrinkFloor) {
    // Most of the room is there and the batch still does not go, because a host
    // holds WHOLE threads and the plan was sized against a pool of gigabytes:
    // three 16GB servers are 27 threads, not 48GB (0.25GB is stranded on each),
    // a leg split across hosts strands a sliver on every one of them, and a
    // grow that finds no host to take it whole needs padding nobody budgeted.
    // Waiting changes none of that - every batch that lands is replaced by one
    // the same size - so the slot stayed empty for good: a 56GB fleet of
    // 24 + 16 + 16 planned one 55.1GB batch (32 threads, room for 31) and sat on
    // "Waiting for RAM (fragmented)" with a prepped target and an idle fleet;
    // one planned for three batches flew two. This window takes the fattest
    // batch the hosts can place as they are instead, down to fitShrinkFloor of
    // the plan; below that the RAM is simply busy (a prep, a share ramp) and the
    // launch waits for it as before. (The caller withholds `math` from a full,
    // rolling window - one of its batches lands within a launch interval or two
    // and the next launch gets that room - where squeezing a part-batch into
    // the slivers just meant a third more processes for the same income.)
    let lo = least - 1;
    let hi = cycle.plan.hackThreads - 1;
    let found = null;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const plan = math.plan(mid);
      const smaller = plan ? placeBatch(ns, snap, plan, d, minSecurity) : null;
      if (smaller?.alloc.ok) {
        lo = mid;
        found = smaller;
      } else {
        hi = mid - 1;
      }
    }
    if (found) placed = found;
  }
  const { plan, alloc } = placed;
  if (!alloc.ok) return null;
  // The process budget is a hard cap: a batch whose legs had to be split into
  // more processes than are left of it waits for a tidier moment.
  if (alloc.assignments.length > procsLeft) return null;
  if (!execAll(ns, alloc.assignments, target, `batch-${id}`)) return null;
  applyAllocation(snap, alloc);

  const extraGrow = placed.growThreads - plan.growThreads;
  const extraRam = extraGrow * RAM.grow + (placed.weaken2Threads - plan.weaken2Threads) * RAM.weaken;
  return {
    target,
    id,
    ram: plan.ram + extraRam,
    // When each leg lands and the RAM it gives back then (heldRam), in landing
    // order: H, W1, G, W2 - with the padding a split grow was launched with.
    legs: [
      { at: landAt.hack, ram: plan.hackThreads * RAM.hack },
      { at: landAt.weaken1, ram: plan.weaken1Threads * RAM.weaken },
      { at: landAt.grow, ram: placed.growThreads * RAM.grow },
      { at: landAt.weaken2, ram: placed.weaken2Threads * RAM.weaken },
    ],
    processes: alloc.assignments.length,
    depth: cycle.depth,
    moneyFraction: plan.hackedFraction,
    securityAdded: plan.securityAdded + extraGrow * H.securityPerGrow,
    launchedAt: now,
    doneAt: timing.lastLanding + H.landingPadMs,
  };
}

/**
 * The RAM a batch in flight still holds: the legs that have not landed yet.
 * @param {{legs: {at: number, ram: number}[]}} batch @param {number} now
 */
function heldRam(batch, now) {
  let sum = 0;
  for (const leg of batch.legs) if (leg.at > now) sum += leg.ram;
  return sum;
}

/** @param {NS} ns */
function killOldHackScripts(ns) {
  for (const server of allServers(ns)) {
    if (!ns.hasRootAccess(server)) continue;
    for (const p of ns.ps(server)) {
      if ([HACK, GROW, WEAKEN].some(s => sameScript(p.filename, s))) ns.kill(p.pid);
    }
  }
}

// ── Main loop ────────────────────────────────────────────────────────────────

/** Per-process scheduler state; `step` mutates it. One per manager. */
export function newSchedulerState() {
  return {
    inFlight: /** @type {any[]} */ ([]),  // batches whose legs haven't all landed (any target)
    processes: 0,                          // worker processes those batches were launched as
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
  _rank = { at: 0, ram: 0, list: [], pushing: false, deep: false };
  _planCache.clear();
  _growMult = 1;
  _hosts = { rooms: [], key: 0 };
  _lastShareHosts = "";
  _shareHosts.clear();
  _shareSweepAt = -Infinity;
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
 * @param {number} [maxDepth] how deep its window may be (see cycleFor)
 * @param {number} [thinRam] the budget counted leg by leg (see cycleFor)
 */
function serviceTarget(ns, s, snap, target, budgetRam, now, prepRam = budgetRam, maxDepth = H.maxDepth, thinRam = budgetRam) {
  const math = targetMath(ns, target);
  const state = readTarget(ns, target);
  const open = s.inFlight.filter(b => b.target === target);
  const { schedule, cycle } = cycleFor(math, budgetRam, thinRam, maxDepth);

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
  } else if (open.length < cycle.depth && s.processes + 4 <= H.adaptive.maxProcesses
    && now >= (s.nextWindowAt.get(target) ?? 0) - schedule.firstLanding - H.launchLeadMs) {
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
    // (See launchBatch: only a window that is not about to free a batch's worth
    // of RAM by itself takes a smaller batch than planned.)
    let rolling = false;
    for (const b of open) if (b.doneAt - now <= cycle.launchInterval * 2) rolling = true;
    // Each leg lands at its offset into the batch's window (landingDelays).
    const L = schedule.landings;
    const first = timing.base - schedule.firstLanding;
    const landAt = { hack: first + L.hack, weaken1: first + L.weaken1, grow: first + L.grow, weaken2: first + L.weaken2 };
    const batch = waitForCalm ? null
      : launchBatch(ns, snap, target, cycle, timing, state.minSecurity, s.batchId, now, rolling ? null : math, landAt,
        H.adaptive.maxProcesses - s.processes);
    if (waitForCalm) {
      mode = "Batching";
    } else if (batch) {
      s.batchId++;
      s.inFlight.push(batch);
      s.processes += batch.processes;
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
    claim: cycle ? cycle.depth * cycle.cost : 0,
    objective: /** @type {string | undefined} */ (undefined),
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
  _growMult = ns.getPlayer().mults?.hacking_grow ?? 1;

  // Share is an optional side mode and must NEVER be able to stop the core
  // hacking loop (e.g. a stale config on a runner). On error, log and keep going.
  try {
    const sharing = manageShare(ns, snap);
    refreshWorkers(ns, snap, sharing.touched);
    applyShareHolds(snap, sharing.holds);
    // The hosts batches are planned for do not include what share.js is given.
    if (Object.keys(sharing.plan).length) snap.hosts = hostRooms(snap.workers, sharing.plan);
  } catch (e) {
    ns.print(`[share] disabled this tick (error): ${String(e)}`);
  }
  _hosts = snap.hosts;

  s.inFlight = B.pruneInFlight(s.inFlight, now);
  // The hard cap on worker processes (hacking.adaptive.maxProcesses) counts the
  // batches in flight; a prep's handful of legs are not batches and not counted.
  s.processes = 0;
  for (const b of s.inFlight) s.processes += b.processes;

  // What the botnet can plan with right now: RAM free this tick plus what our own
  // in-flight batches are holding (they release it as they land). Ranking uses
  // snap.capacity instead - see buildSnapshot.
  // Capped at capacity: a batch counts its whole RAM until it is pruned, half a
  // second after its LAST leg lands, though its legs have been giving theirs
  // back for a second and a half by then, so the sum runs over by up to a batch.
  let counted = 0;
  let held = 0;
  for (const b of s.inFlight) {
    counted += b.ram;
    held += heldRam(b, now);
  }
  const budgetRam = Math.min(snap.capacity, snap.totalUsable + counted);
  // ...and the same counted LEG BY LEG: what a window's shape is chosen on, and
  // what a SPARSE window is sized on (batch-logic planCycle's thinRam). The cap
  // only hides the overrun while the botnet has the hosts to itself: with
  // faction-rep share on them, or the daemon's helpers, capacity is more than
  // the botnet can ever hold. A window that turns over quickly shrugs that off -
  // the RAM is free, and the next landing pays it back. A sparse one's bite is
  // the budget divided by a handful of batches: one slot short, it launched its
  // next batch in exactly the ticks the sum ran over, a batch too fat for the
  // last slot ever to fit beside it, and did the same again when that one
  // landed. Simulated, a 440GB fleet sharing 76GB flew three batches of four
  // for good, 4% under what it earned before the thin window followed its
  // budget.
  const exactRam = Math.min(budgetRam, snap.totalUsable + held);

  // Targets we are committed to: batches in flight (how many, and how deep the
  // window the latest was launched into), or a prep whose legs are out.
  /** @type {Flying} */
  const flying = new Map();
  for (const b of s.inFlight) {
    const f = flying.get(b.target);
    if (f) { f.open++; f.depth = b.depth; } else flying.set(b.target, { open: 1, depth: b.depth });
  }
  const incumbents = new Set(flying.keys());
  for (const [target, until] of s.prepUntil) if (until > now) incumbents.add(target);
  // The trader's wish list, when it asks to be worked ahead of income (BN8).
  const wishes = H.stockPush.enabled
    ? B.preferredWishes(globalThis.gordStockWishes, now, H.stockPush.maxAgeMs, H.stockPush.rankDecay)
    : null;
  const ranked = rankTargets(ns, snap, snap.capacity, now, incumbents, flying, wishes);
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
  // (Each target's thin-window budget is its share of the leg-by-leg count.)
  const tight = budgetRam > 0 ? exactRam / budgetRam : 1;
  // Nothing of ours in the air at all (a cold start, or after an install): there
  // are no batches to starve, so a prep may use everything not yet claimed and
  // finish in one pass. Once batches fly, a prep stays inside its target's share.
  const coldStart = s.inFlight.length === 0;
  const serviced = [];
  let claimed = 0;
  // (The late-game plan may list more targets than maxTargets - see deepen.)
  const maxServiced = Math.max(H.maxTargets, ranked.length);
  for (const { target, ram, depth, objective } of ranked) {
    if (serviced.length >= maxServiced) break;
    const left = budgetRam - claimed;
    // The primary always gets serviced, however little RAM there is; opening a
    // further target is only worth it above minTargetRam.
    if (serviced.length > 0 && left < H.minTargetRam) break;
    const budget = Math.min(ram * scale, left);
    const res = serviceTarget(ns, s, snap, target, budget, now, coldStart ? left : budget, depth, budget * tight);
    res.objective = objective;
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
      // "stock" / "exp" while the trader's wish list is being worked (BN8).
      ...(r.objective ? { objective: r.objective } : null),
    })),
    // True while the ranking is for the trader's stocks and hacking exp rather
    // than income: `score` is then not dollars (see rankForStocks).
    stockPush: _rank.pushing,
    processes: s.processes,
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
  // Module variables outlive the process (the game reuses a compiled module while
  // its source is unchanged), so a restarted manager starts from clean caches
  // rather than from the last one's network walk, ranking and plans.
  resetCaches();
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
