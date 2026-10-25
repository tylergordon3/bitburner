// tests/econ.test.mjs
// The two spending helpers: lib/econ.js (home RAM, the whole run) and
// lib/hacknet-nodes.js (the early hacknet NODE buyer, only while it is wanted).
// They were one script; they are two so that the long-running one does not
// carry 5GB of ns.hacknet.* - and so that "no hacknet spending" is a script
// that is never started rather than a branch inside one that always runs.
// Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { main as hacknetNodesMain, hacknetNodesWanted, nodeUpgradeGains, newNodeGain, pickNodeBuy } from "../lib/hacknet-nodes.js";
import { main as econMain, fleetFull, homeUpgradeWanted } from "../lib/econ.js";
import { BITNODE, CHALLENGE, CONFIG, forNode, forReset } from "../lib/config.js";

const STOP = new Error("stop the fake script");
const E = CONFIG.econ;

/** A fake `ns` for the two scripts: money, a hacking level, a hacknet shop that records what it sold. */
function fakeNs({ args = [], money = 1e6, hacking = 1, ticks = 1, levelUpTo = null, rate = 1, fleet = { limit: 0, maxRam: 0, servers: {} }, coreCost = 1e9 } = {}) {
  const g = { bought: /** @type {string[]} */ ([]), nodes: 0, calls: /** @type {string[]} */ ([]), money, hacking, printed: /** @type {string[]} */ ([]) };
  const sell = (what, cost) => { g.bought.push(what); g.money -= cost; };
  const hn = {
    numNodes: () => g.nodes,
    // A level-1, 1GB, 1-core node earning 1.5/s x `rate` (the node and player multipliers).
    getNodeStats: () => ({ level: 1, ram: 1, cores: 1, production: 1.5 * rate }),
    getPurchaseNodeCost: () => 1_000,
    purchaseNode: () => { sell("node", 1_000); return g.nodes++; },
    getLevelUpgradeCost: () => 5_000,
    getRamUpgradeCost: () => 30_000,
    getCoreUpgradeCost: () => 500_000,
    upgradeLevel: () => { sell("level", 5_000); return true; },
    upgradeRam: () => { sell("ram", 30_000); return true; },
    upgradeCore: () => { sell("core", 500_000); return true; },
  };
  const ns = /** @type {any} */ ({
    args,
    disableLog() {},
    print: msg => g.printed.push(String(msg)),
    tprint: msg => g.printed.push(String(msg)),
    getPlayer: () => ({ money: g.money, skills: { hacking: g.hacking } }),
    getHackingLevel: () => g.hacking,
    sleep: async () => {
      if (levelUpTo != null) g.hacking = levelUpTo;
      if (--ticks <= 0) throw STOP;
    },
    // Any touch of the namespace is recorded, not just a purchase.
    get hacknet() { g.calls.push("hacknet"); return hn; },
    singularity: {
      getUpgradeHomeRamCost: () => 100_000,
      upgradeHomeRam: () => { g.bought.push("home-ram"); g.money -= 100_000; return true; },
      getUpgradeHomeCoresCost: () => coreCost,
      upgradeHomeCores: () => { g.bought.push("home-core"); g.money -= coreCost; return true; },
    },
    // The purchased-server fleet (lib/econ.js only spends once it is full).
    cloud: {
      getServerLimit: () => fleet.limit,
      getRamLimit: () => fleet.maxRam,
      getServerNames: () => Object.keys(fleet.servers),
    },
    getServerMaxRam: h => fleet.servers[h] ?? 0,
  });
  return { ns, g };
}

/** Run a script's main until it returns or the fake stops it; true if it returned by itself. */
async function run(main, ns) {
  try {
    await main(ns);
    return true;
  } catch (e) {
    if (e !== STOP) throw e;
    return false;
  }
}

test("hacknetNodesWanted: only where the config has it on, and only up to the level cap", () => {
  assert.equal(hacknetNodesWanted(E, 1), true);
  assert.equal(hacknetNodesWanted(E, E.hacknetMaxHackingLevel), true);
  assert.equal(hacknetNodesWanted(E, E.hacknetMaxHackingLevel + 1), false);
  assert.equal(hacknetNodesWanted({ ...E, hacknetNodes: false }, 1), false);
  // Anything but a literal `true` is off: a missing section must not buy.
  assert.equal(hacknetNodesWanted(undefined, 1), false);
  assert.equal(hacknetNodesWanted({}, 1), false);
  assert.equal(hacknetNodesWanted({ hacknetNodes: 1, hacknetMaxHackingLevel: 200 }, 1), false);
});

