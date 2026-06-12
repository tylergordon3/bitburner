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

/** @param {NS} ns */
function usableRam(ns, server) {
  const max = ns.getServerMaxRam(server);
  const used = ns.getServerUsedRam(server);

  let reserve = 0;
  if (server === "home") reserve = RESERVE_HOME_RAM;

  return Math.max(0, max - used - reserve);
}

/** @param {NS} ns */
function rootedWorkers(ns) {
  return allServers(ns)
    .filter(s => ns.hasRootAccess(s))
    .filter(s => ns.getServerMaxRam(s) > 0);
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
    hackThreads * ns.getScriptRam(HACK) +
    growThreads * ns.getScriptRam(GROW) +
    weaken1Threads * ns.getScriptRam(WEAKEN) +
    weaken2Threads * ns.getScriptRam(WEAKEN);

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

    // AFTER:
    const workers = rootedWorkers(ns);
    const weakenRam = ns.getScriptRam(WEAKEN);
    const growRam = ns.getScriptRam(GROW);

    for (const host of workers) {
      const free = usableRam(ns, host);
      if (needsWeaken && needsGrow) {
        // Split: 30% of threads for weaken, 70% for grow (weaken is faster per thread)
        const totalThreads = Math.floor(free / weakenRam); // weaken and grow have same RAM cost
        const weakenThreads = Math.max(1, Math.floor(totalThreads * 0.3));
        const growThreads = Math.max(0, totalThreads - weakenThreads);
        if (weakenThreads > 0) ns.exec(WEAKEN, host, weakenThreads, target, 0, "prep", performance.now());
        if (growThreads > 0) ns.exec(GROW, host, growThreads, target, 0, "prep", performance.now());
      } else if (needsWeaken) {
        const threads = Math.floor(free / weakenRam);
        if (threads > 0) ns.exec(WEAKEN, host, threads, target, 0, "prep", performance.now());
      } else {
        const threads = Math.floor(free / growRam);
        if (threads > 0) ns.exec(GROW, host, threads, target, 0, "prep", performance.now());
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

  const hackDelay    = Math.max(0, weakenTime - hackTime   - BATCH_SPACING * 3);
  const weaken1Delay = 0;
  const growDelay    = Math.max(0, weakenTime - growTime   - BATCH_SPACING * 1);
  const weaken2Delay = BATCH_SPACING * 2;

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

    const target = bestTarget(ns);

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

    await ns.sleep(BATCH_SPACING);
  }
}