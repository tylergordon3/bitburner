// lib/stanek.js
//
// Stanek's Gift manager, run OFF-home by the daemon wherever the gift exists
// (BN13, or any node with Source-File 13) and config wants it (stanek.enabled).
// Four jobs, in the order they matter:
//
//   1. ACCEPT the gift. Possible only while the player holds no augmentation
//      other than NeuroFlux Governor (bitburner-src CotMG/Helper.tsx
//      canAcceptStaneksGift counts installed AND queued ones), so it is the first
//      thing this does, and the answer is published at once: the daemons hold
//      their first aug purchase and their Bladeburner join (SF7.3 hands out The
//      Blade's Simulacrum on joining) until globalThis.gordStanekState says the
//      question is settled FOR THIS BITNODE (lib/stanek-logic.js giftGate).
//      early/stanek-boot.js asks the same question earlier, from 4.6GB; this is
//      the same idempotent call, so whichever runs first wins and the other
//      finds it done.
//   2. LAY OUT the grid when it is empty - fragments chosen by the node's
//      priority table, boosters packed against them (planLayout). A layout that
//      already carries charge is never cleared (re-placing a fragment resets
//      it) unless config says so; one that differs from the plan but has no
//      charge - the moment after an aug install - is replaced for free.
//   3. CHARGE it: keep hacking/charge.js workers on a configured share of the
//      botnet's RAM, as few and as LARGE as possible, because a fragment's bonus
//      is ln() of the biggest single charge it ever had and only the 0.07th
//      power of how many (see lib/stanek-logic.js for the formulas).
//   4. PUBLISH globalThis.gordStanekState for the HUD (ui/stanek.js) and the
//      daemons, stamped with updatedAt.
//
// SHARING RAM WITH THE BATCHER. Running workers need no arrangement at all:
// hacking/manager.js plans from each host's free RAM, and a worker's RAM is not
// free. The only problem is getting hold of a host the batcher has already
// filled, since its legs are replaced as fast as they land. Killing them is out
// (an orphaned hack or grow leg corrupts its batch), so this publishes, per
// planned host, the GB it is still waiting for - `holds` in the state - and the
// daemon folds those into globalThis.gordReservedRam, the map the manager
// already keeps free of new legs (reservedRamFor). The host then drains within
// one weaken-time; meanwhile whatever comes free is taken as interim workers,
// and the moment the whole plan fits they are merged into one process
// (tendHost). A hold lasts only until its worker is running.
//   The daemon rebuilds gordReservedRam from scratch every tick
//   (lib/daemon-lib.js ensureGangManager), which is why the merge has to happen
//   THERE, right after that - mergeHolds(globalThis.gordReservedRam,
//   chargeHolds(state, now, staleMs)) in the reserveHosts hook. This helper
//   also writes its holds into the map itself each tick, so it still converges
//   (more slowly, in top-ups) under a daemon that has no such hook.
// It never touches a host in globalThis.gordReservedHosts, nor a hacknet server
// (a script there cuts the hash rate), and pserv upgrades carry on underneath
// it: an upgraded host simply gets a bigger worker on the next plan.
//
// RAM: 18.45GB =
//    1.60 base
//    2.00 stanek.acceptGift
//    5.00 stanek.activeFragments       (charge state; the one call per tick)
//    5.00 stanek.placeFragment
//    0.80 stanek.giftWidth + giftHeight (0.4 each)
//    0.00 stanek.fragmentDefinitions, stanek.clearGift
//    1.30 exec    0.50 kill    0.60 scp    0.20 ps    0.20 scan
//    0.10 getScriptRam    0.05 x3 hasRootAccess / getServerMaxRam / getServerUsedRam
//    1.00 getResetInfo  (lastNodeReset - the stamp that ties "accepted" to THIS node)
// Left out on purpose: canPlaceFragment (0.5 - placeFragment answers the same
// question by returning false, and layoutProblems checks the plan beforehand),
// getFragment (2) and removeFragment (0.15 - a layout is replaced whole), and
// getServer (2) for the core count: the scheduler does not need it, home's core
// bonus simply makes its charges bigger than planned.
//
// It cannot die: every tick is wrapped in try/catch, a failed tick backs off and
// starts again from the game's own state (nothing here is remembered that the
// next tick cannot rebuild), and the two outcomes that end it - config says off,
// or the game refused the gift for good - are published before it exits.
//
// Args (from lib/daemon-core.js):
//   [0] the current BitNode number - the profile and RAM share are per node
//       (lib/config.js). Optional: without it getResetInfo's answer is used.

