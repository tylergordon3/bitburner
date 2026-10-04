// lib/capabilities.js
//
// Centralized, near-free detection of which gated APIs are usable this run. Every
// Source-File/BitNode-gated API (Singularity, Gang, Corporation, Sleeves,
// Grafting, Bladeburner, Hacknet-Server, Stanek) is available when you're either
// physically IN its BitNode or hold its Source-File - that's a pure function of
// ns.getResetInfo() (1GB, once), so this module replaces the scattered
// try/catch probes (numSleevesSafe, graftingApiAvailable, inGangSafe, ...) with
// one cheap, reusable, testable check.
//
// Structure mirrors the rest of the codebase: the decision logic is a set of PURE
// functions taking a plain resetInfo object (unit-testable under Node with no
// Netscript stub - see tests/capabilities.test.mjs), and getCapabilities(ns) is a
// thin wrapper that reads ns.getResetInfo() once and hands it to them. Idea ported
// from ame824/autoDoIt's core/capabilities.js + lib/logic.js.
//
// RAM: the pure functions cost nothing to import (like lib/config.js). Only
// getCapabilities() names ns.getResetInfo, which the game bills at 1GB
// (RamCostGenerator.ts) - a script that already calls it pays nothing extra.

import { CHALLENGE, isChallengeRun } from "./config.js";

// SF/BN gate for each API: available when currentNode is one of `nodes` OR any of
// `sourceFiles` is owned at level >= 1. (nodes and sourceFiles are the same number
// for every current API, but kept as separate lists to match the game's model and
// leave room for exceptions.)
const GATES = {
  singularity: { nodes: [4], sourceFiles: [4] },
  gang: { nodes: [2], sourceFiles: [2] },
  corporation: { nodes: [3], sourceFiles: [3] },
  hacknetServer: { nodes: [9], sourceFiles: [9] },
  sleeves: { nodes: [10], sourceFiles: [10] },
  grafting: { nodes: [10], sourceFiles: [10] }, // grafting API is SF10-gated
  bladeburner: { nodes: [6, 7], sourceFiles: [6, 7] },
  stanek: { nodes: [13], sourceFiles: [13] },
};

// The BitNode option that removes each mechanic for a whole node (BitNodeOptions
// in the game's NetscriptDefinitions).
const DISABLED_BY = {
  gang: "disableGang",
  corporation: "disableCorporation",
  bladeburner: "disableBladeburner",
  hacknetServer: "disableHacknetServer",
};

/**
 * Active level of a Source-File from a resetInfo. ResetInfo.ownedSF is a
 * Map<number,number> in the current API; the Array/object fallbacks keep this
 * robust against older shapes (and against a plain object passed by a test).
 * @param {any} resetInfo @param {number} sourceFile
 * @returns {number}
 */
export function sourceFileLevel(resetInfo, sourceFile) {
  const owned = resetInfo?.ownedSF;
  if (owned instanceof Map) return Number(owned.get(sourceFile) ?? 0);
  if (Array.isArray(owned)) {
    const entry = owned.find(item =>
      Array.isArray(item) ? Number(item[0]) === sourceFile : Number(item?.n) === sourceFile
    );
    return Number(Array.isArray(entry) ? entry[1] : entry?.lvl ?? 0);
  }
  if (owned && typeof owned === "object") return Number(owned[sourceFile] ?? 0);
  return 0;
}

/**
 * True if an API gated behind any of `bitNodes` / `sourceFiles` is usable: we're
 * in one of those BitNodes, or we hold one of those Source-Files.
 * @param {any} resetInfo @param {number[]} bitNodes @param {number[]} [sourceFiles]
 */
export function hasApiAccess(resetInfo, bitNodes, sourceFiles = bitNodes) {
  const current = Number(resetInfo?.currentNode ?? 0);
  if (bitNodes.includes(current)) return true;
  return sourceFiles.some(n => sourceFileLevel(resetInfo, n) > 0);
}

