// tests/driver.test.mjs
// The cold-start driver (early/driver.js) is the one script every new BitNode
// begins with, and the only one that has to work in 32GB with nothing rooted.
// Its main loop is driven here against a small fake `ns` for the two things it
// decides besides "is home big enough yet": how much home RAM to buy, and what
// it asks the botnet to keep free for a boot script that found no room.
// Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { main, holdHost } from "../early/driver.js";
import { CONFIG, forNode } from "../lib/config.js";

const P = CONFIG.paths;
const bare = p => String(p).replace(/^\/+/, "");
const STOP = new Error("stop the fake driver");

/**
 * A fake game: home plus a few rooted hosts, script sizes, and a home-RAM shop
 * that sells `upgrades` doublings. `ticks` is how many loop passes main gets
 * before ns.sleep throws STOP.
 */
function fakeGame({ node, ownedSF = [], options = {}, home = 32, hosts = {}, ram = {}, upgrades = 0, ticks = 1, inBladeburner = false }) {
  const g = {
    max: { home, ...Object.fromEntries(Object.entries(hosts).map(([h, v]) => [h, v.max])) },
    procs: /** @type {{pid: number, host: string, script: string, ram: number}[]} */ ([]),
    upgradesLeft: upgrades,
    upgradesBought: 0,
    // Every script the driver started, in order (they may have exited since).
    started: /** @type {string[]} */ ([]),
    nextPid: 1,
    prints: /** @type {string[]} */ ([]),
  };
  // Whatever already fills a host (the botnet's legs), as one opaque process.
  for (const [h, v] of Object.entries(hosts)) {
    if (v.used) g.procs.push({ pid: g.nextPid++, host: h, script: "hacking/weaken.js", ram: v.used });
  }
  const sizeOf = script => ram[bare(script)] ?? 2;
  const used = host => g.procs.filter(p => p.host === host).reduce((s, p) => s + p.ram, 0);
  const start = (script, host) => {
    if (g.max[host] - used(host) < sizeOf(script)) return 0;
    const pid = g.nextPid++;
    g.procs.push({ pid, host, script: bare(script), ram: sizeOf(script) });
    g.started.push(bare(script));
    return pid;
  };
  // The driver itself occupies home.
  g.procs.push({ pid: g.nextPid++, host: "home", script: bare(P.driver), ram: sizeOf(P.driver) });

  const ns = /** @type {any} */ ({
    args: [],
    disableLog() {},
    tprint: msg => g.prints.push(String(msg)),
    print() {},
    format: { ram: n => `${n}GB`, number: n => String(n) },
    getResetInfo: () => ({
      currentNode: node, ownedSF: new Map(ownedSF), lastNodeReset: 1, lastAugReset: 1,
      bitNodeOptions: { sourceFileOverrides: new Map(), ...options },
    }),
    fileExists: () => true,
    getScriptRam: script => sizeOf(script),
    getServerMaxRam: host => g.max[host] ?? 0,
    getServerUsedRam: host => used(host),
    getServerMoneyAvailable: () => 0,
    hasRootAccess: () => true,
    scan: host => (host === "home" ? Object.keys(g.max).filter(h => h !== "home") : ["home"]),
    scriptRunning: (script, host) => g.procs.some(p => p.host === host && p.script === bare(script)),
    scriptKill: (script, host) => { g.procs = g.procs.filter(p => !(p.host === host && p.script === bare(script))); return true; },
    ps: host => g.procs.filter(p => p.host === host).map(p => ({ filename: p.script, pid: p.pid })),
    kill: pid => { g.procs = g.procs.filter(p => p.pid !== pid); return true; },
    run: script => start(script, "home"),
    exec: (script, host) => start(script, host),
    scp: () => true,
    ls: () => [],
    sleep: async () => { if (--ticks <= 0) throw STOP; },
    singularity: {
      upgradeHomeRam: () => {
        if (g.upgradesLeft <= 0) return false;
        g.upgradesLeft--;
        g.upgradesBought++;
        g.max.home *= 2;
        return true;
      },
    },
    bladeburner: { inBladeburner: () => inBladeburner },
    gang: { inGang: () => false },
  });
  return { ns, g, used };
}

/** Run main until it hands off or the fake stops it; returns the holds it published. */
async function runDriver(ns) {
  try {
    await main(ns);
  } catch (e) {
    if (e !== STOP) throw e;
  }
  const published = globalThis.gordReservedRam;
  delete globalThis.gordReservedRam;
  return published;
}

// Sizes as the game bills them (README / tools/self-test.js), near enough.
const RAM = {
  [bare(P.driver)]: 13,
  [bare(P.manager)]: 12.35,
  [bare(P.bladeBoot)]: 13.1,
  [bare(P.hacknet)]: 11.25,
  [bare(P.stanekBoot)]: 4.6,
  "bn1/daemon.js": 86, "bn4/daemon.js": 86, "bn7/daemon.js": 89, "bn8/daemon.js": 89, "bn9/daemon.js": 97,
  "bn13/daemon.js": 89,
};

test("holdHost: the smallest host that still fits, stable by name, none when nothing is big enough", () => {
  const hosts = [{ host: "zer0", max: 32 }, { host: "joesguns", max: 16 }, { host: "foodnstuff", max: 16 }, { host: "n00dles", max: 4 }];
  assert.equal(holdHost(hosts, 13.1, {}), "foodnstuff");
  // What is already held on a host counts against it.
  assert.equal(holdHost(hosts, 13.1, { foodnstuff: 11.25 }), "joesguns");
  assert.equal(holdHost(hosts, 13.1, { foodnstuff: 11.25, joesguns: 4 }), "zer0");
  assert.equal(holdHost(hosts, 64, {}), null);
  assert.equal(holdHost([], 1, {}), null);
});