import { forNode } from "./config.js";
import { emitEvent } from "./events.js";
import { allServers } from "./net.js";
import { reservedHosts } from "./ns-utils.js";
import {
  boostsOf,
  cellsOf,
  chargeFraction,
  chargeRotation,
  giftGate,
  holdThreads,
  isBooster,
  layoutDecision,
  layoutKey,
  layoutProblems,
  mergeHolds,
  planChargeHosts,
  planLayout,
  tendHost,
  typeLabel,
  weightOf,
} from "./stanek-logic.js";

/** ns.ps reports "hacking/charge.js", config holds "/hacking/charge.js". */
function bare(path) {
  const s = String(path);
  return s.startsWith("/") ? s.slice(1) : s;
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  // Resolved through forNode, not read off CONFIG: the profile and the RAM
  // fractions are exactly what a BITNODE entry overrides.
  const reset = ns.getResetInfo();
  const fromArg = Number(ns.args[0]);
  const node = Number.isFinite(fromArg) && fromArg > 0 ? fromArg : reset.currentNode;
  const cfg = forNode(node);
  const S = cfg.stanek;
  if (!S.enabled) {
    ns.tprint("stanek.js: disabled in config (stanek.enabled) - exiting.");
    return;
  }

  // (Named `tally`, not `run`: the RAM analyser bills by identifier NAME.)
  const tally = {
    status: "starting",
    gate: "pending",
    width: 0,
    height: 0,
    fragments: /** @type {any[]} */ ([]),
    layout: { value: 0, planned: 0, pending: false, note: "", failed: 0 },
    ram: {
      fraction: 0, fresh: false, threadRam: 2, budget: 0, inUse: 0,
      threads: 0, processes: 0, largest: 0, hosts: /** @type {any[]} */ ([]),
    },
    holds: /** @type {Record<string, number>} */ ({}),
    errors: 0,
    lastError: "",
    lastJournalAt: Date.now(),
    startedAt: Date.now(),
  };
  // Everything a tick needs that is not on the tally: config, and the few
  // things remembered between ticks (all of them rebuildable from the game).
  const env = {
    node,
    resetAt: reset.lastNodeReset,
    cfg,
    S,
    home: cfg.paths.home,
    worker: cfg.paths.stanekCharge,
    priorities: /** @type {Record<string, number>} */ (S.profiles?.[S.profile] ?? {}),
    threadRam: 2,
    // Per-thread RAM of the batcher's legs, by ns.ps filename: what on a host
    // will DRAIN by itself, as opposed to what is there to stay.
    legRam: /** @type {Record<string, number>} */ ({}),
    // The layout search's answer, per grid size.
    layoutFor: "",
    plan: /** @type {ReturnType<typeof planLayout> | null} */ (null),
    defs: /** @type {any[]} */ ([]),
    attempted: "",
    // The RAM plan: host -> threads, redone every planEveryMs.
    planAt: 0,
    plannedFor: "",
    hostPlan: /** @type {Map<string, number>} */ (new Map()),
    workerHosts: /** @type {Set<string>} */ (new Set()),
    rotation: /** @type {number[]} */ ([]),
    copied: /** @type {Set<string>} */ (new Set()),
    serial: 0,
  };

  // ── 1. Accept ──────────────────────────────────────────────────────────────
  // acceptGift returns true when the gift is (now, or already) installed and
  // false when the game will not give it; it does not throw. Either way the
  // answer is final for this BitNode, and the daemon is waiting on it.
  const known = giftGate(globalThis.gordStanekState, env.resetAt);
  let accepted = false;
  try {
    accepted = ns.stanek.acceptGift();
  } catch (e) {
    tally.lastError = String(e).slice(0, 160);
    ns.print(`ERROR: acceptGift threw: ${String(e)}`);
  }
  tally.gate = accepted ? "accepted" : "refused";
  if (!accepted) {
    tally.status = "the gift cannot be accepted in this BitNode (an augmentation other than NeuroFlux Governor is already owned, or there is no access to it)";
    publish(env, tally);
    ns.tprint(`WARN: stanek.js: ${tally.status} - exiting.`);
    if (known !== "refused") emitEvent("[!] Stanek's Gift was refused - an augmentation is already owned", "sys");
    return;
  }
  if (known !== "accepted") {
    ns.tprint("stanek.js: Stanek's Gift accepted - joined the Church of the Machine God.");
    emitEvent("[join] Accepted Stanek's Gift (Church of the Machine God)", "faction", {
      factions: ["Church of the Machine God"],
    });
  }
  tally.status = "accepted";
  publish(env, tally);

  if (Object.keys(env.priorities).length === 0) {
    ns.tprint(`WARN: stanek.js: no priority table "${S.profile}" under stanek.profiles - nothing will be placed.`);
  }
  try {
    env.threadRam = ns.getScriptRam(env.worker, env.home) || 2;
    // By string key on purpose: written as cfg.paths.hack / .grow / .weaken the
    // three property names would be billed as ns.hack, ns.grow and ns.weaken
    // (0.4GB for functions this script never calls).
    for (const leg of ["hack", "grow", "weaken"]) {
      const file = cfg.paths[leg];
      env.legRam[bare(file)] = ns.getScriptRam(file, env.home) || 1.75;
    }
  } catch (e) {
    ns.print(`WARN: could not read script RAM: ${String(e)}`);
  }
  tally.ram.threadRam = env.threadRam;

  // ── 2-4. Lay out, charge, publish - for as long as the node lasts ──────────
  while (true) {
    try {
      tick(ns, env, tally);
    } catch (e) {
      // A host deleted between the survey and the launch, a human rearranging
      // the gift mid-tick, an API change: note it, back off, look again.
      tally.errors++;
      tally.lastError = String(e).slice(0, 160);
      tally.status = `error: ${tally.lastError}`;
      ns.print(`ERROR: ${String(e)}`);
      publish(env, tally);
      await ns.sleep(S.errorBackoffMs);
    }
    publish(env, tally);
    await ns.sleep(S.tickMs);
  }
}