/**
 * Singularity RAM multiplier: 1x INSIDE BN4 whatever the Source-File level, and
 * outside it 16x at SF4.1, 4x at SF4.2, 1x at SF4.3+ (bitburner-src
 * Netscript/RamCostGenerator.ts SF4Cost - the BN4 check comes first). This used
 * to report 16x for a first BN4 run, which made the self-test call a daemon that
 * fits sixteen times too big. Returns Infinity when Singularity is unavailable.
 * Informational - lets the self-test explain why a Singularity-heavy daemon is
 * huge. See [[formulas-api-access]] for the related SF-5 note.
 * @param {any} resetInfo
 */
export function singularityRamMultiplier(resetInfo) {
  if (!hasApiAccess(resetInfo, GATES.singularity.nodes, GATES.singularity.sourceFiles)) {
    return Infinity;
  }
  if (Number(resetInfo?.currentNode ?? 0) === 4) return 1;
  const level = sourceFileLevel(resetInfo, 4);
  if (level >= 3) return 1;
  if (level === 2) return 4;
  return 16;
}

/**
 * The full capability struct for a resetInfo (pure - testable). Booleans for each
 * gated API plus the raw reset and helper accessors.
 * @param {any} resetInfo
 */
export function capabilitiesFromReset(resetInfo) {
  // any: we attach a dynamic boolean per GATES key below, which checkJs won't allow
  // on a narrowly-typed object literal.
  const caps = /** @type {any} */ ({ reset: resetInfo, currentNode: Number(resetInfo?.currentNode ?? 0) });
  // A mechanic switched off by a BitNode option (a challenge run, or the player's
  // own choice on the BitVerse screen) is gone for the whole node, Source-File or not.
  const options = resetInfo?.bitNodeOptions ?? {};
  for (const [name, gate] of Object.entries(GATES)) {
    caps[name] = hasApiAccess(resetInfo, gate.nodes, gate.sourceFiles) && options[DISABLED_BY[name]] !== true;
  }
  caps.challenge = isChallengeRun(resetInfo);
  caps.singularityRamMultiplier = singularityRamMultiplier(resetInfo);
  caps.sourceFileLevel = n => sourceFileLevel(resetInfo, n);
  return caps;
}

// Every Source-File stops at level 3 except SF12, which has no cap.
const UNCAPPED_SOURCE_FILE = 12;
const MAX_SOURCE_FILE_LEVEL = 3;

/**
 * The next step of the campaign plan (CONFIG.campaign.order) once the current
 * BitNode is finished: the first step that will still be unmet AFTER the run now
 * ending has paid out. Pure.
 *
 * A level step [node, level] is unmet while the Source-File is below the level -
 * counting the level this run awards, which is what makes [7, 3] mean "three
 * runs": finishing 7.2 leaves SF7 at 2, still short, so BN7 is re-entered.
 *
 * A challenge step [node, "challenge"] is unmet while the node's challenge
 * achievement is not held - counting the one this run awards if it IS that
 * challenge run. Holding it is something only the save knows (lib/achievements.js
 * publishes it), so when a challenge step is reached and `achievements` is null
 * the answer is `waiting`: finish nothing yet, ask again. A challenge that cannot
 * be marked on entry (no level-3 Source-File to hang the marker on - see
 * CHALLENGE in lib/config.js) is skipped rather than entered as an ordinary run
 * that would never satisfy the step.
 *
 * @param {any} resetInfo - ns.getResetInfo()
 * @param {[number, number | "challenge"][]} order
 * @param {Set<string> | null} [achievements] - achievement IDs held, null when unknown
 * @returns {{ node: number, challenge: boolean, waiting: boolean }} node 0 is
 *   the halt sentinel: every daemon reads it as "finish nothing; the player chooses".
 */