test("the switch is absolute in BN9's challenge run, and off in every node that turns the buyer off", () => {
  // The run's config is what the daemon launches on (lib/daemon-core.js).
  const challenge9 = forReset({
    currentNode: 9, ownedSF: new Map([[9, 1]]),
    bitNodeOptions: { ...CHALLENGE[9].options, sourceFileOverrides: new Map([[1, 3]]) },
  });
  assert.equal(challenge9.econ.hacknetNodes, false);
  for (const level of [1, 50, 200, 5_000]) assert.equal(hacknetNodesWanted(challenge9.econ, level), false);
  // ...and the node's own config is what the script checks: wherever a challenge
  // overlay turns the buyer off, the node's ordinary config must have it off
  // too, or a copy started by hand in that run would buy.
  for (const [node, entry] of Object.entries(CHALLENGE)) {
    if (entry.config?.econ?.hacknetNodes === false) {
      assert.equal(forNode(Number(node)).econ.hacknetNodes, false, `BN${node}`);
    }
  }
  for (const node of Object.keys(BITNODE).map(Number)) {
    if (BITNODE[node].econ?.hacknetNodes === false) assert.equal(hacknetNodesWanted(forNode(node).econ, 1), false, `BN${node}`);
  }
});

test("hacknet-nodes.js buys nodes and their cheapest upgrades out of a slice of cash while it is wanted", async () => {
  const { ns, g } = fakeNs({ args: [4], money: 100_000, hacking: 10 });
  assert.equal(await run(hacknetNodesMain, ns), false, "still wanted: it sleeps for the next pass");
  // 20% of $100k = $20k: the cheapest thing on offer each round - nodes at $1k
  // up to hacknetMaxNodes, then level upgrades at $5k while the slice lasts.
  assert.equal(g.nodes, E.hacknetMaxNodes);
  assert.deepEqual(g.bought, [...Array(E.hacknetMaxNodes).fill("node"), "level", "level"]);
  assert.ok(100_000 - g.money <= 100_000 * E.hacknetBudgetFraction);
});

test("hacknet-nodes.js buys nothing that will not pay for itself within hacknetPaybackMs", async () => {
  // A node paying a tenth of normal: the first node is bought on the player's
  // own multiplier (nothing to measure yet), and its measured rate then says
  // neither a second node nor a level pays back inside the hour.
  const { ns, g } = fakeNs({ args: [4], money: 1e9, hacking: 10, rate: 0.1 });
  await run(hacknetNodesMain, ns);
  assert.deepEqual(g.bought, ["node"]);
});

test("hacknet payback model: gains follow the game's production formula", () => {
  const n = { level: 10, ram: 4, cores: 2, production: 10 * 1.5 * 1.035 ** 3 * 7 / 6 };
  const g = nodeUpgradeGains(n);
  const prod = (/** @type {number} */ l, /** @type {number} */ r, /** @type {number} */ c) => l * 1.5 * 1.035 ** (r - 1) * (c + 5) / 6;
  assert.ok(Math.abs(g.level - (prod(11, 4, 2) - prod(10, 4, 2))) < 1e-9);
  assert.ok(Math.abs(g.ram - (prod(10, 8, 2) - prod(10, 4, 2))) < 1e-9);
  assert.ok(Math.abs(g.core - (prod(10, 4, 3) - prod(10, 4, 2))) < 1e-9);
  // A new node at the fleet's measured multiplier (here 0.4), else the fallback.
  assert.ok(Math.abs(newNodeGain([{ ...n, production: n.production * 0.4 }], 9) - 1.5 * 0.4) < 1e-9);
  assert.equal(newNodeGain([], 2), 3);
  // Soonest payback wins; over the horizon or over budget is never picked.
  const opts = [{ cost: 100, gain: 1 }, { cost: 50, gain: 0.25 }, { cost: 10_000, gain: 1_000 }];
  assert.equal(pickNodeBuy(opts, 1_000, 3_600), opts[0]);
  assert.equal(pickNodeBuy(opts, 1e6, 3_600), opts[2]);
  assert.equal(pickNodeBuy(opts, 1_000, 60), null);
  assert.equal(pickNodeBuy([{ cost: 10, gain: 0 }], 1e6, 1e9), null);
});

test("hacknet-nodes.js exits by itself past the level cap - before the first purchase, or between two", async () => {
  const late = fakeNs({ args: [4], hacking: E.hacknetMaxHackingLevel + 1 });
  assert.equal(await run(hacknetNodesMain, late.ns), true);
  assert.deepEqual(late.g.calls, [], "the hacknet API was never touched");

  const grown = fakeNs({ args: [4], hacking: 10, ticks: 5, levelUpTo: E.hacknetMaxHackingLevel + 1 });
  assert.equal(await run(hacknetNodesMain, grown.ns), true);
  assert.ok(grown.g.bought.length > 0, "one pass was made");
});

test("hacknet-nodes.js refuses to run where its node has the buyer off, or when it is not told the node", async () => {
  for (const node of [6, 7, 8, 9]) {
    const off = fakeNs({ args: [node], hacking: 1 });
    assert.equal(await run(hacknetNodesMain, off.ns), true, `BN${node}`);
    assert.deepEqual(off.g.calls, [], `BN${node}: the hacknet API was never touched`);
    assert.deepEqual(off.g.bought, []);
  }
  // No argument is not "the defaults" (which would buy): a copy started by hand
  // in a challenge run must not be what forfeits it.
  for (const args of [[], [0], ["x"]]) {
    const blind = fakeNs({ args, hacking: 1 });
    assert.equal(await run(hacknetNodesMain, blind.ns), true);
    assert.deepEqual(blind.g.calls, []);
    assert.match(blind.g.printed.join("\n"), /usage/);
  }
});

