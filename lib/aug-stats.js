// lib/aug-stats.js
//
// One-shot: reads every augmentation's stat multipliers once and publishes them
// as globalThis.gordAugStats, then exits. lib/aug-targets.js ranks aug targets by
// what they are worth (lib/aug-value.js), which needs these numbers - and
// getAugmentationStats is 5GB of Singularity that would otherwise sit on home in
// every daemon for a table that never changes. The daemon (lib/daemon-core.js)
// runs this off-home whenever the table is missing; globalThis outlives the
// script, so that is once per page load.
//
// RAM: 1.6 base + getAugmentationsFromFaction (5) + getAugmentationStats (5),
// x the node's Singularity cost multiplier (1x with SF4.3).
//
// Only multipliers that differ from 1 are kept, so an aug with no stats at all
// (The Red Pill, CashRoot) is an empty object - still "known", which is the
// difference between "worth nothing in stats" and "not looked up yet".

import { CONFIG } from "./config.js";

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  const F = CONFIG.factions;

  // Every faction the game has (ns.enums, free), plus the ones config names in
  // case an enum is missing in some version.
  const names = new Set([
    ...Object.values(/** @type {any} */ (ns.enums).FactionName ?? {}),
    ...F.priority,
    ...F.otherTracked,
    ...F.noDonation,
  ]);

  /** @type {Record<string, Record<string, number>>} */
  const stats = {};
  for (const faction of names) {
    let augs = [];
    try { augs = ns.singularity.getAugmentationsFromFaction(/** @type {any} */ (faction)); }
    catch { continue; } // not a faction in this version
    for (const aug of augs) {
      if (stats[aug]) continue;
      try {
        const mults = /** @type {Record<string, number>} */ (/** @type {any} */ (ns.singularity.getAugmentationStats(aug)));
        stats[aug] = Object.fromEntries(Object.entries(mults).filter(([, m]) => typeof m === "number" && m !== 1));
      } catch { /* leave it unknown */ }
    }
  }

  // Published even when empty: the daemon relaunches this while the table is
  // MISSING, and an empty one (which lib/aug-targets.js ignores) must not have
  // it relaunched every tick for the rest of the session.
  const count = Object.keys(stats).length;
  globalThis.gordAugStats = { stats, count, updatedAt: Date.now() };
  ns.print(count
    ? `Published stats for ${count} augmentations.`
    : "WARN: no augmentation stats could be read - aug targets are ranked without them.");
}
