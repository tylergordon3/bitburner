// tests/hacknet-logic.test.mjs
// Unit tests for the pure hacknet-server decision core. Run: npm test  (Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HACKNET_SERVER,
  hashGainRate,
  paybackMs,
  rankUpgrades,
  pickUpgrade,
  planHashSpend,
  activityHints,
} from "../lib/hacknet-logic.js";

const server = (index, level = 1, ram = 1, cores = 1, cache = 1, ramUsed = 0) =>
  ({ index, level, ram, cores, cache, ramUsed });

test("hashGainRate follows the game's formula and its RAM-usage penalty", () => {
  assert.equal(hashGainRate(1, 0, 1, 1), 0.001);                 // base: 0.001 per level
  assert.equal(hashGainRate(10, 0, 1, 1), 0.01);                 // linear in level
  assert.ok(hashGainRate(1, 0, 2, 1) > hashGainRate(1, 0, 1, 1)); // RAM helps
  assert.ok(Math.abs(hashGainRate(1, 0, 1, 6) - 0.002) < 1e-12); // 5 extra cores double it (+20% each)
  assert.equal(hashGainRate(1, 0.5, 1, 1), 0.0005);              // half the RAM used -> half the rate
  assert.equal(hashGainRate(1, 1, 1, 1), 0);                     // fully used -> nothing
  assert.equal(hashGainRate(0, 0, 1, 1), 0);
  assert.equal(hashGainRate(1, 0, 1, 1, 2), 0.002);              // production multiplier
});

test("paybackMs = cost / (gain * $/hash)", () => {
  assert.equal(paybackMs(250_000, 0.001, 250_000), 1_000_000);   // $250k at $250/s -> 1000s
  assert.equal(paybackMs(1, 0, 250_000), Infinity);
  assert.equal(paybackMs(1, 1, 0), Infinity);
});

const rate = (level, ramUsed, ram, cores) => hashGainRate(level, ramUsed, ram, cores);

test("rankUpgrades scores every step by marginal rate per dollar, best first", () => {
  const ranked = rankUpgrades({
    servers: [server(0, 1, 1, 1)],
    costs: [{ level: 100, ram: 1000, cores: 10_000 }],
    purchaseCost: 50_000,
    rate,
  });
  const kinds = ranked.map(c => `${c.kind}:${c.index}`);
  assert.deepEqual(new Set(kinds), new Set(["server:1", "level:0", "ram:0", "core:0"]));
  for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i - 1].score >= ranked[i].score);
  // A $100 level (+0.001/s) beats a $1000 RAM doubling (+7%) by a mile.
  assert.equal(ranked[0].kind, "level");
  const s = ranked.find(c => c.kind === "server");
  assert.equal(s.gain, hashGainRate(1, 0, 1, 1));
});

test("rankUpgrades respects the game's caps and skips unpriced steps", () => {
  const maxed = server(0, HACKNET_SERVER.maxLevel, HACKNET_SERVER.maxRam, HACKNET_SERVER.maxCores);
  const servers = Array.from({ length: HACKNET_SERVER.maxServers }, (_, i) => ({ ...maxed, index: i }));
  const costs = servers.map(() => ({ level: 1, ram: 1, cores: 1 }));
  assert.deepEqual(rankUpgrades({ servers, costs, purchaseCost: 1, rate }), []);

  // Infinity / 0 prices (the game's "can't") never become candidates.
  const some = rankUpgrades({
    servers: [server(0)],
    costs: [{ level: Infinity, ram: 0, cores: -1 }],
    purchaseCost: Infinity,
    rate,
  });
  assert.deepEqual(some, []);
});