/** One pass: layout, plan (on its own slower clock), workers, state. @param {NS} ns */
function tick(ns, env, tally) {
  const { S } = env;
  const width = ns.stanek.giftWidth();
  const height = ns.stanek.giftHeight();
  tally.width = width;
  tally.height = height;

  const active = maintainLayout(ns, env, tally, width, height);

  // The host survey, the RAM plan and the charge rotation: every planEveryMs,
  // and at once when what is on the gift changed (ours or a human's doing).
  const now = Date.now();
  const key = layoutKey(active);
  if (now - env.planAt >= S.planEveryMs || key !== env.plannedFor) {
    replan(ns, env, tally, active);
    env.planAt = now;
    env.plannedFor = key;
  }
  // Keep the rotation's stamp fresh: workers fall back to their launch
  // arguments once it is a minute old (a dead helper's list is not followed).
  globalThis.gordStanekRotation = { at: now, list: env.rotation };

  tendWorkers(ns, env, tally);
  describe(env, tally, active);
  journal(ns, env, tally);
}

/**
 * Lay the gift out if it should be (lib/stanek-logic.js layoutDecision), and
 * return what is on it afterwards.
 * @param {NS} ns
 */
function maintainLayout(ns, env, tally, width, height) {
  const { S } = env;
  const active = ns.stanek.activeFragments();

  // The search runs once per grid size per run of this script (~70ms); its
  // answer is deterministic, so a restart recomputes the same layout and
  // recognises it on the gift.
  const size = `${width}x${height}`;
  if (env.layoutFor !== size || !env.plan) {
    env.defs = ns.stanek.fragmentDefinitions();
    env.plan = planLayout(env.defs, width, height, { ...S.layout, priorities: env.priorities });
    env.layoutFor = size;
    ns.print(`Planned a ${size} layout: ${env.plan.stats} fragments + ${env.plan.boosters} boosters, ` +
      `${env.plan.cellsUsed}/${env.plan.cells} cells, value ${env.plan.value.toFixed(1)}.`);
  }
  const plan = env.plan;

  const decision = layoutDecision(active, plan.placements, S.layout);
  tally.layout = {
    value: plan.value,
    planned: plan.placements.length,
    pending: decision.pending,
    note: decision.reason,
    failed: tally.layout.failed,
  };
  if (decision.action !== "apply") return active;

  // One attempt per (what is there, what is wanted). If the game refuses part
  // of a plan the next tick would otherwise clear and re-place it for ever.
  // (`tried`, not `attempt`: that identifier is billed as codingcontract.attempt, 10GB.)
  const tried = `${layoutKey(active)}>${layoutKey(plan.placements)}`;
  if (env.attempted === tried) {
    tally.layout.note = "the game refused part of the planned layout - keeping what it took";
    return active;
  }
  env.attempted = tried;

  const problems = layoutProblems(plan.placements, env.defs, width, height);
  if (problems.length > 0) {
    // Never reached unless the packer is wrong; refuse to clear a gift for it.
    tally.layout.note = `planned layout is invalid: ${problems[0]}`;
    ns.print(`ERROR: ${tally.layout.note}`);
    return active;
  }

  ns.stanek.clearGift();
  let failed = 0;
  for (const p of plan.placements) {
    if (!ns.stanek.placeFragment(p.x, p.y, p.rotation, p.id)) {
      failed++;
      ns.print(`WARN: the game refused fragment ${p.id} at ${p.x},${p.y} rotation ${p.rotation}`);
    }
  }
  tally.layout.failed = failed;
  tally.layout.note = decision.reason;
  const line = `Laid out Stanek's Gift (${size}, "${S.profile}"): ${plan.stats} fragments + ${plan.boosters} boosters` +
    (failed ? `, ${failed} refused by the game` : "");
  ns.print(line);
  emitEvent(`[stanek] ${line}`, failed ? "sys" : "event");
  return ns.stanek.activeFragments();
}

