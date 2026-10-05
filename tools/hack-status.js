// tools/hack-status.js
//
// One-shot botnet diagnostic: is hacking/manager.js running, could it be
// started if it isn't, and what would it target?
//
// Written for the two failure modes that look identical from the HUD - "the
// botnet is doing nothing" - but have opposite causes:
//
//   NOT RUNNING   - nobody launched it (the daemon is down), or nothing has room
//                   for it. The manager is placed off-home by ensureHelper, and
//                   its own worker legs fill every host, so right after it dies
//                   there is genuinely nowhere to put it until those legs land.
//                   The RAM table below says which of the two it is.
//   RUNNING IDLE  - it's alive but its targets can't absorb the fleet, or it's
//                   stuck prepping/draining. The state and target table say so.
//
// Run it on home (it's a few GB - the target ranking needs the same analysis
// calls the manager makes):
//   run tools/hack-status.js          - the summary
//   run tools/hack-status.js 20       - rank 20 targets instead of 10
//
// Read-only: it launches nothing and kills nothing.

import { CONFIG, forNode } from "../lib/config.js";
import { allServers, sameScript } from "../lib/net.js";
import { reservedHosts } from "../lib/ns-utils.js";
import * as F from "../lib/formulas.js";
import * as B from "../lib/batch-logic.js";

const H = CONFIG.hacking;
const P = CONFIG.paths;
const HOME = P.home;
const WORKERS = [P.hack, P.grow, P.weaken];

/**
 * The manager's own view of one target, mirrored here rather than imported:
 * importing hacking/manager.js would pull its whole ~10GB of Netscript into this
 * tool. The pure parts (preppedScale, planCycle, incomeRate) ARE the manager's,
 * so the numbers below are the ones it ranks by.
 * @param {NS} ns @param {string} target @param {number} ramBudget
 * @param {{hack: number, grow: number, weaken: number}} ramPerThread
 * @param {number} weakenAmount security one weaken thread removes in this node
 */
