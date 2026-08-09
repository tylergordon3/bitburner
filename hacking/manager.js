// hacking/manager.js
//
// The HGW batching botnet - the daemon's core money engine, run OFF-home (exec'd by
// each bnX/daemon.js via ensureHelper) so its ~11GB never competes with the daemon
// for home RAM. globalThis is shared across hosts, so from wherever it lands it
// drives the whole rooted network.
//
// Each loop it: roots every reachable server and scp's the four worker scripts
// (hack/grow/weaken/share) out to them; reconciles the optional faction-rep SHARE
// mode (ns.share on a small, capped slice of RAM - see manageShare / CONFIG.share);
// scores every hackable target and picks the best (targetScore/bestTarget); PREPS
// it to min-security / max-money (prep: weaken -> grow -> weaken); then launches
// timed H/W/G/W batches sized to steal the largest money fraction that still fits
// in free RAM (calcBestFitBatch), landing the four legs batchSpacingMs apart.
// Leftover RAM is filled with a batch against the second-best target when it's
// already prepped.
//
// Uses lib/formulas.js for exact steal-%, grow-thread and batch-timing math at the
// prepped (min-sec/max-money) state when Formulas.exe is present, falling back to
// the approximate ns.* analysis functions otherwise. Publishes
// globalThis.gordHackState for the dashboard. Pass --reset to kill stale worker
// scripts across the network before starting.

import { allServers, root } from "../lib/net.js";
import { CONFIG } from "../lib/config.js";
import * as F from "../lib/formulas.js";

const H = CONFIG.hacking;
const SH = CONFIG.share;
const HOME = CONFIG.paths.home;
const HACK = CONFIG.paths.hack;
const GROW = CONFIG.paths.grow;
const WEAKEN = CONFIG.paths.weaken;
const SHARE = CONFIG.paths.share;

// Cached once at startup — avoids repeated getScriptRam() calls in the sizing hot path
let _hackRam   = H.fallbackRam.hack;
let _growRam   = H.fallbackRam.grow;
let _weakenRam = H.fallbackRam.weaken;
// share.js per-thread RAM: 1.6 (base) + 2.4 (ns.share) = 4.0GB. Real value read
// in main(); this is only the pre-read fallback.
let _shareThreadRam = 4.0;
// Last-published set of share hosts, so we only log on change (see manageShare).
let _lastShareHosts = "";

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

/** @param {NS} ns */
function usableRam(ns, server) {
  const max = ns.getServerMaxRam(server);
  const used = ns.getServerUsedRam(server);

  let reserve = reservedRamFor(server);
  if (server === HOME) reserve += H.reserveHomeRam;

  return Math.max(0, max - used - reserve);
}

/**
 * Hosts the botnet must leave alone, published by the node daemon on the shared
 * globalThis (e.g. a cloud server dedicated to /lib/gang.js). Undefined for
 * nodes with no reservations, in which case nothing is excluded.
 */
function reservedHosts() {
  const r = globalThis.gordReservedHosts;
  return r instanceof Set ? r : new Set(r ?? []);
}

/** @param {NS} ns */
function rootedWorkers(ns) {
  const reserved = reservedHosts();
  return allServers(ns)
    .filter(s => ns.hasRootAccess(s))
    .filter(s => ns.getServerMaxRam(s) > 0)
    .filter(s => !reserved.has(s));
}

// ── Faction-rep sharing (ns.share) ────────────────────────────────────────────
//
// While the daemon is farming faction rep, dedicate a small capped slice of the
// botnet to share.js. Running share.js occupies real RAM (it shows up in each
// host's usedRam), so usableRam() already excludes it - the botnet naturally
// works around the shared portion without any separate reservation. See
// CONFIG.share for the full rationale and the diminishing-returns math.

/** @param {NS} ns - true when the daemon's current action is faction WORK. */
function farmingRep(ns) {
  if (!SH?.enabled) return false;
  const action = globalThis.gordState?.action;
  if (typeof action !== "string") return false;
  return (SH.repActionPrefixes ?? []).some(p => action.startsWith(p));
}

/** @param {NS} ns - hosts the botnet may draw share threads from (not home/reserved). */
function shareEligibleHosts(ns) {
  const reserved = reservedHosts();
  return allServers(ns).filter(
    s => s !== HOME && ns.hasRootAccess(s) && ns.getServerMaxRam(s) > 0 && !reserved.has(s)
  );
}

/**
 * Total share RAM (GB) to dedicate this tick. A fraction of eligible network RAM
 * (the "use a couple, not all" cap), further capped by targetBonus so we never
 * chase the flat tail of the 1 + ln(threads)/25 curve. Returns 0 below the floor.
 * @param {NS} ns @param {string[]} hosts
 */