/**
 * What one host holds right now, split into what is OURS, what will DRAIN by
 * itself (the batcher's hack/grow/weaken legs) and what is there to STAY
 * (the daemon, helpers, share threads - `fixed`). Throws if the host is gone.
 * @param {NS} ns
 */
function hostView(ns, env, host) {
  const max = ns.getServerMaxRam(host);
  const used = ns.getServerUsedRam(host);
  const worker = bare(env.worker);
  let mine = 0;
  let legs = 0;
  const pids = [];
  for (const p of ns.ps(host)) {
    const file = bare(p.filename);
    if (file === worker) {
      mine += p.threads;
      pids.push(p.pid);
    } else if (env.legRam[file]) {
      legs += p.threads * env.legRam[file];
    }
  }
  // On home, what the batcher itself keeps free plus our own margin; the
  // margin is `extra`, and has to be part of any hold (see tendWorkers).
  const extra = host === env.home ? env.S.homeReserveRam : 0;
  const reserve = host === env.home ? extra + env.cfg.hacking.reserveHomeRam : 0;
  const fixed = Math.max(0, used - mine * env.threadRam - legs);
  return { host, max, used, mine, pids, fixed, reserve, extra };
}

/**
 * Whether home may hold a charge worker right now: config allows it AND a node
 * daemon is ticking (it stamps globalThis.gordState every tick).
 *
 * Without a daemon, home belongs to early/driver.js. This helper runs off-home
 * and so survives the `killall; run /early/driver.js` restart; a worker it put
 * back on home would sit in exactly the RAM the driver needs free to launch the
 * daemon - and unlike the batcher's legs, which the driver kills before it
 * tries, nothing would ever move it. So when the daemon's stamp goes stale the
 * home worker is stopped, and home only rejoins the plan once a daemon is back.
 */
function homeAllowed(env) {
  if (!env.S.useHome) return false;
  const at = globalThis.gordState?.updatedAt ?? 0;
  // Four ticks of slack: a daemon tick can be held up by a long decision.
  return Date.now() - at <= env.cfg.daemon.tickMs * 4;
}

/**
 * Survey the network and decide which hosts the workers should hold, and what
 * they should charge in which order.
 * @param {NS} ns
 */