test("the driver buys home RAM as far as money goes - except where the node says only until the daemon fits", async () => {
  // BN4: every doubling on offer is taken (32 -> 1024), then it hands off.
  const plain = fakeGame({ node: 4, ram: RAM, upgrades: 5 });
  await runDriver(plain.ns);
  assert.equal(plain.g.max.home, 1024);
  assert.ok(plain.g.procs.some(p => p.script === "bn4/daemon.js"), "handed off to the daemon");

  // BN8 (driver.homeRamOnlyToFit): the $250m is the stock trader's capital. The
  // daemon needs 89 + headroom, so 32 -> 64 -> 128 and not a doubling more.
  assert.equal(forNode(8).driver.homeRamOnlyToFit, true);
  const bn8 = fakeGame({ node: 8, ram: RAM, upgrades: 5 });
  await runDriver(bn8.ns);
  assert.equal(bn8.g.max.home, 128);
  assert.equal(bn8.g.upgradesBought, 2);
  assert.ok(bn8.g.procs.some(p => p.script === "bn8/daemon.js"), "handed off to the daemon");
});

test("a boot script with nowhere to go gets RAM held for it off-home, not only on a home that cannot fit it", async () => {
  // A fresh Bladeburner node: 32GB home (driver + manager leave ~7GB), the
  // rooted 16GB hosts already full of the botnet's legs.
  const full = { max: 16, used: 16 };
  const game = fakeGame({
    node: 7, ownedSF: [[7, 1]], ram: RAM, ticks: 1,
    hosts: { n00dles: { max: 4, used: 4 }, joesguns: { ...full }, foodnstuff: { ...full } },
  });
  // Left behind by the last node's daemon; must not survive into this one.
  globalThis.gordReservedRam = { "cloud-gang": 44 };
  const holds = await runDriver(game.ns);
  assert.deepEqual(holds, { home: 13.1, foodnstuff: 13.1 });
  assert.ok(!game.g.procs.some(p => p.script === bare(P.bladeBoot)));

  // Once the botnet has let that host drain, the boot script lands and the
  // holds are gone.
  const drained = fakeGame({
    node: 7, ownedSF: [[7, 1]], ram: RAM, ticks: 1,
    hosts: { n00dles: { max: 4, used: 4 }, joesguns: { ...full }, foodnstuff: { max: 16, used: 0 } },
  });
  const after = await runDriver(drained.ns);
  assert.deepEqual(after, {});
  assert.ok(drained.g.procs.some(p => p.script === bare(P.bladeBoot) && p.host === "foodnstuff"));
});

test("BN9's hacknet manager is held for the same way, and a node with no boot scripts holds nothing", async () => {
  const full = { max: 16, used: 16 };
  const bn9 = fakeGame({ node: 9, ownedSF: [[9, 1]], ram: RAM, hosts: { joesguns: { ...full }, foodnstuff: { ...full } } });
  assert.deepEqual(await runDriver(bn9.ns), { home: 11.25, foodnstuff: 11.25 });

  const bn4 = fakeGame({ node: 4, ram: RAM, hosts: { joesguns: { ...full } } });
  globalThis.gordReservedRam = { joesguns: 16 };
  assert.deepEqual(await runDriver(bn4.ns), {});
});

test("a challenge run is booted with the challenge's config: its daemon, and no boot script for what the run forbids", async () => {
  // How a run says it is one: the node's challenge options plus the entry marker
  // (a Source-File override that overrides nothing) - see CHALLENGE in lib/config.js.
  const MARK = { sourceFileOverrides: new Map([[1, 3]]) };
  const saved = globalThis.gordStanekState;
  delete globalThis.gordStanekState;
  try {
    // BN7 without Bladeburner: the plain daemon, and nothing gyms toward a
    // division the game will not let the player join.
    const bn7 = fakeGame({ node: 7, ownedSF: [[1, 3], [7, 1]], options: { disableBladeburner: true, ...MARK }, ram: RAM, home: 128 });
    await runDriver(bn7.ns);
    assert.ok(bn7.g.procs.some(p => p.script === "bn1/daemon.js"), "handed off to the plain daemon");
    assert.ok(!bn7.g.started.includes(bare(P.bladeBoot)));
    // The same node entered plainly is the Bladeburner daemon's.
    const plain7 = fakeGame({ node: 7, ownedSF: [[1, 3], [7, 1]], ram: RAM, home: 128 });
    await runDriver(plain7.ns);
    assert.ok(plain7.g.procs.some(p => p.script === "bn7/daemon.js"));

    // BN13 "without the Gift": accepting it cannot be undone, and the driver
    // used to do it in the node's first second.
    const bn13 = fakeGame({ node: 13, ownedSF: [[1, 3]], options: { ...MARK }, ram: RAM });
    await runDriver(bn13.ns);
    assert.ok(!bn13.g.started.includes(bare(P.stanekBoot)), "the Gift is not accepted in its challenge run");
    const plain13 = fakeGame({ node: 13, ownedSF: [[1, 3]], ram: RAM });
    await runDriver(plain13.ns);
    assert.ok(plain13.g.started.includes(bare(P.stanekBoot)), "an ordinary BN13 run accepts it at once");

    // BN9 without hacknet: the fleet manager is never started.
    const bn9 = fakeGame({ node: 9, ownedSF: [[1, 3], [9, 3]], options: { disableHacknetServer: true, ...MARK }, ram: RAM });
    await runDriver(bn9.ns);
    assert.ok(!bn9.g.started.includes(bare(P.hacknet)));
  } finally {
    if (saved === undefined) delete globalThis.gordStanekState; else globalThis.gordStanekState = saved;
  }
});
