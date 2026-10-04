// tests/gang-logic.test.mjs
// The pure gang decisions (lib/gang-logic.js): the ascension threshold table,
// the territory-tick clock, and who trains.
// Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ascendThreshold,
  chooseAscension,
  nextTerritoryClock,
  territoryTickSeen,
  chooseTrainers,
  TERRITORY_TICK_MS,
  moneyGain,
  respectGain,
  wantedGain,
  inferSoftcap,
} from "../lib/gang-logic.js";
import { CONFIG } from "../lib/config.js";

const TABLE = /** @type {[number, number][]} */ (CONFIG.gang.ascendThresholds);

// ── The game's gain formulas (bitburner-src Gang/formulas/formulas.ts) ───────

// A strength-only task, so the stat weight is just the member's strength.
const TASK = {
  baseMoney: 10, baseRespect: 0.001, baseWanted: 0.5, difficulty: 5,
  hackWeight: 0, strWeight: 100, defWeight: 0, dexWeight: 0, agiWeight: 0, chaWeight: 0,
  territory: { money: 1.5, respect: 1, wanted: 1 },
};
const MEMBER = { hack: 1, str: 100, def: 1, dex: 1, agi: 1, cha: 1 };
// territory 25% -> exponent 0.2 * 0.25 + 0.8 = 0.85; wanted penalty 900 / 1000.
const GANG = { respect: 900, wantedLevel: 100, territory: 0.25 };
const near = (a, b) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${a} vs ${b}`);

test("money and respect are raised to the territory power - both of them", () => {
  // money: (5 * base * (str - 3.2 * difficulty) * territoryMult * penalty) ^ 0.85,
  // territoryMult = 25^1.5 / 100 = 1.25. The old replica returned the bare
  // product (4725) - the game's figure is its 0.85th power (~1330).
  near(moneyGain(GANG, MEMBER, TASK), Math.pow(5 * 10 * 84 * 1.25 * 0.9, 0.85));
  // respect: (11 * base * (str - 4 * difficulty) * (25 / 100) * penalty) ^ 0.85
  near(respectGain(GANG, MEMBER, TASK), Math.pow(11 * 0.001 * 80 * 0.25 * 0.9, 0.85));
  // wanted: 7 * base / (3 * (str - 3.5 * difficulty) * territoryMult) ^ 0.8, no floor
  near(wantedGain(GANG, MEMBER, TASK), (7 * 0.5) / Math.pow(3 * 82.5 * 0.25, 0.8));
});

test("the BitNode's GangSoftcap multiplies that power", () => {
  near(moneyGain(GANG, MEMBER, TASK, 0.7), Math.pow(4725, 0.85 * 0.7));     // BN6/7/14
  near(respectGain(GANG, MEMBER, TASK, 0.3), Math.pow(0.198, 0.85 * 0.3)); // BN13
  // A base under 1 GROWS under a softcap (0.198^0.255 > 0.198^0.85): the wanted
  // filter in lib/gang.js compares respect with wanted, so this is not cosmetic.
  assert.ok(respectGain(GANG, MEMBER, TASK, 0.3) > respectGain(GANG, MEMBER, TASK));
});

test("gains are zero below the task's stat floor, and wanted is capped and signed", () => {
  const weak = { ...MEMBER, str: 10 };
  assert.equal(moneyGain(GANG, weak, TASK), 0);      // 10 - 16 <= 0
  assert.equal(respectGain(GANG, weak, TASK), 0);    // 10 - 20 <= 0
  assert.equal(wantedGain(GANG, weak, TASK), 0);     // 10 - 17.5 <= 0
  assert.equal(moneyGain(GANG, MEMBER, { ...TASK, baseMoney: 0 }), 0);
  assert.equal(wantedGain(GANG, { ...MEMBER, str: 17.501 }, TASK), 100); // tiny denominator -> the game's cap
  // Vigilante-style tasks lower it: 0.4 * base * weight * territoryMult.
  near(wantedGain(GANG, MEMBER, { ...TASK, baseWanted: -0.001 }), 0.4 * -0.001 * 82.5 * 0.25);
});

test("inferSoftcap recovers the node's multiplier from a member's reported gain", () => {
  for (const cap of [1, 0.9, 0.7, 0.3]) {
    const reported = { ...MEMBER, moneyGain: moneyGain(GANG, MEMBER, TASK, cap), respectGain: 0 };
    near(inferSoftcap(GANG, reported, TASK), cap);
    // Respect alone (a respect-only task) works too.
    const viaRespect = { ...MEMBER, moneyGain: 0, respectGain: respectGain(GANG, MEMBER, TASK, cap) };
    near(inferSoftcap(GANG, viaRespect, TASK), cap);
  }
  // Nothing to read: idle, training (no money or respect), or an unknown task.
  assert.equal(inferSoftcap(GANG, { ...MEMBER, moneyGain: 0, respectGain: 0 }, TASK), null);
  assert.equal(inferSoftcap(GANG, { ...MEMBER, moneyGain: 5, respectGain: 5 }, undefined), null);
  // A base of ~1 fits every exponent - no reading, rather than a wild one.
  const flat = { ...TASK, baseMoney: 1 / (5 * 84 * 1.25 * 0.9), baseRespect: 0 };
  assert.equal(inferSoftcap(GANG, { ...MEMBER, moneyGain: 1, respectGain: 0 }, flat), null);
});

test("the ascension bar falls as the member's multiplier grows", () => {
  assert.equal(ascendThreshold(1, TABLE), 1.6326);
  assert.equal(ascendThreshold(3, TABLE), 1.2125);
  assert.equal(ascendThreshold(100, TABLE), 1.0591);
  // Monotone, and the table itself is ascending.
  for (let i = 1; i < TABLE.length; i++) {
    assert.ok(TABLE[i][0] > TABLE[i - 1][0]);
    assert.ok(TABLE[i][1] < TABLE[i - 1][1]);
  }
});

test("REGRESSION: a strong member still ascends (the flat x1.5 bar was out of its reach)", () => {
  const o = { table: TABLE, rosterFull: true, gangRespect: 1e6, respectFraction: 0.4 };
  // x1.2 on a x5 member: worth taking now, refused by a flat 1.5.
  const pick = chooseAscension([{ name: "a", ascMult: 5, gain: 1.2, respect: 0 }], o);
  assert.equal(pick.name, "a");
  // The same x1.2 on a fresh member is not.
  assert.equal(chooseAscension([{ name: "b", ascMult: 1, gain: 1.2, respect: 0 }], o), null);
});

test("one ascension per update - the member furthest past its own bar", () => {
  const o = { table: TABLE, rosterFull: true, gangRespect: 1e6, respectFraction: 0.4 };
  const pick = chooseAscension([
    { name: "barely", ascMult: 1, gain: 1.64, respect: 0 },   // 1.004x its bar
    { name: "well", ascMult: 5, gain: 1.4, respect: 0 },      // 1.247x its bar
    { name: "no", ascMult: 1, gain: 1.1, respect: 0 },
  ], o);
  assert.equal(pick.name, "well");
  assert.equal(chooseAscension([], o), null);
});

test("while recruiting, an ascension may not take the respect the next recruit needs", () => {
  const m = [{ name: "a", ascMult: 1, gain: 2, respect: 500 }];
  assert.equal(chooseAscension(m, { table: TABLE, rosterFull: false, gangRespect: 1000, respectFraction: 0.4 }), null);
  assert.equal(chooseAscension(m, { table: TABLE, rosterFull: true, gangRespect: 1000, respectFraction: 0.4 }).name, "a");
  assert.equal(chooseAscension(m, { table: TABLE, rosterFull: false, gangRespect: 5000, respectFraction: 0.4 }).name, "a");
});

// ── Territory clock ──────────────────────────────────────────────────────────

const START = { progressMs: 0, synced: false, waitUpdates: 0, preTick: false };

/** Run the clock over a list of updates; a "T" marks the update containing the tick. */
function runClock(updates, state = START) {
  const pre = [];
  for (const u of updates) {
    state = nextTerritoryClock(state, { durationMs: u.ms, tickSeen: !!u.tick });
    pre.push(state.preTick);
  }
  return { state, pre };
}

test("territoryTickSeen: any other gang's power changing is the tick", () => {
  assert.equal(territoryTickSeen(null, { a: 1 }), false);
  assert.equal(territoryTickSeen({ a: 1, b: 2 }, { a: 1, b: 2 }), false);
  assert.equal(territoryTickSeen({ a: 1, b: 2 }, { a: 1, b: 2.5 }), true);
  assert.equal(territoryTickSeen({ a: 1 }, { a: 1, c: 9 }), false); // a newcomer isn't a change
});

test("the clock predicts nothing until it has seen a tick", () => {
  const { pre, state } = runClock(Array(15).fill({ ms: 2000 }));
  assert.ok(pre.every(p => p === false));
  assert.equal(state.synced, false);
});

test("in step: exactly one pre-tick update in ten, and it is the one before the tick", () => {
  // Sync on a tick, then 3 full cycles of ten 2s updates with the tick in the tenth.
  const cycle = [...Array(9).fill({ ms: 2000 }), { ms: 2000, tick: true }];
  const { pre } = runClock([{ ms: 2000, tick: true }, ...cycle, ...cycle, ...cycle]);
  const afterSync = pre.slice(1);
  for (let c = 0; c < 3; c++) {
    const flags = afterSync.slice(c * 10, c * 10 + 10);
    // preTick is raised AFTER the 9th update (index 8): the next one has the tick.
    assert.deepEqual(flags, [false, false, false, false, false, false, false, false, true, false], `cycle ${c}`);
  }
  assert.equal(TERRITORY_TICK_MS, 20_000);
});

test("bonus time: 5s updates, so the tick is every fourth", () => {
  const cycle = [...Array(3).fill({ ms: 5000 }), { ms: 5000, tick: true }];
  const { pre } = runClock([{ ms: 5000, tick: true }, ...cycle, ...cycle]);
  assert.deepEqual(pre.slice(1), [false, false, true, false, false, false, true, false]);
});

test("a tick that comes one update late keeps the roster on warfare until it lands", () => {
  const late = [...Array(10).fill({ ms: 2000 }), { ms: 2000, tick: true }];
  const { pre, state } = runClock([{ ms: 2000, tick: true }, ...late]);
  assert.deepEqual(pre.slice(9), [true, true, false]); // 9th and 10th updates wait, 11th saw it
  assert.equal(state.synced, true);
});

test("a tick that never comes: give up after maxWaitUpdates and wait to re-sync", () => {
  const { state, pre } = runClock([{ ms: 2000, tick: true }, ...Array(20).fill({ ms: 2000 })]);
  assert.equal(state.synced, false);
  assert.equal(pre.filter(Boolean).length, 3, "on warfare for the predicted update plus the wait, no longer");
  // ...and it picks the rhythm back up at the next tick it sees.
  const again = runClock([{ ms: 2000, tick: true }, ...Array(9).fill({ ms: 2000 })], state);
  assert.equal(again.pre[9], true);
});

// ── Training ─────────────────────────────────────────────────────────────────

const TR = { trainMinStat: 60, trainUntilAscMult: 6, maxTrainFraction: 0.5, rosterFull: true };
const mem = (name, stat, ascMult) => ({ name, stat, ascMult });

test("weak members always train; while recruiting nobody else is held back", () => {
  const roster = [mem("new", 10, 1), mem("old", 500, 1.2), mem("vet", 900, 7)];
  assert.deepEqual([...chooseTrainers(roster, { ...TR, rosterFull: false })], ["new"]);
});

test("a full roster trains its lowest multipliers, up to half, until the target", () => {
  const roster = [mem("a", 500, 1), mem("b", 500, 2), mem("c", 500, 3), mem("d", 500, 7), mem("e", 500, 8), mem("f", 500, 9)];
  assert.deepEqual([...chooseTrainers(roster, TR)].sort(), ["a", "b", "c"]);
  // Everyone past the target: all work.
  assert.equal(chooseTrainers(roster.map(m => ({ ...m, ascMult: 6 })), TR).size, 0);
  // The cap counts the weak ones too, so the roster never trains more than half.
  const mixed = [mem("w1", 10, 1), mem("w2", 10, 1), mem("a", 500, 1), mem("b", 500, 2), mem("c", 500, 3), mem("d", 500, 4)];
  assert.deepEqual([...chooseTrainers(mixed, TR)].sort(), ["a", "w1", "w2"]);
});

test("the configured gang knobs are coherent", () => {
  const G = CONFIG.gang;
  assert.ok(G.maxTrainFraction > 0 && G.maxTrainFraction < 1);
  assert.ok(G.trainUntilAscMult > 1);
  assert.ok(G.warfareMinDef >= G.warfareMinStat);
});
