// tests/helpers/fake-botnet.mjs
//
// A fake `ns` + model world for driving hacking/manager.js's exported step()
// under Node: a couple of worker hosts, two targets whose money, security and
// leg durations respond to hack/grow/weaken landings the way the game's do -
// with the game's own dependence on SECURITY (transcribed from its source, see
// the models below), since that is what the scheduler's timing and the
// fallback's prepped-state scaling both rest on - RAM accounting that refuses
// over-commits, and a clock the tests advance by hand. Optionally a fake ns.formulas so the
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
const SHARE = "/hacking/share.js";
const RAM = { "/hacking/hack.js": 1.7, "/hacking/grow.js": 1.75, "/hacking/weaken.js": 1.75, [SHARE]: 4 };
// The game's cap on a grow thread's log-growth (ServerMaxGrowthLog = log1p(0.0035)).
const GROW_MAX_LOG = 0.00349388925425578;

/**
 * @param {object} [opts]
 * @param {number} [opts.t1Sec] @param {number} [opts.t1Money]
 * @param {number} [opts.w1Ram] @param {number} [opts.w2Ram]
 * @param {boolean} [opts.formulas] expose a fake ns.formulas + Formulas.exe
 * @param {number} [opts.weakenRate] the BitNode's ServerWeakenRate (default 1):
 *        scales what a weaken thread removes AND what ns.weakenAnalyze reports
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
      home: { maxRam: opts.homeRam ?? 64, used: 0 },
      w1: { maxRam: opts.w1Ram ?? 256, used: 0 },
      w2: { maxRam: opts.w2Ram ?? 128, used: 0 },
      // reqHack 20 makes a leg 5% longer per point of security at t1's minimum
      // (2.5*20 / (2.5*20*10 + 500)) - a mid-game server's sensitivity.
      t1: { maxRam: 0, maxMoney: 1e9, minSec: 10, sec: opts.t1Sec ?? 10, money: opts.t1Money ?? 1e9, reqHack: 20, growth: 50, speed: opts.t1Speed },
      t2: { maxRam: 0, maxMoney: 4e8, minSec: 20, sec: 40, money: 4e8 * 0.04, reqHack: 20, growth: 30 },
      // opts.tinyCount adds N n00dles-alikes: little money, but legs land in a
      // twentieth of the time and one hack thread takes 20x the bite - the
      // cheapest dollars on the network, and each able to absorb only a sliver
      // of a big botnet. Opt-in, so they only appear in the scenarios about
      // that; opts.onlyTiny additionally removes t1/t2, modelling the low
      // hacking level where nothing better is in reach.
      ...tinyTargets(opts),
    },
    hackLandings: /** @type {{t: number, moneyFrac: number, secOver: number, target: string}[]} */ ([]),
    // The player's grow multiplier (ns.getPlayer().mults.hacking_grow): a graft,
    // a Stanek charge or an IPvGO bonus moves it under a running manager.
    growMult: 1,
    stolen: 0,
    // Hacking exp landed, and the expected move of each server's stock forecast
    // (second-order, in the game's points) from legs flagged { stock: true }.
    exp: 0,
    pushes: /** @type {Record<string, number>} */ ({}),
    execFailures: 0,
    // Every process ns.kill() took down, so a scenario can assert that nothing
    // killed the botnet's own legs.
    killed: /** @type {{script: string, host: string, t: number}[]} */ ([]),
    log: /** @type {string[]} */ ([]),
  };
  const weakenPerThread = 0.05 * (opts.weakenRate ?? 1);

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

  // Models. The magnitudes are the fake's own (a 10s hack, 0.2% per hack thread,
  // 0.45% per grow thread, all at MIN security), but how each one moves with
  // security is the game's formula, term for term:
  //   leg time  ∝ 2.5·requiredLevel·security + 500        (src/Hacking.ts)
  //   hack %    ∝ (100 − security) / 100                  (src/Hacking.ts)
  //   grow log  ∝ min(log1p(0.03 / security), cap)        (src/Server/formulas/grow.ts)
  // All take a {sec, minSec, reqHack, money, maxMoney} view so the Formulas fake
  // can evaluate them on a mock server.
  const difficulty = (s, sec) => 2.5 * (s.reqHack ?? 1) * sec + 500;
  const timeMult = s => (s.speed ?? 1) * difficulty(s, s.sec) / difficulty(s, s.minSec);
  const hackTime = s => 10_000 * timeMult(s);
  const growTime = s => 32_000 * timeMult(s);
  const weakenTime = s => 40_000 * timeMult(s);
  const hackPct = s => 0.002 * (s.hackMult ?? 1) * Math.max(0, 100 - s.sec) / (100 - s.minSec);
  const growLog = sec => Math.min(Math.log1p(0.03 / sec), GROW_MAX_LOG);
  // Log-growth per grow thread.
  const growRate = s => 0.0045 * world.growMult * growLog(s.sec) / growLog(s.minSec);
  const growThreadsFor = (s, targetMoney) =>
    Math.log(targetMoney / Math.max(s.money, 1)) / growRate(s);

  function durationFor(script, s) {
    if (script === "/hacking/hack.js") return hackTime(s);
    if (script === "/hacking/grow.js") return growTime(s);
    return weakenTime(s);
  }

  // The last hack leg landed on each target. (Per target: with several targets
  // landing in the same millisecond one shared "last leg" was overwritten
  // between the two parts of a split leg, and the second part was recorded as a
  // hack on an unprepped server.)
  const lastHackLeg = new Map();
  function land(job) {
    const s = target(job.target);
    if (job.script === "/hacking/hack.js") {
      // One record per hack LEG: a leg split across hosts lands as several
      // processes in the same instant, and the later parts seeing the first
      // part's bite is not a hack landing on an unprepped server.
      const leg = `${job.tag}|${world.clock}`;
      if (leg !== lastHackLeg.get(job.target)) {
        world.hackLandings.push({ t: world.clock, moneyFrac: s.money / s.maxMoney, secOver: s.sec - s.minSec, target: job.target });
      }
      lastHackLeg.set(job.target, leg);
      const stolen = Math.min(s.money, s.money * job.threads * hackPct(s));
      s.money -= stolen;
      world.stolen += stolen;
      s.sec += 0.002 * job.threads;
      // { stock: true }: the game lowers the stock's second-order forecast by 0.1
      // with probability (money taken) / (max money) - the expectation here.
      if (job.stock) push(job.target, -0.1 * stolen / s.maxMoney);
    } else if (job.script === "/hacking/grow.js") {
      const before = s.money;
      s.money = Math.min(s.maxMoney, Math.max(s.money, 1) * Math.exp(growRate(s) * job.threads));
      s.sec += 0.004 * job.threads;
      // ...and raises it by the money a flagged grow actually ADDED (nothing, on
      // a full server).
      if (job.stock) push(job.target, 0.1 * (s.money - before) / s.maxMoney);
    } else {
      s.sec = Math.max(s.minSec, s.sec - weakenPerThread * job.threads);
    }
    // Hacking exp: every landed thread, 3 + 0.3 x base security (base = 3 x min).
    world.exp += job.threads * (3 + 0.9 * s.minSec);
  }
  const push = (name, by) => { world.pushes[name] = (world.pushes[name] ?? 0) + by; };
  // What the real workers decide when they start (hacking/hack.js, grow.js): a
  // hack carries { stock: true } for a server in `down`, a grow for one in `up`,
  // while the wish list is under two minutes old.
  const stockFlag = (script, tgt) => {
    const wishes = globalThis.gordStockWishes;
    if (!wishes || !(world.clock - wishes.updatedAt < 120_000)) return false;
    if (script === "/hacking/hack.js") return (wishes.down ?? []).includes(tgt);
    if (script === "/hacking/grow.js") return (wishes.up ?? []).includes(tgt);
    return false;
  };

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
    reqHack: fs.requiredHackingSkill,
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
    // Like the game's, every analysis call describes the server AS IT IS NOW -
    // growthAnalyze included.
    hackAnalyze: h => hackPct(srvOrThrow(h)),
    growthAnalyze: (h, mult) => Math.log(mult) / growRate(srvOrThrow(h)),
    weakenAnalyze: threads => weakenPerThread * threads,
    getHackTime: h => hackTime(srvOrThrow(h)),
    getGrowTime: h => growTime(srvOrThrow(h)),
    getWeakenTime: h => weakenTime(srvOrThrow(h)),
    // filename WITHOUT the leading slash, as the game reports it (script names are
    // stored that way) - a fake that echoed "/hacking/share.js" back is what let
    // `p.filename === SHARE` pass here and never match in the game.
    ps: host => { srvOrThrow(host); return world.jobs.filter(j => j.host === host).map(j => ({ filename: String(j.script).replace(/^\/+/, ""), threads: j.threads, pid: j.pid })); },
    kill(pid) {
      const i = world.jobs.findIndex(j => j.pid === pid);
      if (i < 0) return false;
      world.killed.push({ script: world.jobs[i].script, host: world.jobs[i].host, t: world.clock });
      world.servers[world.jobs[i].host].used -= world.jobs[i].ram;
      world.jobs.splice(i, 1);
      return true;
    },
    exec(script, host, threads, tgt, delay, tag) {
      const srv = srvOrThrow(host);
      const ram = (RAM[script] ?? 0) * threads;
      if (srv.used + ram > srv.maxRam + 1e-9) { world.execFailures++; return 0; }
      srv.used += ram;
      if (script === SHARE) {
        // share.js loops forever: it holds its RAM until something kills it.
        world.jobs.push({ pid: world.pid, script, host, threads, ram, startAt: world.clock, landAt: Infinity });
        return world.pid++;
      }
      // The workers pass the delay to the game as additionalMsec, so the action
      // STARTS at exec and its duration locks at the security of this moment.
      const landAt = world.clock + delay + durationFor(script, target(tgt));
      world.jobs.push({ pid: world.pid, script, host, threads, target: tgt, tag, ram, startAt: world.clock, landAt, stock: stockFlag(script, tgt) });
      return world.pid++;
    },
    getPlayer: () => ({ money: 0, skills: { hacking: 100 }, mults: { hacking_grow: world.growMult } }),
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
  delete globalThis.gordReservedRamAt;
  delete globalThis.gordState;
  delete globalThis.gordStockWishes;
  return newSchedulerState();
}

