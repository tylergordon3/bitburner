// tests/city-factions.test.mjs
// Regression tests for the city-faction join rule. shouldJoinCityFaction touches
// ns, but only two read-only Singularity getters, so a tiny fake ns is enough to
// pin the behaviour that used to deadlock: every city faction declined forever
// because its enemies also still had augs to offer.
// Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldJoinCityFaction } from "../lib/aug-targets.js";

/**
 * @param {Record<string, string[]>} augsByFaction
 * @param {string[]} owned
 */
const fakeNs = (augsByFaction, owned = []) => ({
  singularity: {
    getAugmentationsFromFaction: (f) => augsByFaction[f] ?? [],
    getOwnedAugmentations: () => owned,
  },
  getPlayer: () => ({ factions: [] }),
});

// Sector-12's enemies are Chongqing, New Tokyo, Ishima and Volhaven.
const cityAugs = {
  "Sector-12": ["CashRoot Starter Kit", "Neuralstimulator"],
  "Volhaven": ["DermaForce Particle Barrier"],
  "Chongqing": ["Neuregen Gene Modification"],
  "New Tokyo": ["NutriGen Implant"],
  "Ishima": ["INFRARET Enhancement"],
  "Aevum": ["PCMatrix"],
};

test("joins a city faction that invites us, even though enemies still have augs", () => {
  // The old rule declined here - and since the enemies declined for the same
  // reason, no city faction was ever joined all run.
  assert.equal(shouldJoinCityFaction(fakeNs(cityAugs), "Sector-12", ["Sector-12"]), true);
});

test("declines a city faction with nothing left to offer", () => {
  const owned = cityAugs["Sector-12"];
  assert.equal(shouldJoinCityFaction(fakeNs(cityAugs, owned), "Sector-12", ["Sector-12"]), false);
});

test("prefers an enemy that is inviting us right now and offers more", () => {
  const augs = { ...cityAugs, "Volhaven": ["A", "B", "C"] };
  const pending = ["Sector-12", "Volhaven"];
  assert.equal(shouldJoinCityFaction(fakeNs(augs), "Sector-12", pending), false);
  assert.equal(shouldJoinCityFaction(fakeNs(augs), "Volhaven", pending), true);
});

test("a better enemy that is NOT inviting us doesn't block the invite in hand", () => {
  const augs = { ...cityAugs, "Volhaven": ["A", "B", "C"] };
  assert.equal(shouldJoinCityFaction(fakeNs(augs), "Sector-12", ["Sector-12"]), true);
});

test("ties go to joining, so two mutual enemies can't deadlock each other", () => {
  const augs = { ...cityAugs, "Volhaven": ["A", "B"] }; // same count as Sector-12
  const pending = ["Sector-12", "Volhaven"];
  assert.equal(shouldJoinCityFaction(fakeNs(augs), "Sector-12", pending), true);
});

test("non-city factions are always joined", () => {
  // CyberSec has no enemy list at all - it must never be filtered out.
  assert.equal(shouldJoinCityFaction(fakeNs({}), "CyberSec", []), true);
  assert.equal(shouldJoinCityFaction(fakeNs({}), "BitRunners", ["BitRunners"]), true);
});
