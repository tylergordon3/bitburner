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
} from "../lib/gang-logic.js";
import { CONFIG } from "../lib/config.js";

const TABLE = /** @type {[number, number][]} */ (CONFIG.gang.ascendThresholds);

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