/**
 * Publish a stock wish list the way lib/stocks.js does, stamped with the fake
 * clock (the manager is handed that clock as `now`).
 * @param {any} world @param {{up?: string[], down?: string[], prefer?: boolean}} wishes
 */
function publishWishes(world, wishes) {
  globalThis.gordStockWishes = { up: [], down: [], prefer: false, ...wishes, updatedAt: world.clock };
}

/** Drive step() for `ms` of fake time. Returns the scheduler state and per-tick modes. */
export function run(world, ns, advance, ms) {
  const s = freshState();
  const modes = [];
  let inFlightMax = 0;
  let processMax = 0;
  const ticks = Math.floor(ms / H.batchSpacingMs);
  for (let i = 0; i < ticks; i++) {
    modes.push(step(ns, s, world.clock));
    inFlightMax = Math.max(inFlightMax, globalThis.gordHackState.inFlight);
    processMax = Math.max(processMax, world.jobs.length);
    advance(H.batchSpacingMs);
  }
  return { s, modes, inFlightMax, processMax, state: globalThis.gordHackState };
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

    // Continuous launching: the window is refilled as fast as it empties. 440GB
    // can't carry a full window of efficient batches, so the window is THIN
    // (batch-logic planCycle): `depth` batches per weaken-time, not one per
    // launch interval.
    const cadence = Math.max(sim.state.launchIntervalMs, sim.state.weakenTimeMs / sim.state.depth);
    const expected = Math.floor((10 * 60_000) / cadence);
    assert.ok(sim.s.batchId >= expected * 0.9, `launched ${sim.s.batchId}, expected ~${expected}`);
    assert.ok(sim.state.fraction >= 0.02, `a thin window takes real bites, got ${sim.state.fraction}`);

    // The correctness condition: each hack lands on a prepped server.
    assert.ok(world.hackLandings.length > 50, "hacks actually landed");
    for (const h of world.hackLandings) {
      assert.ok(h.moneyFrac >= 0.995, `hack at t=${h.t} landed with money at ${(h.moneyFrac * 100).toFixed(2)}%`);
      assert.ok(h.secOver <= 0.01, `hack at t=${h.t} landed with security +${h.secOver.toFixed(3)}`);
    }
    assert.ok(world.stolen > 0);

    // 440GB is far less than t1 can absorb, and the bite is sized to the hack
    // thread, so the primary's cycle fills the botnet to within one thread per
    // batch (a coarse step here, where a whole batch is only ~13GB: one more
    // hack thread and the grow it needs is a fifth of that).
    assert.ok(sim.state.claimedRam >= sim.state.capacityRam * 0.75,
      `the primary's cycle should fill the botnet: claims ${sim.state.claimedRam.toFixed(0)} of ${sim.state.capacityRam.toFixed(0)}GB`);
    assert.ok(usedRam(world) >= sim.state.capacityRam * 0.7, `only ${usedRam(world).toFixed(0)}GB in use`);
  });

  // Both paths. The ns.* fallback used to fail this one too, for its own reason:
  // it sized threads from hackAnalyze / growthAnalyze at the target's CURRENT
  // security, which with fat batches in flight is not the prepped state they
  // land on, so its grows came up short and money sagged until the drift
  // detector re-prepped. It now scales those readings to min security
  // (batch-logic preppedScale).
  test("REGRESSION: a big botnet taking fat bites still lands every hack on a prepped server" + label, () => {
    // 32TB against t1: the plan takes the largest money fraction, whose grow adds
    // enough security to stretch any leg STARTED during a hack->weaken or
    // grow->weaken window by far more than the 200ms landing spacing. With the
    // delay slept inside the worker (durations fixed at start-after-sleep) most
    // hacks landed out of order - 261 of 293 on an unprepped server here, and
    // 43% of ticks spent draining. Durations now lock at launch and the delays
    // are computed from the current leg times, so the order holds.
    const { world, ns, advance } = makeWorld({ ...base, w1Ram: 16384, w2Ram: 16384 });
    const sim = run(world, ns, advance, 10 * 60_000);

    assert.ok(sim.state.fraction >= 0.05, `expected a fat bite, got ${sim.state.fraction}`);
    assert.ok(world.hackLandings.length > 50, "hacks actually landed");
    const t1 = world.hackLandings.filter(h => h.target === "t1");
    const bad = t1.filter(h => h.moneyFrac < 0.995 || h.secOver > 0.01);
    assert.equal(bad.length, 0, `${bad.length} of ${t1.length} t1 hacks landed unprepped`);
    const draining = sim.modes.filter(m => m.startsWith("Draining")).length;
    assert.equal(draining, 0, `${draining} of ${sim.modes.length} ticks draining`);
    // ...and waiting for a calm launch moment didn't cost the cadence.
    const expected = Math.floor((10 * 60_000) / sim.state.launchIntervalMs);
    assert.ok(sim.s.batchId >= expected * 0.9, `launched ${sim.s.batchId}, expected ~${expected}`);
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

    // A prep counts as done from prepMoneyThreshold, so the first batches may
    // land a point or two under full; each one's padded grow closes the gap
    // (growPadding), and from the fourth on the server is back at max.
    world.hackLandings.forEach((h, i) => {
      const bar = i < 3 ? H.prepMoneyThreshold : 0.995;
      assert.ok(h.moneyFrac >= bar && h.secOver <= 0.01, `hack ${i} at t=${h.t} on unprepped state (${(h.moneyFrac * 100).toFixed(1)}%, +${h.secOver.toFixed(2)})`);
    });
    assert.equal(sim.modes.filter(m => m.startsWith("Draining")).length, 0);
  });

  test("with ample RAM the joint prep settles a deeply unprepped target in one pass" + label, () => {
    // 8TB of workers: the weaken covers both the existing excess and the
    // security the grow adds, in one pass. The grow is sized at the CURRENT
    // security on both paths - that is where it lands, ahead of the weaken, and
    // it is what Formulas is asked for and what ns.growthAnalyze reads anyway.
    const { world, ns, advance } = makeWorld({ ...base, t1Sec: 30, t1Money: 1e9 * 0.04, w1Ram: 4096, w2Ram: 4096 });
    const sim = run(world, ns, advance, 5 * 60_000);

    const passes = prepPasses(world, "t1");
    const maxPasses = 1;
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
    // starve the rich one). 64TB is more than t1 can absorb even at the largest
    // bite, so there is RAM left over for the cheap one.
    const { world, ns, advance } = makeWorld({ ...base, tinyCount: 1, w1Ram: 32768, w2Ram: 32768 });
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
    // (The late-game plan is switched off for the single-target run: it exists
    // to open more windows than maxTargets when that pays, which is this very
    // spill - see the "late game" scenario for it.)
    const measure = (maxTargets, adaptive = true) => {
      const saved = H.maxTargets;
      const savedAdaptive = H.adaptive.enabled;
      H.maxTargets = maxTargets;
      H.adaptive.enabled = adaptive;
      try {
        const { world, ns, advance } = makeWorld(worldOpts);
        const sim = run(world, ns, advance, 4 * 60_000);
        return { world, sim, hosts: busyHosts(world), used: usedRam(world) };
      } finally {
        H.maxTargets = saved;
        H.adaptive.enabled = savedAdaptive;
      }
    };

    const one = measure(1, false);
    const many = measure(H.maxTargets);

    assert.ok(many.sim.state.targets.length >= 3,
      `expected several targets in flight, got ${JSON.stringify(many.sim.state.targets.map(t => t.target))}`);
    assert.ok(many.used > one.used * 2,
      `RAM in use should climb with the extra targets: ${one.used.toFixed(0)}GB -> ${many.used.toFixed(0)}GB`);
    assert.ok(many.world.stolen > one.world.stolen * 2,
      `income should climb with the extra targets: $${one.world.stolen.toFixed(0)} -> $${many.world.stolen.toFixed(0)}`);

    // Spilling must not cost correctness: every hack, on every target, still
    // lands on a prepped server - on both math paths. (The ns.* fallback used to
    // need a lower bar here: these targets' whole cycle is ~2.6s, so the
    // "current" state it sized against was never the prepped one, and money
    // settled a few percent under max. It now scales its readings to min
    // security - batch-logic preppedScale - and holds 100% like the Formulas path.)
    const moneyBar = 0.995;
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
    // (6TB, so the 4TB that survives still carries a full window of batches.)
    const { world, ns, advance, deleteServer } = makeWorld({ ...base, w1Ram: 4096, w2Ram: 2048 });
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

  test("a drift LATCHES: nothing is launched until the target's batches have all landed" + label, () => {
    // A nudge the target would shrug off on its own - +0.3 security, which the
    // next few weakens' rounding surplus removes within seconds. Unlatched, the
    // drift check was true for those few ticks only and launching resumed into
    // the same window (in the field: Draining/Batching flapping every second,
    // and never the re-prep). Latched, the target is left alone until every
    // batch in flight has landed - a whole weaken-time - and only then re-read.
    // (6TB, so the window is full: batches land continuously and "all landed"
    // really is a weaken-time away. On a thin window they land in one bunch.)
    const { world, ns, advance } = makeWorld({ ...base, w1Ram: 4096, w2Ram: 2048 });
    const s = freshState();
    const modes = [];
    const launched = [];
    const tick = () => { modes.push(step(ns, s, world.clock)); launched.push(s.batchId); advance(H.batchSpacingMs); };

    for (let i = 0; i < 600; i++) tick();                       // 2 min: steady batching
    assert.equal(modes.at(-1), "Batching");
    world.servers.t1.sec += 0.3;
    for (let i = 0; i < 600; i++) tick();                       // 2 min more

    const first = modes.findIndex(m => m.startsWith("Draining"));
    assert.ok(first >= 600, "drift not detected");
    let last = first;
    while (modes[last + 1]?.startsWith("Draining")) last++;
    // In flight when it latched: batches launched up to a weaken-time (40s) ago.
    assert.ok((last - first) * H.batchSpacingMs >= 30_000,
      `drained for only ${((last - first) * H.batchSpacingMs / 1000).toFixed(1)}s - the latch let go early`);
    assert.equal(launched[last], launched[first], "a batch was launched during the drain");
    assert.equal(modes.at(-1), "Batching", `did not recover to batching (last mode: ${modes.at(-1)})`);
    assert.ok(world.log.some(l => l.startsWith("[drift] t1")), "the drift was not logged");
  });

  test("a prep that runs for security also grows the money all the way to full" + label, () => {
    // 96% money is inside the "prepped" money threshold, so on its own it would
    // not trigger a prep - and a batch's grow only repairs its own hack, so a
    // target that starts batching at 96% stays there. The +2 security does
    // trigger one, and that pass must take the money to 100% while it's at it.
    const { world, ns, advance } = makeWorld({ ...base, t1Sec: 12, t1Money: 1e9 * 0.96 });
    const sim = run(world, ns, advance, 4 * 60_000);

    assert.ok(world.log.some(l => /^\[prep\] t1: weaken x\d+, grow x[1-9]/.test(l)),
      `the prep carried no grow: ${world.log.filter(l => l.startsWith("[prep] t1")).join(" | ")}`);
    const t1 = world.hackLandings.filter(h => h.target === "t1");
    // (A thin window of a few fat batches: a dozen landings in the three minutes
    // after the prep, not the two dozen the efficient-size batches made.)
    assert.ok(t1.length >= 8, `hacks actually landed (${t1.length})`);
    for (const h of t1) {
      assert.ok(h.moneyFrac >= 0.995 && h.secOver <= 0.01,
        `hack at t=${h.t} landed at ${(h.moneyFrac * 100).toFixed(1)}% money, +${h.secOver.toFixed(2)} security`);
    }
    assert.equal(sim.modes.filter(m => m.startsWith("Draining")).length, 0);
  });

  test("where a weaken thread removes half as much (ServerWeakenRate), batches still land on min security" + label, () => {
    // BN12 scales ServerWeakenRate down with every level (BN11 doubles it). The
    // weaken legs used to be sized from a hardcoded 0.05 per thread, which here
    // covers half of what each hack and grow adds: security climbs batch after
    // batch. The manager now asks the game (ns.weakenAnalyze). Fat bites, so
    // the rounding-up of small weaken legs can't hide a shortfall.
    const { world, ns, advance } = makeWorld({ ...base, weakenRate: 0.5, w1Ram: 16384, w2Ram: 16384 });
    const sim = run(world, ns, advance, 6 * 60_000);

    const t1 = world.hackLandings.filter(h => h.target === "t1");
    assert.ok(t1.length > 50, "hacks actually landed");
    const bad = t1.filter(h => h.moneyFrac < 0.995 || h.secOver > 0.01);
    assert.equal(bad.length, 0, `${bad.length} of ${t1.length} t1 hacks landed unprepped`);
    assert.equal(sim.modes.filter(m => m.startsWith("Draining")).length, 0);
  });

  test("share takes only FREE RAM: no botnet leg is killed, and the host is topped up to the plan" + label, () => {
    const { world, ns, advance } = makeWorld({ ...base });
    const s = freshState();
    const modes = [];
    const tick = () => { modes.push(step(ns, s, world.clock)); advance(H.batchSpacingMs); };
    const shareJobs = () => world.jobs.filter(j => j.script === SHARE);
    const shareThreads = () => shareJobs().reduce((n, j) => n + j.threads, 0);

    try {
      for (let i = 0; i < 600; i++) tick();                     // 2 min: the botnet has filled the hosts
      assert.equal(modes.at(-1), "Batching");
      assert.ok(usedRam(world) > 0.7 * 440, "the botnet should be holding most of the RAM by now");
      const w1FreeThreads = Math.floor((world.servers.w1.maxRam - world.servers.w1.used) / 4);
      assert.ok(w1FreeThreads < 19, `w1 must be too busy to take the whole plan at once (room for ${w1FreeThreads})`);

      // The daemon starts working for a faction. The plan is 20% of the 384GB
      // off-home fleet = 76GB = 19 threads, all on the largest host (w1) - which
      // is full of batch legs. The old code killed every one of them.
      globalThis.gordState = { action: "Faction Work (test)" };
      for (let i = 0; i < 600; i++) tick();                     // 2 min: > one weaken-time for the legs to land

      assert.deepEqual(world.killed.filter(k => k.script !== SHARE), [], "share start-up killed botnet legs");
      assert.equal(shareThreads(), 19, "the host was not topped up to the planned thread count");
      assert.ok(shareJobs().every(j => j.host === "w1"));
      assert.ok(shareJobs().length <= CONFIG.share.maxProcessesPerHost,
        `share ended up as ${shareJobs().length} processes`);
      assert.equal(globalThis.gordShareState.threads, 19);
      assert.ok(Math.abs(globalThis.gordShareState.bonus - (1 + Math.log(20) / 25)) < 1e-9, "bonus is 1 + ln(1 + threads)/25");

      // ...and the botnet worked around it: still batching, every hack prepped.
      assert.equal(modes.at(-1), "Batching");
      assert.equal(modes.filter(m => m.startsWith("Draining")).length, 0, "the share start-up caused a drift");
      for (const h of world.hackLandings.filter(x => x.target === "t1")) {
        assert.ok(h.moneyFrac >= 0.995 && h.secOver <= 0.01, `hack at t=${h.t} landed unprepped`);
      }

      // Faction work over: the share goes, and only the share.
      globalThis.gordState = { action: "Crime" };
      tick();
      assert.equal(shareJobs().length, 0);
      assert.deepEqual(world.killed.filter(k => k.script !== SHARE), []);
    } finally {
      delete globalThis.gordState;
      delete globalThis.gordShareState;
    }
  });

  test("batch plans are kept between ticks, and re-made the moment the player's grow multiplier moves" + label, () => {
    // (6TB, so the window is full and a batch launches every interval.)
    const { world, ns, advance } = makeWorld({ ...base, w1Ram: 4096, w2Ram: 2048 });
    const s = freshState();
    // Every batch size the planner tries is a grow-thread question to the game
    // (Formulas growThreads, or growthAnalyze without it) - the costly part of a
    // plan, and what the manager used to ask ~25 times per target on every tick.
    let asked = 0;
    const counted = fn => (...args) => { asked++; return fn(...args); };
    ns.growthAnalyze = counted(ns.growthAnalyze);
    ns.formulas.hacking.growThreads = counted(ns.formulas.hacking.growThreads);
    const tick = () => { step(ns, s, world.clock); advance(H.batchSpacingMs); };
    // Grow threads per hack thread in the batch launched last (the RAM budget is
    // fixed, so a costlier grow shrinks the bite: the ratio is what must move).
    const threadsOf = (script, tag) => world.jobs
      .filter(j => j.script === script && j.tag === tag).reduce((n, j) => n + j.threads, 0);
    const lastBatchGrow = () => {
      const tag = `batch-${s.batchId - 1}`;
      return threadsOf("/hacking/grow.js", tag) / threadsOf("/hacking/hack.js", tag);
    };

    for (let i = 0; i < 600; i++) tick();                       // 2 min: steady batching
    asked = 0;
    const ticks = 3 * H.targetRescoreMs / H.batchSpacingMs;     // three re-ranks' worth
    for (let i = 0; i < ticks; i++) tick();
    assert.ok(asked / ticks < 4, `the game was asked for grow threads ${(asked / ticks).toFixed(1)} times per tick`);

    // Grow at half strength (a multiplier lost): the very next batch must carry
    // about twice the grow per hack thread, not the cached plan's.
    const before = lastBatchGrow();
    const launched = s.batchId;
    world.growMult = 0.5;
    for (let i = 0; i < 50 && s.batchId === launched; i++) tick();
    assert.ok(s.batchId > launched, "no batch was launched after the change");
    const after = lastBatchGrow();
    assert.ok(after >= before * 1.8, `grow per hack thread ${before.toFixed(2)} -> ${after.toFixed(2)}: the plan was not re-made`);
  });

  test("REGRESSION: a fleet of small hosts launches the batch that fits them, not none at all" + label, () => {
    // 20 + 16 + 16GB of room is 52GB and 29 worker threads (a host holds whole
    // threads: 11 + 9 + 9, with a sliver stranded on each). The plan is sized
    // against the gigabytes, comes to a batch a thread too big for the hosts,
    // and used to be retried unchanged every tick for good: "Waiting for RAM
    // (fragmented)" on a prepped target with the whole fleet idle - zero hacks
    // in this very scenario. The launch now takes the fattest batch the hosts
    // can actually place.
    const { world, ns, advance } = makeWorld({ ...base, homeRam: 28, w1Ram: 16, w2Ram: 16 });
    const sim = run(world, ns, advance, 6 * 60_000);

    assert.ok(world.hackLandings.length >= 5, `only ${world.hackLandings.length} hacks landed in six minutes`);
    assert.ok(world.stolen > 0);
    const stuck = sim.modes.filter(m => m.startsWith("Waiting for RAM")).length;
    assert.ok(stuck < sim.modes.length * 0.05, `${stuck} of ${sim.modes.length} ticks waiting for RAM`);
    assert.equal(world.execFailures, 0, "exec was asked for more RAM than a host had");
    for (const h of world.hackLandings) {
      assert.ok(h.moneyFrac >= 0.995 && h.secOver <= 0.01, `hack at t=${h.t} landed unprepped`);
    }
    assert.equal(sim.modes.filter(m => m.startsWith("Draining")).length, 0);
  });

  test("a thin window fills a small fleet: depth and bite are chosen together" + label, () => {
    // 88GB (56 on home + 16 + 16) cannot carry a full window on t1. The window
    // used to be a whole number of "efficient" batches and whatever RAM that
    // left over stayed idle - ONE batch of 56GB here, 64% of the fleet; it is
    // now the depth x bite that steals most, sized to the hack thread.
    const { world, ns, advance } = makeWorld({ ...base, w1Ram: 16, w2Ram: 16 });
    const s = freshState();
    let used = 0;
    let samples = 0;
    for (let i = 0; i < 6 * 300; i++) {
      step(ns, s, world.clock);
      if (i >= 300) { used += usedRam(world); samples++; }
      advance(H.batchSpacingMs);
    }
    const capacity = globalThis.gordHackState.capacityRam;
    assert.ok(used / samples >= capacity * 0.85,
      `${(used / samples).toFixed(0)}GB of ${capacity.toFixed(0)}GB in use on average`);
    assert.equal(world.execFailures, 0);
    for (const h of world.hackLandings) {
      assert.ok(h.moneyFrac >= 0.995 && h.secOver <= 0.01, `hack at t=${h.t} landed unprepped`);
    }
  });

  test("a stock wish list that does not ask to be preferred (or is stale) changes nothing" + label, () => {
    // Outside BitNode 8 the trader lists the servers of the positions it holds
    // with prefer: false - the workers flag their legs, and that is ALL: the
    // manager must rank, size and launch exactly as it does without the list.
    const opts = { ...base, tinyCount: 2, w1Ram: 4096, w2Ram: 2048 };
    const outcome = (publish) => {
      const { world, ns, advance } = makeWorld(opts);
      const s = freshState();
      if (publish) publish(world);
      for (let i = 0; i < 4 * 300; i++) { step(ns, s, world.clock); advance(H.batchSpacingMs); }
      const state = globalThis.gordHackState;
      return {
        batches: s.batchId, stolen: world.stolen, exp: world.exp,
        targets: state.targets.map(t => `${t.target}:${t.depth}:${t.fraction}:${t.objective ?? "-"}`).join(","),
        pushing: state.stockPush,
      };
    };
    const reference = outcome(null);
    assert.equal(reference.pushing, false);

    assert.deepEqual(outcome(w => publishWishes(w, { up: ["tiny2"], down: ["t2"], prefer: false })), reference);
    // prefer, but older than two minutes and never refreshed: nobody's wish.
    assert.deepEqual(outcome(w => { globalThis.gordStockWishes = { up: ["tiny2"], down: [], prefer: true, updatedAt: w.clock - 121_000 }; }), reference);
    // prefer, with the feature switched off in the config.
    const saved = H.stockPush.enabled;
    H.stockPush.enabled = false;
    try {
      assert.deepEqual(outcome(w => { globalThis.gordStockWishes = { up: ["tiny2"], down: [], prefer: true, updatedAt: w.clock + 1e9 }; }), reference);
    } finally {
      H.stockPush.enabled = saved;
      delete globalThis.gordStockWishes;
    }
  });

  test("BN8: a preferred wish list is worked ahead of income, the rest of the fleet trains hacking exp" + label, () => {
    // tiny2 is the poorest server on the network. The income ranking serves the
    // richest first (t1) and tiny2 somewhere behind it; preferred, tiny2 is
    // worked FIRST, as hard as the caps allow - and what it cannot absorb goes
    // to the best exp per GB, not to "income".
    const drive = (opts, wish, minutes, after) => {
      const { world, ns, advance } = makeWorld(opts);
      const s = freshState();
      const modes = [];
      for (let i = 0; i < minutes * 300; i++) {
        // The trader republishes every stock tick (6s).
        if (i % 30 === 0) publishWishes(world, wish);
        modes.push(step(ns, s, world.clock));
        advance(H.batchSpacingMs);
      }
      const during = { state: globalThis.gordHackState, pushes: { ...world.pushes }, exp: world.exp, landings: world.hackLandings.length };
      if (after) after({ world, ns, advance, s });
      return { world, modes, ...during };
    };

    try {
      const big = { ...base, tinyCount: 2, w1Ram: 4096, w2Ram: 2048 };
      const flagged = drive(big, { up: ["tiny2"], prefer: false }, 4);
      assert.equal(flagged.state.target, "t1", "the income ranking's primary is the richest server");
      assert.equal(flagged.state.stockPush, false);

      let reverted = null;
      const pushed = drive(big, { up: ["tiny2"], prefer: true }, 4, ({ world, ns, advance, s }) => {
        // The trader dies: after two minutes the list is stale, and the next
        // re-rank is the income ranking again.
        for (let i = 0; i < 3 * 300; i++) { step(ns, s, world.clock); advance(H.batchSpacingMs); }
        reverted = globalThis.gordHackState;
      });
      const st = pushed.state;
      assert.equal(st.stockPush, true);
      assert.equal(st.target, "tiny2", `the wished server should be the primary, got ${st.target}`);
      assert.equal(st.targets[0].objective, "stock");
      assert.ok(st.targets[0].depth >= 1 && st.targets[0].fraction >= H.maxHackFraction * 0.9,
        `the wished server should be cycled as hard as the caps allow, got ${JSON.stringify(st.targets[0])}`);
      const exp = st.targets.filter(t => t.objective === "exp");
      assert.ok(exp.length >= 1, "no target was given the exp objective");
      assert.ok(st.targets.every(t => t.objective === "stock" || t.objective === "exp"));
      // tiny1 - the shortest legs on the network, so the most exp per GB - is one
      // of them, though the income ranking's order would be t1 first.
      assert.ok(exp.some(t => t.target === "tiny1"), `exp targets: ${exp.map(t => t.target).join(", ")}`);

      // The stock moves: every batch's flagged grow restores its bite (0.1 point
      // per whole max-money cycled) - and no less than when it was only flagged.
      assert.ok(pushed.pushes.tiny2 > 1, `forecast pushed ${pushed.pushes.tiny2} points in four minutes`);
      assert.ok(pushed.pushes.tiny2 >= (flagged.pushes.tiny2 ?? 0) * 0.99,
        `pushed ${flagged.pushes.tiny2} points merely flagged, ${pushed.pushes.tiny2} preferred`);
      // Hacking exp is not given up for it.
      assert.ok(pushed.exp >= flagged.exp * 0.9, `exp ${flagged.exp.toFixed(0)} -> ${pushed.exp.toFixed(0)}`);
      // Correctness is the same scheduler's: every hack on a prepped server.
      for (const h of pushed.world.hackLandings.filter(x => x.target === "tiny2" || x.target === "tiny1")) {
        assert.ok(h.moneyFrac >= 0.995 && h.secOver <= 0.01, `hack on ${h.target} at t=${h.t} landed unprepped`);
      }
      assert.equal(pushed.modes.filter(m => m.startsWith("Draining")).length, 0);

      assert.equal(reverted.stockPush, false, "a stale list must hand the ranking back to income");
      assert.equal(reverted.target, flagged.state.target);
      assert.ok(reverted.targets.every(t => t.objective === undefined));

      // A server the income ranking would not touch at all: t2 starts at twice
      // its minimum security and 4% money, and a 440GB fleet has better things
      // to do than prep it. Wished DOWN and merely flagged, its stock never
      // moves; preferred, the fleet preps it and its hacks push.
      const small = { ...base };
      const ignored = drive(small, { down: ["t2"], prefer: false }, 12);
      assert.ok(!ignored.state.targets.some(t => t.target === "t2"), "the income ranking should have no use for t2 here");
      assert.equal(ignored.pushes.t2 ?? 0, 0);
      const worked = drive(small, { down: ["t2"], prefer: true }, 12);
      assert.equal(worked.state.target, "t2");
      assert.ok((worked.pushes.t2 ?? 0) < -0.02, `t2's forecast moved ${worked.pushes.t2} points in twelve minutes`);
    } finally {
      delete globalThis.gordStockWishes;
    }
  });

  test("late game: a fleet too big for the default windows deepens them, inside the process budget" + label, () => {
    // t1 with legs eight times as long: its window could hold ~270 batches, the
    // default cap is 60, and a 4PB fleet has RAM for all of them. The deep plan
    // takes over once its targets are batching; the process cap is hard.
    const opts = { ...base, t1Speed: 8, w1Ram: 2 ** 21, w2Ram: 2 ** 21 };
    const measure = (patch) => {
      const saved = { ...H.adaptive };
      Object.assign(H.adaptive, patch);
      try {
        const { world, ns, advance } = makeWorld(opts);
        const sim = run(world, ns, advance, 20 * 60_000);
        return { world, sim };
      } finally {
        Object.assign(H.adaptive, saved);
      }
    };
    const plain = measure({ enabled: false });
    const deep = measure({});
    const capped = measure({ maxProcesses: 400 });

    const depthOf = r => r.sim.state.targets.find(t => t.target === "t1")?.depth ?? 0;
    assert.equal(depthOf(plain), H.maxDepth);
    assert.ok(depthOf(deep) > H.maxDepth, `t1's window should be deeper than ${H.maxDepth}, got ${depthOf(deep)}`);
    assert.ok(deep.sim.processMax <= H.adaptive.maxProcesses,
      `${deep.sim.processMax} worker processes at once, over the cap of ${H.adaptive.maxProcesses}`);
    assert.ok(deep.sim.processMax > plain.sim.processMax, "the deeper window should be in use");
    assert.ok(deep.world.stolen > plain.world.stolen * 1.5,
      `income should climb with depth: $${plain.world.stolen.toExponential(2)} -> $${deep.world.stolen.toExponential(2)}`);
    assert.ok(capped.sim.processMax <= 400, `${capped.sim.processMax} processes with the cap at 400`);
    assert.ok(capped.world.stolen > 0);

    for (const r of [deep, capped]) {
      const t1 = r.world.hackLandings.filter(h => h.target === "t1");
      assert.ok(t1.length > 50, "hacks actually landed");
      const bad = t1.filter(h => h.moneyFrac < 0.995 || h.secOver > 0.01);
      assert.equal(bad.length, 0, `${bad.length} of ${t1.length} t1 hacks landed unprepped`);
      assert.equal(r.world.execFailures, 0);
    }
  });

  test("RAM the daemon wants kept free is honoured while its stamp is fresh, and released once the daemon is gone" + label, () => {
    const { world, ns, advance } = makeWorld({ ...base });
    const s = freshState();
    const capacity = () => { step(ns, s, world.clock); advance(H.batchSpacingMs); return globalThis.gordHackState.capacityRam; };
    try {
      const all = capacity();
      globalThis.gordReservedRam = { w1: 200 };            // no stamp: trusted, as it always was
      assert.equal(capacity(), all - 200);
      advance(10 * 60_000);
      assert.equal(capacity(), all - 200, "a map nobody stamps never goes stale");
      globalThis.gordReservedRamAt = world.clock;          // a live daemon stamps it every tick
      assert.equal(capacity(), all - 200);
      advance(H.reservedRamMaxAgeMs - 1_000);
      assert.equal(capacity(), all - 200);
      advance(2_000);                                       // ...and this one has stopped
      assert.equal(capacity(), all, "the holds of a dead daemon idled the host for good");
      globalThis.gordReservedRamAt = world.clock;          // it is back
      assert.equal(capacity(), all - 200);
    } finally {
      delete globalThis.gordReservedRam;
      delete globalThis.gordReservedRamAt;
    }
  });

  test("late game: the switch to deeper windows waits until the windows in flight are full" + label, () => {
    // Same fleet, but t1 needs a prep first (six minutes: its legs are long).
    // Its window then takes a weaken-time (320s) to fill. Adopting the deep plan
    // the moment every target was merely BATCHING re-cut the fleet around a
    // window with two batches in it - and on a fleet where that drops a target,
    // the dropped target's income stops a weaken-time before the deep window's
    // begins (5-9% off the first hour, simulated on 12 x 8TB, 26 x 4TB and
    // 26 x 16TB).
    const { world, ns, advance } = makeWorld({ ...base, t1Sec: 12, t1Speed: 8, w1Ram: 2 ** 21, w2Ram: 2 ** 21 });
    const s = freshState();
    let before = [];
    let switched = null;
    for (let i = 0; i < 15 * 300 && !switched; i++) {
      step(ns, s, world.clock);
      const targets = globalThis.gordHackState.targets.map(t => ({ ...t }));
      if (targets.some(t => t.depth > H.maxDepth)) switched = { at: world.clock, before, targets };
      before = targets;
      advance(H.batchSpacingMs);
    }
    assert.ok(switched, "the deep plan was never adopted");
    const deepened = switched.targets.filter(t => t.depth > H.maxDepth).map(t => t.target);
    assert.deepEqual(deepened, ["t1"]);
    for (const t of switched.before.filter(x => deepened.includes(x.target))) {
      assert.ok(t.depth > 0 && t.inFlight >= t.depth * 0.9,
        `adopted at ${switched.at / 1000}s with ${t.target}'s window at ${t.inFlight}/${t.depth}`);
    }
    assert.ok(switched.before.some(x => x.target === "t1"), "t1 was not being worked before the switch");
  });

  test("late game: a server nobody is working cannot keep the deep plan from being adopted" + label, () => {
    // One target slot in the default plan - t1, whose window could be 100 deep -
    // and twelve in the deep one, which would also list t2, unprepped and
    // untouched. Planned over every candidate and adopted only once all of them
    // were ready, the deep plan waited for a server the default plan was never
    // going to prep: a cold 26 x 1PB fleet at hacking 60 stayed 60 deep for
    // good (37% of what the deep plan pays). It is first planned over the
    // targets that ARE ready.
    const savedTargets = H.maxTargets;
    H.maxTargets = 1;
    try {
      const { world, ns, advance } = makeWorld({ ...base, t1Speed: 3, w1Ram: 2 ** 21, w2Ram: 2 ** 21 });
      const sim = run(world, ns, advance, 10 * 60_000);
      const t1 = sim.state.targets.find(t => t.target === "t1");
      assert.ok(t1 && t1.depth > H.maxDepth, `t1's window should be deeper than ${H.maxDepth}: ${JSON.stringify(sim.state.targets)}`);
      // ...and once it is in force the newcomer is taken on like any other target.
      assert.ok(sim.state.targets.some(t => t.target === "t2"), "t2 should have joined the deep plan");
      const bad = world.hackLandings.filter(h => h.moneyFrac < 0.995 || h.secOver > 0.01);
      assert.equal(bad.length, 0, `${bad.length} hacks landed unprepped`);
    } finally {
      H.maxTargets = savedTargets;
    }
  });

  test("share.js left by an earlier manager is found and stopped, without a process listing of every host every tick" + label, () => {
    const { world, ns, advance, deleteServer } = makeWorld({ ...base });
    const s = freshState();
    let listings = 0;
    const ps = ns.ps;
    ns.ps = host => { listings++; return ps(host); };
    const tick = () => { step(ns, s, world.clock); advance(H.batchSpacingMs); };
    const shareJobs = () => world.jobs.filter(j => j.script === SHARE);

    try {
      // A manager that was killed leaves its share.js running; the next one must
      // stop it on its first tick (nobody is farming reputation).
      assert.ok(ns.exec(SHARE, "w2", 3) > 0);
      tick();
      assert.equal(shareJobs().length, 0, "the leftover share.js was not stopped on the first tick");

      // With nothing to watch, the network is listed once per networkRescanMs -
      // not once per tick (ns.ps builds an object per running process).
      listings = 0;
      const ticks = 4 * H.networkRescanMs / H.batchSpacingMs;
      for (let i = 0; i < ticks; i++) tick();
      const hosts = Object.keys(world.servers).length;
      assert.ok(listings <= hosts * 4, `${listings} process listings in ${ticks} ticks over ${hosts} hosts`);

      // One that turns up later is still caught by the next sweep.
      assert.ok(ns.exec(SHARE, "home", 1) > 0);
      for (let i = 0; i <= H.networkRescanMs / H.batchSpacingMs; i++) tick();
      assert.equal(shareJobs().length, 0, "a share.js started behind the manager's back was never stopped");
      assert.deepEqual(world.killed.filter(k => k.script !== SHARE), [], "the sweep killed something that was not share.js");

      // A host this manager shares on can be deleted under it (ns.ps throws on a
      // gone hostname): the share step must carry on, not fail every tick.
      globalThis.gordState = { action: "Faction Work (test)" };
      for (let i = 0; i < 600; i++) tick();
      assert.ok(shareJobs().length > 0 && shareJobs().every(j => j.host === "w1"), "share should be running on w1");
      deleteServer("w1");
      for (let i = 0; i < 10; i++) tick();
      assert.deepEqual(world.log.filter(l => l.startsWith("[share] disabled")), []);
    } finally {
      delete globalThis.gordState;
      delete globalThis.gordShareState;
    }
  });
}