function shareBudgetRam(ns, hosts) {
  const totalRam = hosts.reduce((sum, h) => sum + ns.getServerMaxRam(h), 0);
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
 * @param {NS} ns @param {number} budgetRam
 */
function planShare(ns, budgetRam) {
  const hosts = shareEligibleHosts(ns).sort(
    (a, b) => ns.getServerMaxRam(b) - ns.getServerMaxRam(a)
  );

  const plan = {};
  let remaining = budgetRam;
  for (const host of hosts) {
    if (Object.keys(plan).length >= SH.maxServers) break;
    if (remaining < _shareThreadRam) break;
    const give = Math.min(ns.getServerMaxRam(host), remaining);
    const threads = Math.floor(give / _shareThreadRam);
    if (threads <= 0) continue;
    plan[host] = threads * _shareThreadRam;
    remaining -= plan[host];
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
 * allocation each tick, so once share.js is launched its RAM shows up in
 * usableRam() and the botnet plans around it.
 *
 * Each host is started at most once (while it has 0 share threads) and left
 * alone thereafter - we accept whatever thread count actually fit rather than
 * re-evicting to chase an exact number, so a host that also runs another helper
 * never thrashes. share stops on a host only when it leaves the plan.
 * @param {NS} ns
 */
function manageShare(ns) {
  const plan = farmingRep(ns) ? planShare(ns, shareBudgetRam(ns, shareEligibleHosts(ns))) : {};

  // Stop share on any host no longer in the plan. Kill by pid (via ns.ps/ns.kill,
  // already used here) rather than ns.scriptKill, so this adds no manager RAM.
  for (const host of allServers(ns)) {
    if (!ns.hasRootAccess(host) || plan[host]) continue;
    for (const p of ns.ps(host)) {
      if (p.filename === SHARE) ns.kill(p.pid);
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
}

/** @param {NS} ns */
function validTargets(ns) {
  const hacking = ns.getHackingLevel();

  return allServers(ns)
    .filter(s => ns.hasRootAccess(s))
    .filter(s => ns.getServerMaxMoney(s) > 0)
    .filter(s => ns.getServerRequiredHackingLevel(s) <= hacking)
    .filter(s => !s.startsWith(H.excludeTargetPrefix));
}

/** @param {NS} ns */
function targetScore(ns, server) {
  const maxMoney = ns.getServerMaxMoney(server);
  if (maxMoney <= 0) return 0;

  // With Formulas, rank by expected steady-state yield at the prepped state a
  // batch actually farms: money x (steal % per thread) x (success chance) per
  // unit cycle time (weakenTime bounds a batch). This picks genuinely richer
  // targets than the current-security heuristic below.
  if (F.hasFormulas(ns)) {
    const { weakenTime } = F.batchTimes(ns, server);
    if (weakenTime <= 0) return 0;
    return (maxMoney * F.hackPercent(ns, server) * F.hackChance(ns, server)) / weakenTime;
  }

  // Fallback (no Formulas.exe): the original heuristic, unchanged.
  const minSec = ns.getServerMinSecurityLevel(server);
  const hackTime = ns.getHackTime(server);
  if (hackTime <= 0) return 0;
  return maxMoney / minSec / hackTime;
}

/** @param {NS} ns */
async function copyScripts(ns) {
  for (const server of rootedWorkers(ns)) {
    if (server !== HOME) {
      await ns.scp([HACK, GROW, WEAKEN], server, HOME);
    }
  }
}

/** @param {NS} ns @param {string} target @param {number} moneyFraction */
function calcBatch(ns, target, moneyFraction) {
  const useFormulas = F.hasFormulas(ns);

  // Steal-% per hack thread and the resulting grow threads, both evaluated at the
  // prepped (min-security, max-money) state a batch actually hits. With Formulas
  // these are exact; without it we keep the original current-state approximations
  // (ns.hackAnalyze reads current security, ns.growthAnalyze ignores it), so
  // behaviour is identical when Formulas.exe is absent.
  const hackPct = useFormulas ? F.hackPercent(ns, target) : ns.hackAnalyze(target);
  const hackThreads = Math.max(1, Math.floor(moneyFraction / hackPct));
  const hackedFraction = Math.min(0.9, hackThreads * hackPct);

  let growThreads;
  if (useFormulas) {
    growThreads = Math.max(1, F.growThreadsToFull(ns, target, 1 - hackedFraction));
  } else {
    const growMultiplier = 1 / Math.max(0.01, 1 - hackedFraction);
    growThreads = Math.max(1, Math.ceil(ns.growthAnalyze(target, growMultiplier)));
  }

  const hackSec = hackThreads * H.securityPerHack;
  const growSec = growThreads * H.securityPerGrow;

  const weaken1Threads = Math.max(1, Math.ceil(hackSec / H.weakenAmount));
  const weaken2Threads = Math.max(1, Math.ceil(growSec / H.weakenAmount));

  const ram =
    hackThreads * _hackRam +
    growThreads * _growRam +
    weaken1Threads * _weakenRam +
    weaken2Threads * _weakenRam;

  // Batch legs run against the prepped server, so with Formulas we time them at
  // min security; ns.get*Time (current security) is the fallback.
  const times = useFormulas
    ? F.batchTimes(ns, target)
    : {
        hackTime: ns.getHackTime(target),
        growTime: ns.getGrowTime(target),
        weakenTime: ns.getWeakenTime(target),
      };

  return {
    target,
    moneyFraction,
    hackThreads,
    growThreads,
    weaken1Threads,
    weaken2Threads,
    ram,
    hackTime: times.hackTime,
    growTime: times.growTime,
    weakenTime: times.weakenTime,
  };
}

/** @param {NS} ns @param {string} target */
function calcBestFitBatch(ns, target) {
  const bestFreeRam = rootedWorkers(ns)
    .reduce((sum, s) => sum + usableRam(ns, s), 0);

  const fractions = H.moneyFractions;

  for (const fraction of fractions) {
    const batch = calcBatch(ns, target, fraction);
    if (batch.ram <= bestFreeRam) return batch;
  }

  // Nothing fits - fall back to the smallest bite we're willing to take.
  return calcBatch(ns, target, fractions[fractions.length - 1]);
}

/** @param {NS} ns */
function launchOnWorkers(ns, script, threads, target, delay, tag) {
  if (threads <= 0) return true; // nothing to do

  const ram = ns.getScriptRam(script);
  let remaining = threads;

  const workers = rootedWorkers(ns)
    .sort((a, b) => usableRam(ns, b) - usableRam(ns, a));

  for (const host of workers) {
    if (remaining <= 0) break;
    const slots = Math.floor(usableRam(ns, host) / ram);
    const use = Math.min(slots, remaining);
    if (use <= 0) continue;

    const pid = ns.exec(
      script,
      host,
      use,
      target,
      Math.max(0, Math.floor(delay)),
      tag,
      performance.now(),
    );

    if (pid !== 0) remaining -= use;
  }

  return remaining === 0;
}

/** @param {NS} ns */
async function prep(ns, target) {
  while (true) {
    const money = ns.getServerMoneyAvailable(target);
    const maxMoney = ns.getServerMaxMoney(target);
    const sec = ns.getServerSecurityLevel(target);
    const minSec = ns.getServerMinSecurityLevel(target);

    const needsWeaken = sec > minSec + H.prepSecurityTolerance;
    const needsGrow = money < maxMoney * H.prepMoneyThreshold;

    if (!needsWeaken && !needsGrow) return;

    const workers = rootedWorkers(ns);

    // Calculate exactly how many weaken threads are needed to fix security,
    // then give all remaining threads to grow.
    const totalFreeRam = workers.reduce((sum, h) => sum + usableRam(ns, h), 0);
    const totalThreads = Math.floor(totalFreeRam / _weakenRam); // same RAM cost for both
    const exactWeakenNeeded = needsWeaken
      ? Math.ceil((sec - minSec) / H.weakenAmount)
      : 0;
    const weakenAlloc = Math.min(exactWeakenNeeded, totalThreads);
    const growAlloc   = needsGrow ? Math.max(0, totalThreads - weakenAlloc) : 0;

    let weakenRemaining = weakenAlloc;
    let growRemaining   = growAlloc;

    for (const host of workers) {
      const free = usableRam(ns, host);
      const slots = Math.floor(free / _weakenRam);
      if (slots <= 0) continue;

      const wThreads = Math.min(weakenRemaining, slots);
      const gThreads = Math.min(growRemaining, slots - wThreads);

      if (wThreads > 0) {
        ns.exec(WEAKEN, host, wThreads, target, 0, "prep", performance.now());
        weakenRemaining -= wThreads;
      }
      if (gThreads > 0) {
        ns.exec(GROW, host, gThreads, target, 0, "prep", performance.now());
        growRemaining -= gThreads;
      }
    }

    const wait = needsWeaken ? ns.getWeakenTime(target) : ns.getGrowTime(target);
    globalThis.gordHackState = {
      ...(globalThis.gordHackState ?? {}),
      mode: "Prepping",
      target,
      moneyPercent: money / maxMoney,
      security: sec,
      minSecurity: minSec,
    };
    await ns.sleep(wait + H.prepSleepPadMs);
  }
}

/** @param {NS} ns */
function launchBatch(ns, batch, batchId) {
  const {
    target,
    hackThreads,
    growThreads,
    weaken1Threads,
    weaken2Threads,
    hackTime,
    growTime,
    weakenTime,
  } = batch;

  // Check total available RAM across all workers before committing
  const totalFreeRam = rootedWorkers(ns).reduce((sum, s) => sum + usableRam(ns, s), 0);
  if (totalFreeRam < batch.ram) return false;

  // Target landing order: H, W1, G, W2 at t+0, t+200, t+400, t+600
  const hackDelay    = Math.max(0, weakenTime - hackTime   - H.batchSpacingMs * 2);
  const weaken1Delay = 0;                                               // lands at weakenTime
  const growDelay    = Math.max(0, weakenTime - growTime   + H.batchSpacingMs * 2);
  const weaken2Delay = H.batchSpacingMs * 3;                            // lands last at weakenTime+600

  const tag = `batch-${batchId}`;

  const ok =
    launchOnWorkers(ns, HACK,   hackThreads,    target, hackDelay,    tag) &&
    launchOnWorkers(ns, WEAKEN, weaken1Threads, target, weaken1Delay, tag) &&
    launchOnWorkers(ns, GROW,   growThreads,    target, growDelay,    tag) &&
    launchOnWorkers(ns, WEAKEN, weaken2Threads, target, weaken2Delay, tag);

  if (ok) {
    globalThis.gordHackState = {
      ...(globalThis.gordHackState ?? {}),
      mode: "Batching",
      target,
      batchId,
      hackThreads,
      growThreads,
      weaken1Threads,
      weaken2Threads,
      ram: batch.ram,
    };
  }
  return ok;
}

/** @param {NS} ns */
function killOldHackScripts(ns) {
  for (const server of rootedWorkers(ns)) {
    for (const p of ns.ps(server)) {
      if ([HACK, GROW, WEAKEN].includes(p.filename)) {
        ns.kill(p.pid);
      }
    }
  }
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  // ns.ui.openTail();

  _hackRam   = ns.getScriptRam(HACK);
  _growRam   = ns.getScriptRam(GROW);
  _weakenRam = ns.getScriptRam(WEAKEN);
  _shareThreadRam = ns.getScriptRam(SHARE) || _shareThreadRam;

  const reset = ns.args.includes("--reset");
  if (reset) killOldHackScripts(ns);

  let batchId = 0;
  let currentTarget = "";

  while (true) {
    for (const server of allServers(ns)) {
      try {
        root(ns, server);
      } catch {}
    }

    await copyScripts(ns);

    // Reconcile faction-rep sharing BEFORE sizing batches: share.js occupies
    // real RAM, so once it's launched usableRam() already reflects it and the
    // botnet plans around the shared slice. Guarded: share is an optional side
    // mode and must NEVER be able to stop the core hacking loop (e.g. if it hits
    // a stale config on a runner). On error, log and keep hacking.
    try {
      manageShare(ns);
    } catch (e) {
      ns.print(`[share] disabled this tick (error): ${String(e)}`);
    }

    const sortedTargets = validTargets(ns);
    sortedTargets.sort((a, b) => targetScore(ns, b) - targetScore(ns, a));
    const target = sortedTargets[0] ?? H.defaultTarget;

    if (target !== currentTarget) {
      currentTarget = target;
      globalThis.gordHackState = {
        ...(globalThis.gordHackState ?? {}),
        mode: "Target Changed",
        target,
      };
    }

    await prep(ns, target);

    const batch = calcBestFitBatch(ns, target);
    const launched = launchBatch(ns, batch, batchId++);

    if (!launched) {
      globalThis.gordHackState = {
        ...(globalThis.gordHackState ?? {}),
        mode: "Waiting for RAM",
        target,
        ramNeeded: batch.ram,
      };
      await ns.sleep(H.waitForRamMs);
      continue;
    }

    // fill leftover RAM with a second-best target
    const secondTarget = sortedTargets.find(t => t !== target);

    if (secondTarget) {
      const secondBatch = calcBestFitBatch(ns, secondTarget);
      const totalFreeRam = rootedWorkers(ns).reduce((sum, s) => sum + usableRam(ns, s), 0);
      if (totalFreeRam >= secondBatch.ram) {
        // Prep check: only batch if second target is already in good shape
        const money2    = ns.getServerMoneyAvailable(secondTarget);
        const maxMoney2 = ns.getServerMaxMoney(secondTarget);
        const sec2      = ns.getServerSecurityLevel(secondTarget);
        const minSec2   = ns.getServerMinSecurityLevel(secondTarget);
        const ready2    = sec2 <= minSec2 + H.prepSecurityTolerance && money2 >= maxMoney2 * H.prepMoneyThreshold;
        if (ready2) {
          launchBatch(ns, secondBatch, batchId++);
        }
      }
    }

    await ns.sleep(H.batchSpacingMs);
  }
}