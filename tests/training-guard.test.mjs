// tests/training-guard.test.mjs
// Classes and the gym bill per second with no balance check, so the player's
// paid training only starts with the money for it (lib/player-actions.js):
// study falls back to the free course, the gym to a crime. BN13 sat at -$35m
// studying Algorithms with nothing coming in.
// Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { trainingAffordable, studyHacking, trainCombatIfNeeded } from "../lib/player-actions.js";
import { CONFIG } from "../lib/config.js";

const PL = CONFIG.player;

/** A fake ns that records which course, workout or crime was started. */
function fakeNs({ money, skills = { strength: 1, defense: 1, dexterity: 1, agility: 1 }, chances = {} }) {
  const g = { started: /** @type {string[]} */ ([]) };
  const ns = /** @type {any} */ ({
    read: () => "",
    getPlayer: () => ({ money, skills }),
    singularity: {
      universityCourse: (_where, course) => { g.started.push(`class:${course}`); return true; },
      gymWorkout: (_where, stat) => { g.started.push(`gym:${stat}`); return true; },
      getCrimeChance: crime => chances[crime] ?? 0,
      getCurrentWork: () => null,
      commitCrime: crime => { g.started.push(`crime:${crime}`); return 1; },
      getOwnedAugmentations: () => [],
      setFocus: () => true,
    },
  });
  return { ns, g };
}

test("trainingAffordable: the cushion's worth in hand, and never in debt", () => {
  const cushion = PL.studyCostPerSec * PL.trainingCushionSec;
  assert.equal(trainingAffordable(cushion, PL.studyCostPerSec), true);
  assert.equal(trainingAffordable(cushion - 1, PL.studyCostPerSec), false);
  assert.equal(trainingAffordable(-35e6, PL.studyCostPerSec), false);
  assert.equal(trainingAffordable(0, 0), false, "a zero balance is not a balance");
});

test("study: the paid course with the money for it, else the free one", () => {
  const rich = fakeNs({ money: 1e9 });
  assert.equal(studyHacking(rich.ns), "");
  assert.deepEqual(rich.g.started, [`class:${PL.studyClass}`]);

  const broke = fakeNs({ money: -35e6 });
  assert.match(studyHacking(broke.ns), /unaffordable/);
  assert.deepEqual(broke.g.started, [`class:${PL.freeStudyClass}`]);
});

test("combat: the gym with the money for it, else a crime - unless the caller accepts a debt", async () => {
  const join = { strength: 100, defense: 100, dexterity: 100, agility: 100 };

  const rich = fakeNs({ money: 1e9 });
  assert.equal((await trainCombatIfNeeded(rich.ns, join))?.action, "Training");
  assert.deepEqual(rich.g.started, ["gym:str"]);

  // Broke, stats of 1: the easiest crime (no crime clears crimeMinChance).
  const broke = fakeNs({ money: 0, chances: { Mug: 0.1, Shoplift: 0.4 } });
  const r = await trainCombatIfNeeded(broke.ns, join);
  assert.match(r?.detail ?? "", /gym is unaffordable/);
  assert.deepEqual(broke.g.started, ["crime:Shoplift"]);

  // Mug once it is landed reliably.
  const mugger = fakeNs({ money: 0, chances: { Mug: 0.9, Shoplift: 1 } });
  await trainCombatIfNeeded(mugger.ns, join);
  assert.deepEqual(mugger.g.started, ["crime:Mug"]);

  // The first trip to the Bladeburner gate takes the debt (contracts repay it).
  const gate = fakeNs({ money: 0 });
  await trainCombatIfNeeded(gate.ns, join, { allowDebt: true });
  assert.deepEqual(gate.g.started, ["gym:str"]);

  // Nothing to train: nothing started.
  const done = fakeNs({ money: 0, skills: join });
  assert.equal(await trainCombatIfNeeded(done.ns, join), null);
  assert.deepEqual(done.g.started, []);
});
