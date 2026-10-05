// tests/econ.test.mjs
// The two spending helpers: lib/econ.js (home RAM, the whole run) and
// lib/hacknet-nodes.js (the early hacknet NODE buyer, only while it is wanted).
// They were one script; they are two so that the long-running one does not
// carry 4.5GB of ns.hacknet.* - and so that "no hacknet spending" is a script
// that is never started rather than a branch inside one that always runs.
// Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { main as hacknetNodesMain, hacknetNodesWanted } from "../lib/hacknet-nodes.js";
import { main as econMain } from "../lib/econ.js";
import { BITNODE, CHALLENGE, CONFIG, forNode, forReset } from "../lib/config.js";

const STOP = new Error("stop the fake script");
const E = CONFIG.econ;

/** A fake `ns` for the two scripts: money, a hacking level, a hacknet shop that records what it sold. */
function fakeNs({ args = [], money = 1e6, hacking = 1, ticks = 1, levelUpTo = null } = {}) {
  const g = { bought: /** @type {string[]} */ ([]), nodes: 0, calls: /** @type {string[]} */ ([]), money, hacking, printed: /** @type {string[]} */ ([]) };
  const sell = (what, cost) => { g.bought.push(what); g.money -= cost; };
  const hn = {
    numNodes: () => g.nodes,
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
    },
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