test("econ.js buys home RAM and nothing else: no hacknet call is left in it to pay for", async () => {
  const { ns, g } = fakeNs({ args: [0, 4], money: 1e6, hacking: 1 });
  assert.equal(await run(econMain, ns), false);
  assert.deepEqual(g.bought, ["home-ram"]);
  assert.deepEqual(g.calls, []);
  // The game bills a script for every ns name in it, called or not.
  const src = readFileSync(new URL("../lib/econ.js", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
  assert.ok(!/\.hacknet\b|numNodes|purchaseNode|UpgradeCost/.test(src), "lib/econ.js still names a hacknet call");

  // The reserve is honoured as before: the caller's (arg 0) keeps the money untouched.
  const held = fakeNs({ args: [950_000, 2], money: 1e6 });
  await run(econMain, held.ns);
  assert.deepEqual(held.g.bought, []);
});

test("econ.js: home RAM and cores only once the server fleet is full - every slot, every server at the cap", async () => {
  const servers = n => Object.fromEntries(Array.from({ length: n }, (_, i) => [`cloud-${i}`, 1024]));
  const buys = async fleet => {
    const { ns, g } = fakeNs({ args: [0, 4], money: 1e7, fleet, coreCost: 2e6 });
    await run(econMain, ns);
    return g.bought;
  };
  // A slot free, or a server under the cap: the money is the fleet's.
  assert.deepEqual(await buys({ limit: 25, maxRam: 1024, servers: servers(24) }), []);
  assert.deepEqual(await buys({ limit: 25, maxRam: 1024, servers: { ...servers(25), "cloud-3": 512 } }), []);
  // Full: home RAM, then a core.
  assert.deepEqual(await buys({ limit: 25, maxRam: 1024, servers: servers(25) }), ["home-ram", "home-core"]);
  // A dedicated host (cloud-gang, sized for its manager) takes a slot but is never "under the cap".
  globalThis.gordReservedHosts = new Set(["cloud-gang"]);
  try {
    assert.deepEqual(await buys({ limit: 25, maxRam: 1024, servers: { ...servers(24), "cloud-gang": 64 } }), ["home-ram", "home-core"]);
  } finally {
    delete globalThis.gordReservedHosts;
  }
  // No servers for sale in this node (BN9): home is the only RAM - bought as before.
  assert.deepEqual(await buys({ limit: 0, maxRam: 0, servers: {} }), ["home-ram", "home-core"]);
});

test("econ.js in BN8 (homeBeforeFleet): home first, out of the allowance the floor leaves", async () => {
  // 25 x 256GB against a 1PB cap: never "full" there - and an install deletes it.
  const fleet = { limit: 25, maxRam: 2 ** 20, servers: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`cloud-${i}`, 256])) };
  const buys = async (node, floor) => {
    const { ns, g } = fakeNs({ args: [0, node], money: 1e7, fleet, coreCost: 2e6 });
    if (floor != null) globalThis.gordMoneyFloor = floor;
    try {
      await run(econMain, ns);
    } finally {
      delete globalThis.gordMoneyFloor;
    }
    return g.bought;
  };
  assert.deepEqual(await buys(4), [], "every other node: the fleet comes first");
  assert.deepEqual(await buys(8), ["home-ram", "home-core"]);
  // The treasury's fence: $50k of allowance does not buy a $100k upgrade...
  assert.deepEqual(await buys(8, 1e7 - 50_000), []);
  // ...$150k buys the RAM (all of the allowance may go on it: maxFraction 1) but not the $2m core.
  assert.deepEqual(await buys(8, 1e7 - 150_000), ["home-ram"]);
});

test("homeUpgradeWanted / fleetFull: the rules on their own", () => {
  const base = { full: true, cost: 100, money: 1_000, reserve: 0, maxFraction: 0.4 };
  assert.equal(homeUpgradeWanted(base), true);
  assert.equal(homeUpgradeWanted({ ...base, full: false }), false);
  assert.equal(homeUpgradeWanted({ ...base, cost: 500 }), false, "over the cash fraction");
  assert.equal(homeUpgradeWanted({ ...base, reserve: 950 }), false, "eats the reserve");
  assert.equal(homeUpgradeWanted({ ...base, cost: Infinity }), false);
  assert.equal(fleetFull({ limit: 2, maxRam: 8, rams: [8, 8] }, 2), true);
  assert.equal(fleetFull({ limit: 2, maxRam: 8, rams: [8] }, 1), false);
  assert.equal(fleetFull({ limit: 2, maxRam: 8, rams: [8, 4] }, 2), false);
  assert.equal(fleetFull({ limit: 0, maxRam: 0, rams: [] }, 0), true);
});