export function campaignStep(resetInfo, order, achievements = null) {
  const current = Number(resetInfo?.currentNode ?? 0);
  const earningChallenge = isChallengeRun(resetInfo);
  for (const [node, target] of order ?? []) {
    if (target === "challenge") {
      const challenge = CHALLENGE[node];
      if (!challenge || (node === current && earningChallenge)) continue;
      if (!achievements) return { node: 0, challenge: false, waiting: true };
      if (achievements.has(challenge.achievement) || !challengeMarker(resetInfo)) continue;
      return { node, challenge: true, waiting: false };
    }
    const owned = sourceFileLevel(resetInfo, node);
    const after = node === current ? owned + 1 : owned;
    // A target past the cap means the cap: no run awards a fourth level.
    const goal = node === UNCAPPED_SOURCE_FILE ? target : Math.min(target, MAX_SOURCE_FILE_LEVEL);
    if (after < goal) return { node, challenge: false, waiting: false };
  }
  return { node: 0, challenge: false, waiting: false };
}

/**
 * The BitNode to enter next, by the plan - campaignStep's node alone, for the
 * callers that only want the number. 0 = halt (plan done, or still waiting to
 * learn which achievements are held).
 * @param {any} resetInfo
 * @param {[number, number | "challenge"][]} order
 * @param {Set<string> | null} [achievements]
 * @returns {number}
 */
export function campaignNext(resetInfo, order, achievements = null) {
  return campaignStep(resetInfo, order, achievements).node;
}

/**
 * The entry marker for a challenge run: a Source-File override that overrides
 * nothing. A file at level 3 (never SF12, which has no cap) set to 3 leaves every
 * multiplier where it was, and is visible in getResetInfo().bitNodeOptions for
 * the whole run. Null when the player holds no such file.
 * @param {any} resetInfo
 * @returns {[number, number] | null}
 */
export function challengeMarker(resetInfo) {
  for (let sourceFile = 1; sourceFile <= 15; sourceFile++) {
    if (sourceFile === UNCAPPED_SOURCE_FILE) continue;
    if (sourceFileLevel(resetInfo, sourceFile) === MAX_SOURCE_FILE_LEVEL) return [sourceFile, MAX_SOURCE_FILE_LEVEL];
  }
  return null;
}

/**
 * The BitNode options to enter `node` with for its challenge run, as plain JSON
 * (script args cannot carry a Map): the options CHALLENGE[node] asks for plus the
 * marker, the overrides as [sourceFile, level] pairs. Null when the node has no
 * challenge or no marker is possible. lib/finish-bn.js turns it back into what
 * destroyW0r1dD43m0n takes.
 * @param {any} resetInfo @param {number} node
 * @returns {{ [option: string]: any, sourceFileOverrides: [number, number][] } | null}
 */
export function challengeEntryOptions(resetInfo, node) {
  const challenge = CHALLENGE[node];
  const marker = challengeMarker(resetInfo);
  if (!challenge || !marker) return null;
  return { ...challenge.options, sourceFileOverrides: [marker] };
}

/**
 * Read ns.getResetInfo() once (1GB) and return the capability struct. This is the
 * only Netscript touch in the module; everything else is pure.
 * @param {NS} ns
 */
export function getCapabilities(ns) {
  return capabilitiesFromReset(ns.getResetInfo());
}

/**
 * The achievement IDs the player holds, from what lib/achievements.js published
 * (globalThis.gordAchievements) - or null when that cannot be trusted: nothing
 * published, the save could not be read, or the reading predates this BitNode
 * (globalThis survives a node change, and the run that just ended is exactly
 * what awarded the achievements the plan is about to ask after). Pure.
 * @param {any} published - globalThis.gordAchievements
 * @param {any} resetInfo - ns.getResetInfo()
 * @returns {Set<string> | null}
 */
export function heldAchievements(published, resetInfo) {
  if (!Array.isArray(published?.ids)) return null;
  if (!(published.updatedAt >= Number(resetInfo?.lastNodeReset ?? 0))) return null;
  return new Set(published.ids);
}
