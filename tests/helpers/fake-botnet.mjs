// tests/helpers/fake-botnet.mjs
//
// A fake `ns` + model world for driving hacking/manager.js's exported step()
// under Node: a couple of worker hosts, two targets whose money, security and
// leg durations respond to hack/grow/weaken landings the way the game's do (in
// shape, not in exact constants), RAM accounting that refuses over-commits, and
// a clock the tests advance by hand. Optionally a fake ns.formulas so the
// Formulas.exe path in lib/formulas.js (the one that actually runs in-game) is
// exercised as well as the ns.* fallback.
//
// Faithful in one more way that matters: like the game, every ns call except
// serverExists THROWS on a hostname that doesn't exist - an aug install deletes
// the purchased fleet out from under a running manager, and that is exactly the
// crash the "worker wiped mid-run" scenario reproduces (deleteServer).
//
// Shared by tests/batcher-sim.test.mjs (fallback path) and
// tests/batcher-sim-formulas.test.mjs (Formulas path); each is its own process
// under `node --test`, which matters because lib/formulas.js caches "Formulas.exe
// is present" permanently once it sees it.

import { step, newSchedulerState, resetCaches } from "../../hacking/manager.js";
import { CONFIG } from "../../lib/config.js";

export const H = CONFIG.hacking;
const RAM = { "/hacking/hack.js": 1.7, "/hacking/grow.js": 1.75, "/hacking/weaken.js": 1.75, "/hacking/share.js": 4 };

/**
 * @param {object} [opts]
 * @param {number} [opts.t1Sec] @param {number} [opts.t1Money]
 * @param {number} [opts.w1Ram] @param {number} [opts.w2Ram]
 * @param {boolean} [opts.formulas] expose a fake ns.formulas + Formulas.exe
 */
/**
 * The n00dles-alikes for a world (see opts.tinyCount). Money varies a little per
 * target so their ranking is deterministic rather than tied.
 * @param {{tinyCount?: number}} opts
 */
function tinyTargets(opts) {
  const out = {};
  for (let i = 0; i < (opts.tinyCount ?? 0); i++) {
    out[`tiny${i + 1}`] = {
      maxRam: 0, maxMoney: 5e7 * (1 - i * 0.1), minSec: 1, sec: 1,
      money: 5e7 * (1 - i * 0.1), reqHack: 1, growth: 3000, speed: 0.05, hackMult: 20,
    };
  }
  return out;
}