test("pickUpgrade takes the best candidate inside budget AND payback", () => {
  const ranked = [
    { kind: "core", index: 0, cost: 1e9, gain: 1, score: 1e-9 },     // best score, over budget
    { kind: "level", index: 0, cost: 100, gain: 1e-9, score: 1e-11 }, // affordable, never pays back
    { kind: "ram", index: 0, cost: 1000, gain: 0.01, score: 1e-5 },   // affordable, pays back fast
  ];
  const dollarsPerHash = 250_000;
  const ok = pickUpgrade(ranked, { budget: 5000, dollarsPerHash, maxPaybackMs: 60_000 });
  assert.equal(ok.pick?.kind, "ram");

  const broke = pickUpgrade(ranked, { budget: 10, dollarsPerHash, maxPaybackMs: 60_000 });
  assert.equal(broke.pick, null);
  assert.equal(broke.reason, "over budget");

  const slow = pickUpgrade(ranked.slice(1, 2), { budget: 5000, dollarsPerHash, maxPaybackMs: 60_000 });
  assert.equal(slow.pick, null);
  assert.equal(slow.reason, "payback too slow");

  assert.equal(pickUpgrade([], { budget: 1, dollarsPerHash, maxPaybackMs: 1 }).reason, "fleet maxed");
});

test("planHashSpend sells everything under cash priority", () => {
  const plan = planHashSpend({
    hashes: 103, capacity: 200, sellCost: 4, cashPriority: true,
    investments: [{ name: "Improve Studying", cost: 50, priority: 1 }],
  });
  assert.deepEqual(plan.actions, [{ name: "Sell for Money", count: 25 }]);
  assert.equal(plan.sellCount, 25);
  assert.equal(plan.saving, null);
});

test("planHashSpend buys affordable investments in priority order, then sells the rest", () => {
  const plan = planHashSpend({
    hashes: 200, capacity: 1000, sellCost: 4,
    investments: [
      { name: "Generate Coding Contract", cost: 100, priority: 3 },
      { name: "Improve Studying", cost: 50, priority: 1 },
      { name: "Reduce Minimum Security", target: "ecorp", cost: 40, priority: 2 },
    ],
  });
  assert.deepEqual(plan.actions.map(a => a.name), [
    "Improve Studying", "Reduce Minimum Security", "Generate Coding Contract", "Sell for Money",
  ]);
  assert.equal(plan.actions[1].target, "ecorp");
  assert.equal(plan.sellCount, 2); // 200 - 190 = 10 left -> 2 sells
});

test("planHashSpend saves toward the top unaffordable investment if the cache can hold it", () => {
  const plan = planHashSpend({
    hashes: 30, capacity: 200, sellCost: 4,
    investments: [
      { name: "Improve Studying", cost: 50, priority: 1 },        // 25% of capacity: wait for it
      { name: "Generate Coding Contract", cost: 20, priority: 3 }, // affordable but less wanted
    ],
  });
  assert.deepEqual(plan.actions, []);        // nothing bought, nothing sold
  assert.equal(plan.saving?.name, "Improve Studying");
  assert.equal(plan.blocked, null);
});

test("planHashSpend skips investments too dear for the cache and reports them as blocked", () => {
  const plan = planHashSpend({
    hashes: 60, capacity: 100, sellCost: 4,
    investments: [
      { name: "Increase Maximum Money", target: "ecorp", cost: 80, priority: 2 }, // 80% of capacity
      { name: "Generate Coding Contract", cost: 20, priority: 3 },
    ],
  });
  assert.equal(plan.blocked?.name, "Increase Maximum Money");
  assert.equal(plan.saving, null);
  assert.deepEqual(plan.actions, [
    { name: "Generate Coding Contract", target: undefined, count: 1 },
    { name: "Sell for Money", count: 10 },
  ]);
});

test("planHashSpend does nothing with fewer hashes than one sale", () => {
  const plan = planHashSpend({ hashes: 3, capacity: 64, sellCost: 4 });
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.sellCount, 0);
});

test("activityHints reads the daemon's action label", () => {
  assert.deepEqual(activityHints("Studying (idle)"), { studying: true, training: false });
  assert.deepEqual(activityHints("Training"), { studying: false, training: true });
  assert.deepEqual(activityHints("Faction Rep"), { studying: false, training: false });
  assert.deepEqual(activityHints(undefined), { studying: false, training: false });
});