function describe(ns, target, ramBudget, ramPerThread, weakenAmount) {
  const useFormulas = F.hasFormulas(ns);
  let times, hackPct, growThreadsFor;
  if (useFormulas) {
    times = F.batchTimes(ns, target);
    hackPct = F.hackPercent(ns, target);
    growThreadsFor = (remaining) => F.growThreadsToFull(ns, target, remaining);
  } else {
    // No Formulas.exe: the ns.* readings describe the CURRENT security, so scale
    // them to the prepped one, exactly as the manager's targetMath does.
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

  const planFor = (hackThreads) => B.planBatch({
    hackThreads,
    hackPct,
    growThreadsFor,
    ramPerThread,
    securityPerHack: H.securityPerHack,
    securityPerGrow: H.securityPerGrow,
    weakenAmount,
    maxHackFraction: H.maxHackFraction,
    growPadding: H.growPadding,
  });

  const schedule = B.legSchedule({ ...times, spacing: H.batchSpacingMs, margin: H.launchMarginMs });
  const cycle = B.planCycle({
    totalRam: ramBudget,
    lastLanding: schedule.lastLanding,
    launchInterval: schedule.launchInterval,
    maxDepth: H.maxDepth,
    maxThreads: B.maxHackThreads(hackPct, H.maxHackFraction),
    planFor,
  });
  const maxMoney = ns.getServerMaxMoney(target);
  const income = cycle ? B.incomeRate({ maxMoney, hackChance, plan: cycle.plan, launchInterval: cycle.launchInterval }) : 0;

  // The curve the manager splits the botnet's RAM by (batch-logic allocateRam).
  const points = B.incomeCurve({
    maxMoney,
    hackChance,
    lastLanding: schedule.lastLanding,
    launchInterval: schedule.launchInterval,
    maxDepth: H.maxDepth,
    maxThreads: B.maxHackThreads(hackPct, H.maxHackFraction),
    planFor,
  });

  return { target, maxMoney, cycle, income, weakenTime: times.weakenTime, hackChance, points, minRam: planFor(1)?.ram ?? Infinity };
}

/** @param {NS} ns */
export async function main(ns) {
  const top = Number(ns.args[0] ?? 10);
  const node = ns.getResetInfo().currentNode;
  const daemon = forNode(node).paths.daemon ?? `/bn${node}/daemon.js`;
  const ram = n => ns.format.ram(n);
  const $ = n => `$${ns.format.number(n)}`;

  // Real per-thread worker RAM, read from home like the manager does (the
  // config fallbacks are only used before that read lands).
  const workerRam = {
    hack: ns.getScriptRam(P.hack, HOME) || H.fallbackRam.hack,
    grow: ns.getScriptRam(P.grow, HOME) || H.fallbackRam.grow,
    weaken: ns.getScriptRam(P.weaken, HOME) || H.fallbackRam.weaken,
  };
  // What a weaken thread removes HERE (a BitNode multiplier scales it) - asked
  // of the game, as the manager does.
  const weakenAmount = ns.weakenAnalyze(1) || H.weakenAmount;

  const servers = allServers(ns);
  const rooted = servers.filter(h => ns.hasRootAccess(h));
  const reserved = reservedHosts();

  // ── Who's alive ────────────────────────────────────────────────────────────
  ns.tprint("=".repeat(72));
  const managerHosts = rooted.filter(h => ns.scriptRunning(P.manager, h));
  const daemonUp = ns.scriptRunning(daemon, HOME);
  const driverUp = ns.scriptRunning(P.driver, HOME);
  ns.tprint(`BOTNET | BitNode ${node} | hacking level ${ns.getHackingLevel()} | ` +
    `${F.hasFormulas(ns) ? "Formulas.exe" : "ns.* fallback (no Formulas.exe)"}`);
  ns.tprint(`  ${daemon}: ${daemonUp ? "running" : "NOT RUNNING"}` +
    `${driverUp ? `  |  ${P.driver}: running (still bootstrapping)` : ""}`);
  ns.tprint(`  ${P.manager}: ${managerHosts.length ? `running on ${managerHosts.join(", ")}` : "NOT RUNNING"}`);
  if (!daemonUp && !driverUp) {
    ns.tprint("  -> Nothing is launching helpers. Start it: killall; run /early/driver.js");
  }

  // ── Could it be placed? ────────────────────────────────────────────────────
  const need = ns.getScriptRam(P.manager, HOME);
  const rows = [];
  let capacity = 0;
  let free = 0;
  for (const host of rooted) {
    const max = ns.getServerMaxRam(host);
    if (max <= 0) continue;
    const used = ns.getServerUsedRam(host);
    const headroom = host === HOME ? CONFIG.helpers.homeHeadroom : 0;
    const isReserved = reserved.has(host);
    rows.push({ host, max, used, spare: max - used - headroom, isReserved });
    if (!isReserved) {
      capacity += max;
      free += Math.max(0, max - used - (host === HOME ? H.reserveHomeRam : 0));
    }
  }
  rows.sort((a, b) => b.spare - a.spare);
  const fits = rows.filter(r => !r.isReserved && r.spare >= need);

  ns.tprint("-".repeat(72));
  ns.tprint(`Placement: ${P.manager} needs ${ram(need)}; ${fits.length} host(s) have room` +
    `${fits.length ? ` (roomiest ${fits[0].host}, ${ram(fits[0].spare)})` : ""}`);
  if (!managerHosts.length && !fits.length) {
    ns.tprint("  -> Nowhere to put it. Its own worker legs hold the fleet until they land;");
    ns.tprint("     this clears itself within about one weaken-time. If it doesn't:");
    ns.tprint("     run /tools/kill-helpers.js all, then killall; run /early/driver.js");
  }
  ns.tprint(`Fleet: ${ram(free)} free of ${ram(capacity)} usable` +
    `${reserved.size ? ` | reserved (off-limits): ${[...reserved].join(", ")}` : ""}`);
  for (const r of rows.slice(0, 8)) {
    ns.tprint(`  ${r.host.padEnd(20)} ${ram(r.used).padStart(10)} used of ${ram(r.max).padStart(10)}` +
      `${r.isReserved ? "   [reserved]" : ""}`);
  }

  // ── What the workers are actually doing ────────────────────────────────────
  const byTarget = new Map();
  let legs = 0;
  let legRam = 0;
  const busy = new Set();
  for (const host of rooted) {
    for (const p of ns.ps(host)) {
      if (!WORKERS.some(s => sameScript(p.filename, s))) continue;
      const target = String(p.args[0] ?? "?");
      const entry = byTarget.get(target) ?? { legs: 0, threads: 0 };
      entry.legs++;
      entry.threads += p.threads;
      byTarget.set(target, entry);
      legs++;
      legRam += p.threads * workerRam[sameScript(p.filename, P.hack) ? "hack" : sameScript(p.filename, P.grow) ? "grow" : "weaken"];
      busy.add(host);
    }
  }
  ns.tprint("-".repeat(72));
  ns.tprint(`Worker legs in flight: ${legs} process(es), ~${ram(legRam)}, on ${busy.size} host(s)`);
  for (const [target, e] of [...byTarget.entries()].sort((a, b) => b[1].threads - a[1].threads)) {
    ns.tprint(`  ${target.padEnd(20)} ${String(e.legs).padStart(4)} legs  ${String(e.threads).padStart(7)} threads`);
  }
  if (legs && busy.size < 3) {
    ns.tprint("  -> Only a couple of hosts busy: the targets can't absorb the fleet (see the table below).");
  }

  // ── The manager's own published state ──────────────────────────────────────
  const state = globalThis.gordHackState;
  ns.tprint("-".repeat(72));
  if (!state) {
    ns.tprint("gordHackState: never published (the manager has not completed a tick this session).");
  } else {
    const age = Date.now() - (state.updatedAt ?? 0);
    ns.tprint(`State (${(age / 1000).toFixed(0)}s old${age > 30_000 ? " - STALE, manager not ticking" : ""}): ` +
      `${state.mode} on ${state.target} | ${state.inFlight}/${state.depth} in flight | ` +
      `bite ${((state.fraction ?? 0) * 100).toFixed(2)}% | using ${ram(state.claimedRam ?? 0)} of ${ram(state.capacityRam ?? 0)}`);
    for (const t of (state.targets ?? []).slice(1)) {
      ns.tprint(`  also ${t.target.padEnd(20)} ${t.mode.padEnd(24)} ${t.inFlight}/${t.depth} @ ${((t.fraction ?? 0) * 100).toFixed(2)}%` +
        (t.objective ? `  [${t.objective}]` : ""));
    }
    // A window deeper than maxDepth is the late-game plan (hacking.adaptive),
    // which is held to a budget of worker processes.
    const deepest = Math.max(0, ...(state.targets ?? []).map(t => t.depth ?? 0));
    if (deepest > H.maxDepth || (state.processes ?? 0) > H.adaptive.maxProcesses * 0.9) {
      ns.tprint(`  Late-game plan: windows up to ${deepest} deep, ${state.processes ?? 0} of ` +
        `${H.adaptive.maxProcesses} worker processes in flight (hacking.adaptive).`);
    }
    if (state.stockPush) {
      ns.tprint("  BN8 ranking: the trader's wished servers first ([stock]), then hacking exp ([exp]) - " +
        "the first target's objective is " + `${state.targets?.[0]?.objective ?? "?"}; $/sec below is what the ` +
        "income ranking WOULD pay, which here is nothing.");
    }
  }
  // The trader's wish list, as the manager and the workers will read it.
  const wishes = globalThis.gordStockWishes;
  if (wishes) {
    const age = Date.now() - (wishes.updatedAt ?? 0);
    const fresh = age < H.stockPush.maxAgeMs;
    ns.tprint(`Stock wishes (${(age / 1000).toFixed(0)}s old${fresh ? "" : " - STALE, ignored"}): ` +
      `up [${(wishes.up ?? []).slice(0, 6).join(", ")}${(wishes.up ?? []).length > 6 ? ", ..." : ""}] ` +
      `down [${(wishes.down ?? []).slice(0, 6).join(", ")}${(wishes.down ?? []).length > 6 ? ", ..." : ""}] | ` +
      (wishes.prefer === true ? "PREFERRED: worked ahead of income" : "flag only: grows / hacks on these carry { stock: true }"));
  }

  // ── What it would target, ranked ───────────────────────────────────────────
  const level = ns.getHackingLevel();
  const ranked = [];
  for (const host of rooted) {
    if (host.startsWith(H.excludeTargetPrefix)) continue;
    if (ns.getServerMaxMoney(host) <= 0) continue;
    if (ns.getServerRequiredHackingLevel(host) > level) continue;
    ranked.push(describe(ns, host, capacity, workerRam, weakenAmount));
  }
  // The manager's split of the fleet between them: each gigabyte where it earns
  // most. (Its own split also favours targets it is already working and marks
  // down ones that need a long prep, so the live one can differ at the margin -
  // the State lines above say what it actually chose.)
  // (Named `split`, not `share`: the RAM analyser bills identifiers by name, and
  // a variable called `share` cost this tool ns.share's 2.4GB.)
  const split = new Map(B.allocateRam({
    totalRam: capacity,
    curves: ranked.filter(r => r.points.length).map(r => ({ key: r.target, points: r.points, minRam: r.minRam })),
    maxTargets: H.maxTargets,
    minTargetRam: H.minTargetRam,
  }).map(a => [a.key, a]));
  // Targets with a share first (best earner first), then the rest by what each
  // would earn alone.
  ranked.sort((a, b) =>
    (split.get(b.target)?.income ?? -1) - (split.get(a.target)?.income ?? -1) || b.income - a.income);

  ns.tprint("-".repeat(72));
  ns.tprint(`Targets (top ${Math.min(top, ranked.length)} of ${ranked.length}). "share" is the manager's split of the ` +
    `${ram(capacity)}; the other columns are each target ALONE with all of it:`);
  ns.tprint(`  ${"target".padEnd(20)} ${"share".padStart(10)} ${"$/sec".padStart(10)} ${"bite".padStart(7)} ${"chance".padStart(7)} ` +
    `${"batch".padStart(10)} ${"depth".padStart(6)} ${"would hold".padStart(11)}`);
  for (const r of ranked.slice(0, top)) {
    const hold = r.cycle ? r.cycle.depth * r.cycle.plan.ram : 0;
    ns.tprint(`  ${r.target.padEnd(20)} ${(split.has(r.target) ? ram(split.get(r.target).ram) : "-").padStart(10)} ${$(r.income * 1000).padStart(10)} ` +
      `${(r.cycle ? (r.cycle.plan.hackedFraction * 100).toFixed(1) + "%" : "-").padStart(7)} ` +
      // A chance of 0.0% across the board means the math is being asked about an
      // unrooted server, not that the targets are hard - see lib/formulas.js.
      `${(r.hackChance * 100).toFixed(1) + "%"}`.padStart(7) +
      ` ${(r.cycle ? ram(r.cycle.plan.ram) : "-").padStart(10)} ${String(r.cycle?.depth ?? "-").padStart(6)} ${ram(hold).padStart(11)}`);
  }
  const spread = [...split.values()].reduce((sum, a) => sum + a.ram, 0);
  const earning = [...split.values()].reduce((sum, a) => sum + a.income, 0);
  ns.tprint(`  The ${split.size} with a share hold ~${ram(spread)} of ${ram(capacity)} ` +
    `(${capacity > 0 ? ((spread / capacity) * 100).toFixed(0) : 0}% of the fleet) for ~${$(earning * 1000)}/sec.`);
  ns.tprint("=".repeat(72));
}
