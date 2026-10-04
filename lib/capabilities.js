// lib/capabilities.js
//
// Centralized, ZERO-RAM detection of which gated APIs are usable this run. Every
// Source-File/BitNode-gated API (Singularity, Gang, Corporation, Sleeves,
// Grafting, Bladeburner, Hacknet-Server, Stanek) is available when you're either
// physically IN its BitNode or hold its Source-File - that's a pure function of
// ns.getResetInfo() (which costs 0GB), so this module replaces the scattered
// try/catch probes (numSleevesSafe, graftingApiAvailable, inGangSafe, ...) with
// one cheap, reusable, testable check.
//
// Structure mirrors the rest of the codebase: the decision logic is a set of PURE
// functions taking a plain resetInfo object (unit-testable under Node with no
// Netscript stub - see tests/capabilities.test.mjs), and getCapabilities(ns) is a
// thin wrapper that reads ns.getResetInfo() once and hands it to them. Idea ported
// from ame824/autoDoIt's core/capabilities.js + lib/logic.js.
//
// RAM: getResetInfo() is 0GB, so importing/using this taxes nobody - safe even in
// the lean early/driver.js closure (like lib/config.js).

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
  for (const [name, gate] of Object.entries(GATES)) {
    caps[name] = hasApiAccess(resetInfo, gate.nodes, gate.sourceFiles);
  }
  caps.singularityRamMultiplier = singularityRamMultiplier(resetInfo);
  caps.sourceFileLevel = n => sourceFileLevel(resetInfo, n);
  return caps;
}

/**
 * Read ns.getResetInfo() once (0GB) and return the capability struct. This is the
 * only Netscript touch in the module; everything else is pure.
 * @param {NS} ns
 */
export function getCapabilities(ns) {
  return capabilitiesFromReset(ns.getResetInfo());
}