export function makeWorld(opts = {}) {
  const world = {
    clock: 0,
    pid: 1,
    jobs: /** @type {any[]} */ ([]),
    servers: {
      home: { maxRam: 64, used: 0 },
      w1: { maxRam: opts.w1Ram ?? 256, used: 0 },
      w2: { maxRam: opts.w2Ram ?? 128, used: 0 },
      t1: { maxRam: 0, maxMoney: 1e9, minSec: 10, sec: opts.t1Sec ?? 10, money: opts.t1Money ?? 1e9, reqHack: 1, growth: 50 },
      t2: { maxRam: 0, maxMoney: 4e8, minSec: 20, sec: 40, money: 4e8 * 0.04, reqHack: 1, growth: 30 },
      // opts.tinyCount adds N n00dles-alikes: little money, but legs land in a
      // twentieth of the time and one hack thread takes 20x the bite - the
      // cheapest dollars on the network, and each able to absorb only a sliver
      // of a big botnet. Opt-in, so they only appear in the scenarios about
      // that; opts.onlyTiny additionally removes t1/t2, modelling the low
      // hacking level where nothing better is in reach.
      ...tinyTargets(opts),
    },
    hackLandings: /** @type {{t: number, moneyFrac: number, secOver: number, target: string}[]} */ ([]),
    stolen: 0,
    execFailures: 0,
    log: /** @type {string[]} */ ([]),
  };

  if (opts.onlyTiny) {
    delete world.servers.t1;
    delete world.servers.t2;
  }

  // Like the game: a deleted server disappears from scan, and every call except
  // serverExists throws on it.
  const neighbours = host => host === "home"
    ? Object.keys(world.servers).filter(s => s !== "home")
    : (world.servers[host] ? ["home"] : []);
  const srvOrThrow = h => {
    const s = world.servers[h];
    if (!s) throw new Error(`Invalid host: '${h}'`);
    return s;
  };
  const target = name => world.servers[name];

  // Models (shape-faithful, not the game's constants). All take a {sec, minSec,
  // money, maxMoney} view so the Formulas fake can evaluate them on a mock server.
  const timeMult = s => (s.speed ?? 1) * (1 + 0.05 * (s.sec - s.minSec));
  const hackTime = s => 10_000 * timeMult(s);
  const growTime = s => 32_000 * timeMult(s);
  const weakenTime = s => 40_000 * timeMult(s);
  const hackPct = s => 0.002 * (s.hackMult ?? 1) * Math.max(0.2, 1 - 0.02 * (s.sec - s.minSec));
  const growPerThread = s => 0.0045 * Math.max(0.2, 1 - 0.02 * (s.sec - s.minSec));
  const growThreadsFor = (s, targetMoney) =>
    Math.log(targetMoney / Math.max(s.money, 1)) / Math.log(1 + growPerThread(s));

  function durationFor(script, s) {
    if (script === "/hacking/hack.js") return hackTime(s);
    if (script === "/hacking/grow.js") return growTime(s);
    return weakenTime(s);
  }

  function land(job) {
    const s = target(job.target);
    if (job.script === "/hacking/hack.js") {
      world.hackLandings.push({ t: world.clock, moneyFrac: s.money / s.maxMoney, secOver: s.sec - s.minSec, target: job.target });
      const stolen = Math.min(s.money, s.money * job.threads * hackPct(s));
      s.money -= stolen;
      world.stolen += stolen;
      s.sec += 0.002 * job.threads;
    } else if (job.script === "/hacking/grow.js") {
      s.money = Math.min(s.maxMoney, Math.max(s.money, 1) * Math.pow(1 + growPerThread(s), job.threads));
      s.sec += 0.004 * job.threads;
    } else {
      s.sec = Math.max(s.minSec, s.sec - 0.05 * job.threads);
    }
  }

  /** Advance the fake clock, starting and landing jobs in time order. */
  function advance(ms) {
    const end = world.clock + ms;
    while (true) {
      let next = null;
      for (const j of world.jobs) {
        const at = j.landAt ?? j.startAt;
        if (at <= end && (next === null || at < (next.landAt ?? next.startAt))) next = j;
      }
      if (!next) break;
      world.clock = next.landAt ?? next.startAt;
      if (next.landAt === undefined) {
        // Duration is computed when the action STARTS (after the delay), at the
        // security of that moment - exactly what ns.hack() does.
        next.landAt = world.clock + durationFor(next.script, target(next.target));
      } else {
        land(next);
        world.servers[next.host].used -= next.ram;
        world.jobs.splice(world.jobs.indexOf(next), 1);
      }
    }
    world.clock = end;
  }

  /**
   * Remove a server the way an aug install removes the purchased fleet: it
   * vanishes from scan, its processes die (their legs never land), and every
   * ns call on its name now throws.
   */
  function deleteServer(name) {
    delete world.servers[name];
    world.jobs = world.jobs.filter(j => j.host !== name);
  }

  // The view lib/formulas.js's mock server presents, mapped onto the model.
  const view = fs => ({
    sec: fs.hackDifficulty, minSec: fs.minDifficulty, money: fs.moneyAvailable, maxMoney: fs.moneyMax,
    // lib/formulas.js builds its mock off mockServer() and only copies the
    // fields the real formulas read, so the fake's extra knobs are looked up
    // from the host it names instead.
    speed: world.servers[fs.hostname]?.speed, hackMult: world.servers[fs.hostname]?.hackMult,
  });

  const ns = {
    args: [],
    disableLog() {},
    print(line) { world.log.push(line); },
    format: { ram: n => `${n.toFixed(2)}GB` },
    scan: host => neighbours(host),
    serverExists: h => !!world.servers[h],
    hasRootAccess: h => { srvOrThrow(h); return true; },
    fileExists: (file) => opts.formulas === true && file === "Formulas.exe",
    getHackingLevel: () => 100,
    getServerMaxRam: h => srvOrThrow(h).maxRam ?? 0,
    getServerUsedRam: h => srvOrThrow(h).used ?? 0,
    getServerMaxMoney: h => srvOrThrow(h).maxMoney ?? 0,
    getServerMoneyAvailable: h => srvOrThrow(h).money ?? 0,
    getServerSecurityLevel: h => srvOrThrow(h).sec ?? 0,
    getServerMinSecurityLevel: h => srvOrThrow(h).minSec ?? 0,
    getServerRequiredHackingLevel: h => srvOrThrow(h).reqHack ?? 9999,
    getServerGrowth: h => srvOrThrow(h).growth ?? 1,
    getServerNumPortsRequired: h => { srvOrThrow(h); return 0; },
    nuke() {}, brutessh() {}, ftpcrack() {}, relaysmtp() {}, httpworm() {}, sqlinject() {},
    getScriptRam: script => RAM[script] ?? 0,
    scp: (files, h) => { srvOrThrow(h); return true; },
    hackAnalyze: h => hackPct(srvOrThrow(h)),
    growthAnalyze: (h, mult) => Math.log(mult) / Math.log(1 + growPerThread(srvOrThrow(h))),
    getHackTime: h => hackTime(srvOrThrow(h)),
    getGrowTime: h => growTime(srvOrThrow(h)),
    getWeakenTime: h => weakenTime(srvOrThrow(h)),
    ps: host => { srvOrThrow(host); return world.jobs.filter(j => j.host === host).map(j => ({ filename: j.script, threads: j.threads, pid: j.pid })); },
    kill(pid) {
      const i = world.jobs.findIndex(j => j.pid === pid);
      if (i < 0) return false;
      world.servers[world.jobs[i].host].used -= world.jobs[i].ram;
      world.jobs.splice(i, 1);
      return true;
    },
    exec(script, host, threads, tgt, delay) {
      const srv = srvOrThrow(host);
      const ram = (RAM[script] ?? 0) * threads;
      if (srv.used + ram > srv.maxRam + 1e-9) { world.execFailures++; return 0; }
      srv.used += ram;
      world.jobs.push({ pid: world.pid, script, host, threads, target: tgt, ram, startAt: world.clock + delay, landAt: undefined });
      return world.pid++;
    },
    getPlayer: () => ({ money: 0, skills: { hacking: 100 } }),
    formulas: {
      // Like the game's: every field defaults to empty/false, INCLUDING
      // hasAdminRights - a mock server is not rooted until the caller says so.
      mockServer: () => ({ hostname: "", moneyMax: 0, moneyAvailable: 0, minDifficulty: 1, hackDifficulty: 1, requiredHackingSkill: 1, serverGrowth: 1, hasAdminRights: false }),
      hacking: {
        hackPercent: fs => hackPct(view(fs)),
        // The game's calculateHackingChance returns 0 outright for a server the
        // player has no root on ("unrooted or unhackable"), and a mock server is
        // unrooted by default. Modelled here because getting that field wrong is
        // invisible - the chance just silently becomes 0 and every target scores
        // nothing.
        hackChance: fs => (fs.hasAdminRights ? 1 : 0),
        growThreads: (fs, _p, targetMoney) => Math.ceil(growThreadsFor(view(fs), targetMoney)),
        hackTime: fs => hackTime(view(fs)),
        growTime: fs => growTime(view(fs)),
        weakenTime: fs => weakenTime(view(fs)),
      },
    },
  };

  return { world, ns, advance, deleteServer };
}

