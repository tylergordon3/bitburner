// tests/sleeves-lite.test.mjs
// lib/sleeves-lite.js: the sleeves' crime-only stand-in while the 72GB manager
// has no host. Every sleeve on its best crime - by money, or by karma where the
// gang is being ground toward - never restarting the one it is on, and gone the
// moment the full manager publishes fresh state.
// Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../lib/sleeves-lite.js";

const STOP = new Error("stop the fake script");

/** `n` sleeves; every crime lands at `chance`, paying `money[crime]`. */
function fakeNs({ n = 2, args = [], karma = 0, formulas = true, money = {}, chance = 1, tasks = {} }) {
  const g = { set: /** @type {string[]} */ ([]) };
  const ns = /** @type {any} */ ({
    args,
    disableLog() {},
    print() {},
    fileExists: () => formulas,
    getPlayer: () => ({ karma }),
    sleeve: {
      getSleeve: i => { if (i >= n) throw new Error("no such sleeve"); return { i }; },
      getTask: i => tasks[i] ?? null,
      setToCommitCrime: (i, crime) => { g.set.push(`${i}:${crime}`); return true; },
    },
    formulas: { work: {
      crimeSuccessChance: () => chance,
      crimeGains: (_p, crime) => ({ money: money[crime] ?? 0 }),
    } },
    sleep: async () => { throw STOP; },
  });
  return { ns, g };
}

async function run(ns) {
  try { await main(ns); return true; } catch (e) { if (e !== STOP) throw e; return false; }
}

test("sleeves-lite: every sleeve on the best money crime per second, the one it is on left alone", async () => {
  delete globalThis.gordSleeveState;
  // Homicide $45k / 3s (15k/s) beats Mug $36k / 4s (9k/s) and Shoplift $15k / 2s.
  const money = { Shoplift: 15_000, Mug: 36_000, Homicide: 45_000 };
  const { ns, g } = fakeNs({ n: 3, money, tasks: { 1: { type: "CRIME", crimeType: "Homicide" } } });
  assert.equal(await run(ns), false, "it keeps going while the manager is away");
  assert.deepEqual(g.set, ["0:Homicide", "2:Homicide"]);
});

test("sleeves-lite: karma first where the gang is ground toward, until the player is past the gate", async () => {
  delete globalThis.gordSleeveState;
  const money = { Shoplift: 15_000, Larceny: 1e9 };
  const grind = fakeNs({ n: 1, args: [-54_000], karma: -100, money });
  await run(grind.ns);
  assert.deepEqual(grind.g.set, ["0:Homicide"], "3 karma / 3s is the best karma rate");
  const past = fakeNs({ n: 1, args: [-54_000], karma: -60_000, money });
  await run(past.ns);
  assert.deepEqual(past.g.set, ["0:Larceny"], "past the gate: money again");
});

test("sleeves-lite: shoplifts without Formulas.exe, exits with no sleeves, and hands over to a live manager", async () => {
  delete globalThis.gordSleeveState;
  const blind = fakeNs({ n: 1, formulas: false });
  await run(blind.ns);
  assert.deepEqual(blind.g.set, ["0:Shoplift"]);

  assert.equal(await run(fakeNs({ n: 0 }).ns), true, "no sleeves in this run: it exits");

  globalThis.gordSleeveState = { updatedAt: Date.now() };
  const handed = fakeNs({ n: 2, money: { Shoplift: 1 } });
  assert.equal(await run(handed.ns), true);
  assert.deepEqual(handed.g.set, [], "the full manager has the sleeves");
  delete globalThis.gordSleeveState;
});
