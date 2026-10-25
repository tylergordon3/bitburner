// lib/sf-bonuses.js
//
// What each Source-File level gives, as readable lines for the HUD's SF tab
// (ui/sf.js). Pure - no ns - so it costs the dashboard nothing and Node tests it.
//
// The numbers are the game's own for v3.0.1 (bitburner-src): the multiplier sums
// from SourceFile/applySourceFile.ts, the unlocks from BitNode/BitNode.tsx
// sfDescription, and where the engine does something the description doesn't
// say (or says differently) the engine wins - Prestige.ts for home RAM, the
// hacknet server and NeuroFlux, RamCostGenerator.ts SF4Cost, StaneksGift.ts,
// Go/effects/effect.ts, DarkNet/effects, Exploits/applyExploits.ts.

export const SF_NAMES = {
  1: "Source Genesis",
  2: "Rise of the Underworld",
  3: "Corporatocracy",
  4: "The Singularity",
  5: "Artificial Intelligence",
  6: "Bladeburners",
  7: "Bladeburners 2079",
  8: "Ghost of Wall Street",
  9: "Hacktocracy",
  10: "Digital Carbon",
  11: "The Big Crash",
  12: "The Recursion",
  13: "They're Lunatics",
  14: "IPvGO Subnet Takeover",
  15: "The Dark Net",
};

// Source-File -1: one per exploit found (Exploits/Exploit.ts lists 11).
export const EXPLOIT_COUNT = 11;

/**
 * The multiplier bonus applySourceFile.ts builds: base% at level 1, then half
 * as much again per level (16 -> 24 -> 28 for SF1). In percent.
 * @param {number} base @param {number} level
 */
export function halvingBonus(base, level) {
  let pct = 0;
  for (let i = 0; i < level; i++) pct += base / Math.pow(2, i);
  return pct;
}

/** "+16%", "+24%", "+0.5%" - at most one decimal, none when whole. */
function pct(n) {
  return `${Number.isInteger(n) ? n : Number(n.toFixed(1))}%`;
}

/** "L1/L2/L3" picker for the effects that are a per-level table. */
function byLevel(level, values) {
  return values[Math.min(level, values.length) - 1];
}

/**
 * The bonuses one Source-File level grants, one readable line each.
 * Unknown numbers (an SF16 one day) get a single placeholder line.
 * @param {number} sf @param {number} level
 * @returns {string[]}
 */
export function sourceFileBonuses(sf, level) {
  if (!(level > 0)) return [];
  const up = base => `+${pct(halvingBonus(base, level))}`;
  switch (sf) {
    case 1: return [
      `${up(16)} to every multiplier (hacking, combat, charisma, exp, rep, crime, work money, hacknet production)`,
      `-${pct(100 - 100 / (1 + halvingBonus(16, level) / 100))} hacknet node costs`,
      "Start each BitNode with 32GB home RAM",
    ];
    case 2: return [
      `${up(24)} crime success, crime money and charisma`,
      "Gangs in other BitNodes (karma -54,000)",
    ];
    case 3: return [
      `${up(8)} charisma and company salary`,
      "Corporations in other BitNodes",
      ...(level >= 3 ? ["Office and Warehouse APIs come free with every new corporation"] : []),
    ];
    case 4: return [
      "Singularity API in other BitNodes",
      `Singularity RAM cost x${byLevel(level, [16, 4, 1])} outside BN4`,
    ];
    case 5: return [
      `${up(8)} hacking level, exp, chance, speed, money and grow`,
      "Intelligence stat (+300 int exp on entering a BitNode)",
      "Formulas.exe on every BitNode start, getBitNodeMultipliers(), BitNode mults on the Stats page",
    ];
    case 6: return [
      `${up(8)} combat stat levels and combat exp`,
      "Bladeburner in other BitNodes",
    ];
    case 7: return [
      `${up(8)} Bladeburner max stamina, stamina gain, analysis and success chance`,
      "Bladeburner in other BitNodes",
      ...(level >= 3 ? ["Blade's Simulacrum on joining the Bladeburners (accept Stanek's Gift first)"] : []),
    ];
    case 8: return [
      `${up(12)} hacking grow`,
      "WSE account and TIX API in every BitNode",
      ...(level >= 2 ? ["Short selling"] : []),
      ...(level >= 3 ? ["Limit and stop orders"] : []),
    ];
    case 9: return [
      `${up(12)} hacknet production, -${pct(halvingBonus(12, level))} hacknet costs`,
      "Hacknet Servers in other BitNodes",
      ...(level >= 2 ? ["Start each BitNode with 128GB home RAM"] : []),
      ...(level >= 3 ? ["A level-100, 10-core, cache-5 Hacknet Server on each BitNode start"] : []),
    ];
    case 10: {
      const sleeves = Math.min(3, level);
      return [
        `${sleeves} sleeve${sleeves === 1 ? "" : "s"} (+1 inside BN10, max 3; The Covenant sells 5 more, in BN10 only)`,
        "Sleeve and Grafting APIs in other BitNodes",
      ];
    }
    case 11: return [
      `${up(32)} company salary and company rep`,
      "Company favor raises salary as well as rep (+1% per favor)",
      `Aug price step x${(1.9 * byLevel(level, [0.96, 0.94, 0.93])).toFixed(3)} per aug bought (from x1.9, -${byLevel(level, [4, 6, 7])}%)`,
    ];
    case 12: return [
      `Start every BitNode with NeuroFlux Governor level ${level}`,
    ];
    case 13: return [
      "Church of the Machine God in other BitNodes",
      `Stanek's Gift +${level} size`,
    ];
    case 14: return [
      "Double the stat bonuses from IPvGO node power",
      `Win-streak favor capped at ${byLevel(level, ["200k", "300k", "400k"])} rep equivalent`,
      ...(level >= 2 ? ["go.cheat API"] : []),
      ...(level >= 3 ? ["+25% go.cheat success"] : []),
    ];
    case 15: return [
      "Start with the TOR router and DarkscapeNavigator.exe; full dark web everywhere",
      ...(level >= 2 ? ["Charisma raises company salary and company rep"] : []),
      ...(level >= 3 ? [
        "Charisma raises faction work rep",
        "+50% exp and money from .cache files",
        "Darknet authentication 20% faster",
      ] : []),
    ];
    default: return ["(no table for this Source-File yet - lib/sf-bonuses.js)"];
  }
}

