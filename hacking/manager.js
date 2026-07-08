import { allServers, root } from "../lib/net.js";

const HACK = "/hacking/hack.js";
const GROW = "/hacking/grow.js";
const WEAKEN = "/hacking/weaken.js";

const SECURITY_PER_HACK = 0.002;
const SECURITY_PER_GROW = 0.004;
const WEAKEN_AMOUNT = 0.05;

const BATCH_SPACING = 200;
const MONEY_FRACTION = 0.1;
const RESERVE_HOME_RAM = 8;

// Cached once at startup — avoids repeated getScriptRam() calls in the sizing hot path
let _hackRam   = 1.7;
let _growRam   = 1.7;
let _weakenRam = 1.75;

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
  if (server === "home") reserve += RESERVE_HOME_RAM;

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

/** @param {NS} ns */
function validTargets(ns) {
  const hacking = ns.getHackingLevel();

  return allServers(ns)
    .filter(s => ns.hasRootAccess(s))
    .filter(s => ns.getServerMaxMoney(s) > 0)
    .filter(s => ns.getServerRequiredHackingLevel(s) <= hacking)
    .filter(s => !s.startsWith("hacknet-server"));
}

/** @param {NS} ns */
function targetScore(ns, server) {
  const maxMoney = ns.getServerMaxMoney(server);
  const minSec = ns.getServerMinSecurityLevel(server);
  const hackTime = ns.getHackTime(server);

  if (maxMoney <= 0 || hackTime <= 0) return 0;

  return maxMoney / minSec / hackTime;
}

/** @param {NS} ns */
function bestTarget(ns) {
  const targets = validTargets(ns);
  targets.sort((a, b) => targetScore(ns, b) - targetScore(ns, a));
  return targets[0] ?? "n00dles";
}

/** @param {NS} ns */
async function copyScripts(ns) {
  for (const server of rootedWorkers(ns)) {
    if (server !== "home") {
      await ns.scp([HACK, GROW, WEAKEN], server, "home");
    }
  }
}

/** @param {NS} ns @param {string} target @param {number} moneyFraction */
function calcBatch(ns, target, moneyFraction) {
  const hackAnalyze = ns.hackAnalyze(target);
  const hackThreads = Math.max(1, Math.floor(moneyFraction / hackAnalyze));

  const hackedFraction = Math.min(0.9, hackThreads * hackAnalyze);
  const growMultiplier = 1 / Math.max(0.01, 1 - hackedFraction);
  const growThreads = Math.max(1, Math.ceil(ns.growthAnalyze(target, growMultiplier)));

  const hackSec = hackThreads * SECURITY_PER_HACK;
  const growSec = growThreads * SECURITY_PER_GROW;

  const weaken1Threads = Math.max(1, Math.ceil(hackSec / WEAKEN_AMOUNT));
  const weaken2Threads = Math.max(1, Math.ceil(growSec / WEAKEN_AMOUNT));

  const ram =
    hackThreads * _hackRam +
    growThreads * _growRam +
    weaken1Threads * _weakenRam +
    weaken2Threads * _weakenRam;

  return {
    target,
    moneyFraction,
    hackThreads,
    growThreads,
    weaken1Threads,
    weaken2Threads,
    ram,
    hackTime: ns.getHackTime(target),
    growTime: ns.getGrowTime(target),
    weakenTime: ns.getWeakenTime(target),
  };
}

/** @param {NS} ns @param {string} target */
function calcBestFitBatch(ns, target) {
  const bestFreeRam = rootedWorkers(ns)
    .reduce((sum, s) => sum + usableRam(ns, s), 0);

  const fractions = [
    0.10,
    0.05,
    0.025,
    0.01,
    0.005,
    0.0025,
    0.001,
  ];

  for (const fraction of fractions) {
    const batch = calcBatch(ns, target, fraction);
    if (batch.ram <= bestFreeRam) return batch;
  }

  return calcBatch(ns, target, 0.001);
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

    const needsWeaken = sec > minSec + 5;
    const needsGrow = money < maxMoney * 0.95;

    if (!needsWeaken && !needsGrow) return;

    const workers = rootedWorkers(ns);

    // Calculate exactly how many weaken threads are needed to fix security,
    // then give all remaining threads to grow.
    const totalFreeRam = workers.reduce((sum, h) => sum + usableRam(ns, h), 0);
    const totalThreads = Math.floor(totalFreeRam / _weakenRam); // same RAM cost for both
    const exactWeakenNeeded = needsWeaken
      ? Math.ceil((sec - minSec) / WEAKEN_AMOUNT)
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
    await ns.sleep(wait + 1_000);
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
  const hackDelay    = Math.max(0, weakenTime - hackTime   - BATCH_SPACING * 2);
  const weaken1Delay = 0;                                               // lands at weakenTime
  const growDelay    = Math.max(0, weakenTime - growTime   + BATCH_SPACING * 2);
  const weaken2Delay = BATCH_SPACING * 3;                               // lands last at weakenTime+600

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

    const sortedTargets = validTargets(ns);
    sortedTargets.sort((a, b) => targetScore(ns, b) - targetScore(ns, a));
    const target = sortedTargets[0] ?? "n00dles";

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
      await ns.sleep(2_000);
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
        const ready2    = sec2 <= minSec2 + 5 && money2 >= maxMoney2 * 0.95;
        if (ready2) {
          launchBatch(ns, secondBatch, batchId++);
        }
      }
    }

    await ns.sleep(BATCH_SPACING);
  }
}