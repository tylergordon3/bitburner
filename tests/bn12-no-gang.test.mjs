// tests/bn12-no-gang.test.mjs
//
// BN12 is carried by the corporation: no karma grind for the player or the
// sleeves, and an idle slot leaves crime alone once money is solved.
import { test } from "node:test";
import assert from "node:assert/strict";

import { forNode } from "../lib/config.js";
import { doIdleWork } from "../lib/player-actions.js";

/** An idle player: no factions, every program owned. Records what the slot was given. */
function fakeNs(node) {
  const g = { crimes: [], studied: 0 };
  const ns = /** @type {any} */ ({
    getPlayer: () => ({ money: 1e40, karma: -100, factions: [], skills: { hacking: 100, strength: 500, defense: 500, dexterity: 500, agility: 500 } }),
    getHackingLevel: () => 100,
    getResetInfo: () => ({ currentNode: node, ownedSF: new Map([[2, 1], [4, 3]]), bitNodeOptions: { sourceFileOverrides: new Map() } }),
    getFavorToDonate: () => 150,
    fileExists: () => true,
    gang: { inGang: () => false },
    print() {},
    singularity: {
      getCrimeChance: () => 1,
      getCrimeStats: () => ({ money: 45_000, karma: 3, time: 3_000 }),
      getCurrentWork: () => null,
      isFocused: () => false,
      getOwnedAugmentations: () => [],
      commitCrime: crime => { g.crimes.push(crime); return 3_000; },
      universityCourse: () => { g.studied++; return true; },
    },
  });
  return { ns, g };
}

async function idleWith(node, solvedAt) {
  const { ns, g } = fakeNs(node);
  globalThis.gordMoneySolvedAt = solvedAt;
  try {
    await doIdleWork(ns);
  } finally {
    delete globalThis.gordMoneySolvedAt;
  }
  return g;
}

test("BN12 grinds no karma; the gang nodes still do", () => {
  assert.equal(forNode(12).gang.activeKarmaGrind, false);
  assert.equal(forNode(12).sleeves.gangKarma, false);
  for (const node of [5, 11]) {
    assert.equal(forNode(node).gang.activeKarmaGrind, true, `BN${node}`);
    assert.equal(forNode(node).sleeves.gangKarma, true, `BN${node}`);
  }
});

test("idle work: no crime in BN12 once money is solved", async () => {
  const g = await idleWith(12, 1);
  assert.deepEqual(g.crimes, []);
  assert.equal(g.studied, 1, "nothing else to do: hacking exp");
});

test("idle work: crime still pays while money is short", async () => {
  assert.notDeepEqual((await idleWith(12, 0)).crimes, []);
});

test("idle work: a node still after its gang keeps the crime, money or no money", async () => {
  assert.notDeepEqual((await idleWith(5, 1)).crimes, []);
});