/** Total worker RAM in use across the fake network (home included). */
export function usedRam(world) {
  return Object.entries(world.servers)
    .filter(([, s]) => (s.maxRam ?? 0) > 0)
    .reduce((sum, [, s]) => sum + s.used, 0);
}

/** Distinct hosts currently running at least one worker script. */
export function busyHosts(world) {
  return [...new Set(world.jobs.map(j => j.host))].sort();
}

function freshState() {
  resetCaches();
  delete globalThis.gordReservedHosts;
  delete globalThis.gordReservedRam;
  delete globalThis.gordState;
  return newSchedulerState();
}

/** Drive step() for `ms` of fake time. Returns the scheduler state and per-tick modes. */
export function run(world, ns, advance, ms) {
  const s = freshState();
  const modes = [];
  let inFlightMax = 0;
  const ticks = Math.floor(ms / H.batchSpacingMs);
  for (let i = 0; i < ticks; i++) {
    modes.push(step(ns, s, world.clock));
    inFlightMax = Math.max(inFlightMax, globalThis.gordHackState.inFlight);
    advance(H.batchSpacingMs);
  }
  return { s, modes, inFlightMax, state: globalThis.gordHackState };
}

/** The "[prep] target: ... sec S/min money M%" log lines, parsed, in order. */
export function prepPasses(world, target) {
  return world.log
    .filter(l => l.startsWith(`[prep] ${target}`))
    .map(l => {
      const m = l.match(/sec ([\d.]+)\/[\d.]+ money (\d+)%/);
      return { sec: Number(m[1]), money: Number(m[2]) };
    });
}

