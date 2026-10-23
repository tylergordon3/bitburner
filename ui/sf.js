// ui/sf.js
//
// The SF dashboard cards: every bonus the owned Source-Files give, one card per
// Source-File (number, level, name, then its modifiers and unlocks). The table is
// lib/sf-bonuses.js; the levels come from ns.getResetInfo().ownedSF, which the
// dashboard already pays for, so this tab adds no RAM. SF-1 (the exploits) comes
// from globalThis.gordAchievements, which lib/achievements.js publishes from the
// save - Netscript has no exploit API.
//
// Returns [] with no Source-Files at all, so the tab shows its placeholder.

import { card, label, statRow, el } from "./dashboard-lib.js";
import { sourceFileBonusList, exploitBonus, EXPLOIT_COUNT } from "../lib/sf-bonuses.js";

/**
 * @param {NS} ns
 * @param {typeof import("./dashboard-lib.js").COLORS} C
 * @returns {any[]}
 */
export function extraCards(ns, C) {
  const reset = ns.getResetInfo();
  const list = sourceFileBonusList(reset);
  const exploits = globalThis.gordAchievements?.exploits;
  if (list.length === 0 && !Array.isArray(exploits)) return [];

  const header = [
    statRow(C, ">", "Source-Files owned", `${list.length}, ${list.reduce((sum, s) => sum + s.level, 0)} levels`, C.purple),
  ];
  if (Array.isArray(exploits)) {
    const pct = exploitBonus(exploits.length);
    header.push(statRow(C, ">", `SF-1 exploits: ${exploits.length} of ${EXPLOIT_COUNT}`,
      exploits.length ? `+${pct.toFixed(2)}% every multiplier, -${(100 - Math.pow(0.999, exploits.length) * 100).toFixed(2)}% hacknet costs` : "none yet",
      exploits.length ? C.green : C.dim));
  } else {
    header.push(label(C, "SF-1 exploits: not read yet (lib/achievements.js reads them from the save)."));
  }
  if ((reset.bitNodeOptions?.sourceFileOverrides?.size ?? 0) > 0) {
    header.push(label(C, "This run overrides some Source-File levels - the levels below are the ones in effect."));
  }
  const cards = [card(C, "SOURCE-FILES", header)];

  // The bullet is built from its code point, not typed: the file sync hands the
  // game UTF-8 as Latin-1, so a literal single angle quote showed up as "a-hat
  // + ordinal" garbage. Keep code strings in this file ASCII.
  const bullet = String.fromCharCode(0x203a);
  for (const s of list) {
    cards.push(card(C, `SF${s.sf}.${s.level}  ${s.name}`, s.lines.map(line =>
      el("div", { style: { fontSize: "12px", color: C.blue, marginBottom: "3px" } }, `${bullet} ${line}`))));
  }
  return cards;
}