function replan(ns, env, tally, active) {
  const { S, cfg } = env;
  const reserved = reservedHosts();
  const views = [];
  for (const host of allServers(ns)) {
    try {
      if (!ns.hasRootAccess(host)) continue;
      const view = hostView(ns, env, host);
      if (view.max > 0) views.push(view);
    } catch { /* deleted between the scan and the read - gone next survey too */ }
  }

  const eligible = views.filter(v =>
    !reserved.has(v.host) &&
    !v.host.startsWith(cfg.hacking.excludeTargetPrefix) &&
    (v.host !== env.home || homeAllowed(env)));
  // (`quota`, not `share`: an identifier of that name is billed as ns.share.)
  const quota = chargeFraction(active, S);
  const plan = planChargeHosts(
    eligible.map(v => ({ host: v.host, max: v.max, reserve: v.reserve + v.fixed })),
    { fraction: quota.fraction, threadRam: env.threadRam, maxHosts: S.maxHosts, minThreads: S.minThreads, maxRam: S.maxRam },
  );
  env.hostPlan = new Map(plan.map(p => [p.host, p.threads]));
  // Every host with a worker of ours on it, planned or not - including ones a
  // previous run of this script left behind, which tendWorkers then stops.
  env.workerHosts = new Set(views.filter(v => v.mine > 0).map(v => v.host));

  const largest = plan.reduce((m, p) => Math.max(m, p.threads), 0);
  const chargeable = active.filter(f => !isBooster(f)).length;
  env.rotation = chargeRotation(active, largest || 1, {
    priorities: env.priorities,
    extra: Math.round(S.rotationExtra * chargeable),
  });

  tally.ram.fraction = quota.fraction;
  tally.ram.fresh = quota.fresh;
  tally.ram.budget = plan.reduce((sum, p) => sum + p.ram, 0);
}

/**
 * Bring every planned host's workers to plan, stop the ones on hosts that left
 * it, and work out what is still being waited for (the holds).
 * @param {NS} ns
 */
function tendWorkers(ns, env, tally) {
  const { S } = env;
  const holds = /** @type {Record<string, number>} */ ({});
  const rows = [];
  for (const host of new Set([...env.hostPlan.keys(), ...env.workerHosts])) {
    let view;
    try {
      view = hostView(ns, env, host);
    } catch {
      env.workerHosts.delete(host); // the host is gone, and its workers with it
      continue;
    }
    const room = Math.floor(Math.max(0, view.max - view.reserve - view.fixed) / env.threadRam);
    // Nothing chargeable on the gift = nothing for a worker to do; and home is
    // given back the moment no daemon is ticking (checked every tick, not just
    // when the plan is redone - see homeAllowed).
    const usable = env.rotation.length > 0 && (host !== env.home || homeAllowed(env));
    const want = usable ? Math.min(env.hostPlan.get(host) ?? 0, room) : 0;
    const freeThreads = Math.floor(Math.max(0, view.max - view.used - view.reserve) / env.threadRam);
    const step = tendHost(
      { want, have: view.mine, processes: view.pids.length, freeThreads },
      { tolerance: S.resizeTolerance, maxProcesses: S.maxProcessesPerHost, minThreads: S.minThreads },
    );

    let have = view.mine;
    let processes = view.pids.length;
    if (step.action === "stop" || step.action === "restart") {
      for (const pid of view.pids) ns.kill(pid);
      have = 0;
      processes = 0;
    }
    if ((step.action === "restart" || step.action === "topUp") && launch(ns, env, host, step.threads)) {
      have += step.threads;
      processes++;
    }

    if (have > 0) env.workerHosts.add(host);
    else env.workerHosts.delete(host);
    // What the batcher must leave free here for the plan to complete. On home
    // it also has to leave OUR margin, or the room it leaves is never enough.
    const waiting = holdThreads({ want, have, processes }, { tolerance: S.resizeTolerance, minThreads: S.minThreads });
    if (waiting > 0) holds[host] = waiting * env.threadRam + view.extra;
    if (want > 0 || have > 0) rows.push({ host, threads: have, want, processes });
  }

  rows.sort((a, b) => b.threads - a.threads || b.want - a.want || (a.host < b.host ? -1 : 1));
  tally.ram.hosts = rows;
  tally.ram.threads = rows.reduce((sum, r) => sum + r.threads, 0);
  tally.ram.processes = rows.reduce((sum, r) => sum + r.processes, 0);
  tally.ram.inUse = tally.ram.threads * env.threadRam;
  tally.ram.largest = rows.reduce((m, r) => Math.max(m, r.threads), 0);
  tally.holds = holds;
  assertHolds(holds);
}

/**
 * Start one worker process. Its arguments are the rotation as it stands (the
 * fallback it walks if this helper dies) and a serial number, which only makes
 * the argument list unique - the game refuses a second process with the same
 * script and arguments on a host, and a top-up is exactly that.
 * @param {NS} ns
 */