/**
 * The scheduler scenarios, registered with the caller's `test`/`assert` so one
 * file can run them on the ns.* fallback path and another on the Formulas path.
 * @param {Function} test @param {any} assert @param {{formulas?: boolean}} base
 */
export function defineScenarios(test, assert, base = {}) {
  const label = base.formulas ? " [Formulas]" : " [ns.* fallback]";

  test("from a prepped target: continuous batches, every hack lands on a prepped server, no drift" + label, () => {
    const { world, ns, advance } = makeWorld({ ...base });
    const sim = run(world, ns, advance, 10 * 60_000);

    assert.equal(sim.state.formulas, base.formulas === true, "wrong math path exercised");
    assert.equal(sim.state.target, "t1", "the richer target wins the $/GB-s ranking");
    assert.ok(sim.state.depth > 1, `depth should be > 1, got ${sim.state.depth}`);
    assert.ok(sim.inFlightMax <= sim.state.depth, `in flight ${sim.inFlightMax} exceeded depth ${sim.state.depth}`);
    assert.equal(sim.modes.filter(m => m.startsWith("Draining")).length, 0, "drift detector tripped in a clean run");
    assert.equal(world.execFailures, 0, "exec was asked for more RAM than a host had");

    // Continuous launching: ~one batch per launch interval over the run.
    const expected = Math.floor((10 * 60_000) / sim.state.launchIntervalMs);
    assert.ok(sim.s.batchId >= expected * 0.9, `launched ${sim.s.batchId}, expected ~${expected}`);

    // The correctness condition: each hack lands on a prepped server.
    assert.ok(world.hackLandings.length > 50, "hacks actually landed");
    for (const h of world.hackLandings) {
      assert.ok(h.moneyFrac >= 0.995, `hack at t=${h.t} landed with money at ${(h.moneyFrac * 100).toFixed(2)}%`);
      assert.ok(h.secOver <= 0.01, `hack at t=${h.t} landed with security +${h.secOver.toFixed(3)}`);
    }
    assert.ok(world.stolen > 0);

    // The runner-up (t2: 4% money, +20 security) is being prepped from the RAM
    // the primary's cycle doesn't need. Only ~150GB is spare here, so it won't
    // FINISH in ten minutes - the primary keeps priority by design - but it must
    // progress (the launch count above proves it never took the primary's RAM).
    assert.ok(world.servers.t2.sec < 40, `runner-up security never moved (${world.servers.t2.sec})`);
  });

  test("from a deeply unprepped target on a small botnet: RAM-bound prep converges monotonically, then batching starts" + label, () => {
    const { world, ns, advance } = makeWorld({ ...base, t1Sec: 30, t1Money: 1e9 * 0.04 });
    const sim = run(world, ns, advance, 8 * 60_000);

    const firstBatch = sim.modes.indexOf("Batching");
    assert.ok(firstBatch > 0, "batching never started");
    assert.ok(firstBatch * H.batchSpacingMs < 7 * 60_000, "took too long to reach batching");

    // 440GB can't clear +20 security and a 25x grow in one pass, so several
    // passes are expected - but every pass must leave the target strictly better
    // off (security never up, money never down), i.e. no pass is wasted.
    const passes = prepPasses(world, "t1");
    assert.ok(passes.length >= 2 && passes.length <= 8, `prep passes on t1: ${passes.length}`);
    for (let i = 1; i < passes.length; i++) {
      assert.ok(passes[i].sec <= passes[i - 1].sec + 1e-9, `pass ${i} raised security: ${JSON.stringify(passes)}`);
      assert.ok(passes[i].money >= passes[i - 1].money, `pass ${i} lost money: ${JSON.stringify(passes)}`);
    }

    for (const h of world.hackLandings) {
      assert.ok(h.moneyFrac >= 0.995 && h.secOver <= 0.01, `hack at t=${h.t} on unprepped state (${(h.moneyFrac * 100).toFixed(1)}%, +${h.secOver.toFixed(2)})`);
    }
    assert.equal(sim.modes.filter(m => m.startsWith("Draining")).length, 0);
  });

  test("with ample RAM the joint prep settles a deeply unprepped target in one pass (two on the fallback path)" + label, () => {
    // 8TB of workers: the weaken covers both the existing excess and the
    // security the grow adds, in one pass. With Formulas the grow is sized at
    // the CURRENT security so it's exact; the ns.* fallback sizes it at min
    // security, under-grows at high security, and needs one top-up pass.
    const { world, ns, advance } = makeWorld({ ...base, t1Sec: 30, t1Money: 1e9 * 0.04, w1Ram: 4096, w2Ram: 4096 });
    const sim = run(world, ns, advance, 5 * 60_000);

    const passes = prepPasses(world, "t1");
    const maxPasses = base.formulas ? 1 : 2;
    assert.ok(passes.length >= 1 && passes.length <= maxPasses, `prep passes on t1: ${passes.length} ${JSON.stringify(passes)}`);
    const firstBatch = sim.modes.indexOf("Batching");
    assert.ok(firstBatch > 0, "batching never started");
    assert.ok(firstBatch * H.batchSpacingMs < 3.5 * 60_000, "took too long to reach batching");
    for (const h of world.hackLandings) {
      assert.ok(h.moneyFrac >= 0.995 && h.secOver <= 0.01, `hack at t=${h.t} on unprepped state`);
    }
  });

  test("the cheapest dollar does not win the ranking - the biggest income does" + label, () => {
    // tiny1 is 20x poorer than t1 but its batches cost a fraction as much and
    // land 20x faster, so it wins $ per GB-second by a mile - and it is the
    // wrong answer: it can only ever pay 0.48 x $50m every ~1.2s, while t1 pays
    // 0.5 x $1b on the same cadence. Ranking by income has to prefer t1, and the
    // spill order below depends on it (a cheap target servicing FIRST would
    // starve the rich one).
    const { world, ns, advance } = makeWorld({ ...base, tinyCount: 1, w1Ram: 4096, w2Ram: 4096 });
    const sim = run(world, ns, advance, 3 * 60_000);

    assert.equal(sim.state.target, "t1", `primary should be the richest target, got ${sim.state.target}`);
    assert.ok(sim.state.targets.some(t => t.target === "tiny1"),
      "the cheap target should still be worked with the RAM t1 cannot use");
    assert.ok(sim.state.targets[0].target === "t1", "the primary must be serviced first");
  });

  test("a botnet with more RAM than its best target can absorb spills onto the next ones" + label, () => {
    // The reported bug, in the shape it actually appears: at a low hacking level
    // every reachable server is a n00dles-alike, one target's income is capped by
    // timing alone (one batch per ~1.2s, at most maxHackFraction of its money),
    // and the old single-target scheduler therefore left most of a 16TB fleet
    // idle. Same world, same RAM, maxTargets 1 vs the configured value.
    const worldOpts = { ...base, tinyCount: 5, onlyTiny: true, w1Ram: 8192, w2Ram: 8192 };
    const measure = (maxTargets) => {
      const saved = H.maxTargets;
      H.maxTargets = maxTargets;
      try {
        const { world, ns, advance } = makeWorld(worldOpts);
        const sim = run(world, ns, advance, 4 * 60_000);
        return { world, sim, hosts: busyHosts(world), used: usedRam(world) };
      } finally {
        H.maxTargets = saved;
      }
    };

    const one = measure(1);
    const many = measure(H.maxTargets);

    assert.ok(many.sim.state.targets.length >= 3,
      `expected several targets in flight, got ${JSON.stringify(many.sim.state.targets.map(t => t.target))}`);
    assert.ok(many.used > one.used * 2,
      `RAM in use should climb with the extra targets: ${one.used.toFixed(0)}GB -> ${many.used.toFixed(0)}GB`);
    assert.ok(many.world.stolen > one.world.stolen * 2,
      `income should climb with the extra targets: $${one.world.stolen.toFixed(0)} -> $${many.world.stolen.toFixed(0)}`);

    // Spilling must not cost correctness: every hack, on every target, still
    // lands on a prepped server.
    //
    // The bar differs by math path, and only for targets this fast. Their whole
    // cycle is ~2.6s, so the "current" state the ns.* fallback sizes against is
    // never the prepped one - a previous batch's hack has always just landed, so
    // hackAnalyze reads an elevated security, the hack it plans for is ~0.5%
    // smaller than the one that lands, and the grow sized to match under-restores
    // by that much every cycle. Money settles a few percent below max instead of
    // at it. Nothing to do with the spill: the same target alone, with nothing to
    // spill to, decays identically (verified), and the Formulas path - which is
    // what runs in-game with SF-5 - sizes at the prepped state and holds 100.00%.
    // Either way it stays inside the manager's own prepped threshold and nowhere
    // near the drift detector, which is what this asserts.
    const moneyBar = base.formulas ? 0.995 : H.prepMoneyThreshold;
    assert.ok(many.world.hackLandings.length > 50, "hacks actually landed");
    for (const h of many.world.hackLandings) {
      assert.ok(h.moneyFrac >= moneyBar && h.secOver <= 0.01,
        `hack on ${h.target} at t=${h.t} landed unprepped (${(h.moneyFrac * 100).toFixed(1)}%, +${h.secOver.toFixed(2)})`);
    }
    assert.equal(many.world.execFailures, 0, "exec was asked for more RAM than a host had");
    assert.equal(many.sim.modes.filter(m => m.startsWith("Draining")).length, 0,
      "drift detector tripped while spilling across targets");
  });

  test("an outside hit on the target is detected as drift, drained and re-prepped" + label, () => {
    const { world, ns, advance } = makeWorld({ ...base });
    const s = freshState();
    const modes = [];
    const tick = () => { modes.push(step(ns, s, world.clock)); advance(H.batchSpacingMs); };

    for (let i = 0; i < 600; i++) tick();                       // 2 min: steady batching
    assert.equal(modes.at(-1), "Batching");
    world.servers.t1.money *= 0.5;                              // someone else hacked it hard
    world.servers.t1.sec += 5;
    for (let i = 0; i < 900; i++) tick();                       // 3 min more
    assert.ok(modes.some(m => m.startsWith("Draining")), "drift not detected");
    assert.ok(modes.slice(600).some(m => m === "Prepping"), "never re-prepped after draining");
    assert.equal(modes.at(-1), "Batching", `did not recover to batching (last mode: ${modes.at(-1)})`);
  });

  test("a worker deleted mid-run (aug install wipes the purchased fleet) is dropped without crashing" + label, () => {
    // The bug this pins down: the manager caches its network walk for
    // networkRescanMs, an install deleted 'cloud-2', and the next tick's
    // hasRootAccess on the cached name threw "Invalid host" - an error modal
    // in-game. The fake throws exactly the same way; buildSnapshot must drop
    // the casualty via serverExists and carry on.
    const { world, ns, advance, deleteServer } = makeWorld({ ...base });
    const s = freshState();
    const modes = [];
    const tick = () => { modes.push(step(ns, s, world.clock)); advance(H.batchSpacingMs); };

    for (let i = 0; i < 600; i++) tick();                       // 2 min: steady batching
    assert.equal(modes.at(-1), "Batching");
    deleteServer("w2");                                         // a third of the fleet vanishes
    for (let i = 0; i < 1500; i++) tick();                      // 5 min: step() must never throw

    assert.equal(modes.at(-1), "Batching", `did not keep batching after the wipe (last: ${modes.at(-1)})`);
    // Orphaned legs (a hack whose grow died with the host) may dent the target
    // once; the drift/prep machinery must leave the tail end clean again.
    const recent = world.hackLandings.filter(h => h.t > world.clock - 60_000);
    assert.ok(recent.length > 10, "no hacks landing after the wipe");
    for (const h of recent) {
      assert.ok(h.moneyFrac >= 0.995 && h.secOver <= 0.01,
        `post-wipe hack unprepped (${(h.moneyFrac * 100).toFixed(1)}%, +${h.secOver.toFixed(2)})`);
    }
  });
}