/**
 * The owned Source-Files from a resetInfo, lowest first. ownedSF holds the
 * ACTIVE levels (a challenge run's overrides already applied), which is what the
 * game is using right now.
 * @param {any} resetInfo
 * @returns {[number, number][]}
 */
export function ownedSourceFiles(resetInfo) {
  const owned = resetInfo?.ownedSF;
  const entries = owned instanceof Map ? [...owned.entries()]
    : owned && typeof owned === "object" ? Object.entries(owned)
    : [];
  return entries
    .map(([sf, level]) => /** @type {[number, number]} */ ([Number(sf), Number(level)]))
    .filter(([sf, level]) => sf > 0 && level > 0)
    .sort((a, b) => a[0] - b[0]);
}

/**
 * Every owned Source-File with its bonuses. `level` is the level OWNED - from
 * `saved` (the save's own list, lib/achievements.js) when given, since in a run
 * entered with an override (every BN12 run: SF12 at 0) the resetInfo only has the
 * active level - and `active` the level in effect this run, which is what the
 * bonus lines describe.
 * @param {any} resetInfo
 * @param {Iterable<[number, number]> | null} [saved] - owned [sf, level] pairs
 * @returns {{ sf: number, level: number, active: number, name: string, lines: string[] }[]}
 */
export function sourceFileBonusList(resetInfo, saved = null) {
  const active = new Map(ownedSourceFiles(resetInfo));
  const owned = new Map(active);
  for (const [sf, level] of saved ?? []) {
    if (Number(sf) > 0 && Number(level) > 0) owned.set(Number(sf), Math.max(Number(level), active.get(Number(sf)) ?? 0));
  }
  return [...owned.entries()].sort((a, b) => a[0] - b[0]).map(([sf, level]) => {
    const now = active.get(sf) ?? 0;
    const lines = now > 0 ? sourceFileBonuses(sf, now) : [];
    if (now !== level) lines.unshift(`Active at level ${now} this run (a BitNode option) - owned level ${level}`);
    return { sf, level, active: now, name: SF_NAMES[sf] ?? `BitNode ${sf}`, lines };
  });
}

/**
 * Source-File -1: each exploit multiplies every multiplier by 1.001 and the
 * hacknet costs by 0.999. In percent.
 * @param {number} exploits
 */
export function exploitBonus(exploits) {
  return (Math.pow(1.001, exploits) - 1) * 100;
}