function launch(ns, env, host, threads) {
  if (!(threads > 0) || env.rotation.length === 0) return false;
  if (host !== env.home && !env.copied.has(host)) {
    ns.scp(env.worker, host, env.home);
    env.copied.add(host);
  }
  const pid = ns.exec(env.worker, host, threads, ...env.rotation, `w${Date.now()}-${env.serial++}`);
  if (pid === 0) {
    // Usually the RAM went to something else between the read and the launch.
    // Forget the copy too, in case the file is what is missing.
    env.copied.delete(host);
    ns.print(`WARN: could not start ${threads} charge threads on ${host}`);
    return false;
  }
  return true;
}

/**
 * Put this tick's holds into the botnet's reservation map ourselves. The daemon
 * does the same from the published state right after it rebuilds the map (see
 * the header); this covers the ticks in between and a daemon without the hook.
 * What we wrote last tick is withdrawn first - but only where the entry is
 * still exactly ours, so the gang manager's reservation is never touched. The
 * record of what we wrote lives on globalThis too, not in this process: a
 * restarted helper must be able to withdraw what the previous one asked for,
 * or a hold would outlive the worker it was for.
 */
function assertHolds(holds) {
  let map = globalThis.gordReservedRam;
  if (!map || typeof map !== "object") map = globalThis.gordReservedRam = {};
  for (const [host, gb] of Object.entries(globalThis.gordStanekAsserted ?? {})) {
    if (map[host] === gb) delete map[host];
  }
  mergeHolds(map, holds);
  globalThis.gordStanekAsserted = { ...holds };
}

/** The per-fragment table and the status line. */
function describe(env, tally, active) {
  const boosts = boostsOf(active);
  tally.fragments = active.map((f, i) => ({
    id: f.id,
    type: f.type,
    label: typeLabel(f.type),
    booster: isBooster(f),
    x: f.x,
    y: f.y,
    rotation: f.rotation,
    cells: cellsOf(f, f.shape),
    highestCharge: f.highestCharge,
    numCharge: f.numCharge,
    effect: f.chargedEffect,
    boosters: boosts[i].count,
    weight: weightOf(f, env.priorities),
  }));
  const chargeable = tally.fragments.filter(f => !f.booster).length;
  const waiting = Object.keys(tally.holds).length;
  if (active.length === 0) {
    tally.status = `the gift is empty - ${tally.layout.note || "nothing to place"}`;
  } else if (chargeable === 0) {
    tally.status = "only boosters on the gift - nothing to charge";
  } else if (tally.ram.threads === 0) {
    tally.status = waiting ? `waiting for RAM on ${waiting} host(s)` : "no RAM planned for charging (stanek.ramFraction)";
  } else {
    tally.status = `charging ${chargeable} fragments with ${tally.ram.processes} worker(s)` +
      (waiting ? `, ${waiting} host(s) still filling` : "") +
      (tally.ram.fresh ? " (fresh gift: burst share)" : "");
  }
}

/** One progress line for the journal, sparingly. @param {NS} ns */
function journal(ns, env, tally) {
  if (Date.now() - tally.lastJournalAt < env.S.journalEveryMs) return;
  tally.lastJournalAt = Date.now();
  const best = tally.fragments
    .filter(f => !f.booster && f.effect > 1)
    .sort((a, b) => b.effect - a.effect)[0];
  if (!best) return;
  emitEvent(`[stanek] ${tally.fragments.filter(f => !f.booster).length} fragments charged on ` +
    `${ns.format.ram(tally.ram.inUse)}; strongest ${best.label} +${((best.effect - 1) * 100).toFixed(1)}%`, "event");
}

/** Publish the state the HUD and the daemons read. */
function publish(env, tally) {
  const stats = tally.fragments.filter(f => !f.booster).length;
  globalThis.gordStanekState = {
    status: tally.status,
    // The gate: see lib/stanek-logic.js giftGate. `resetAt` is what makes it
    // this BitNode's answer rather than the last one's.
    gate: tally.gate,
    accepted: tally.gate === "accepted",
    node: env.node,
    resetAt: env.resetAt,
    source: "manager",
    profile: env.S.profile,
    width: tally.width,
    height: tally.height,
    fragments: tally.fragments,
    placed: tally.fragments.length,
    stats,
    boosters: tally.fragments.length - stats,
    layout: tally.layout,
    ram: tally.ram,
    holds: tally.holds,
    errors: tally.errors,
    lastError: tally.lastError,
    startedAt: tally.startedAt,
    updatedAt: Date.now(),
  };
}
