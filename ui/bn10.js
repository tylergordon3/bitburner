// ui/bn10.js
//
// BitNode-10 ("Digital Carbon") dashboard extras: the SLEEVE card. Reads
// globalThis.gordSleeveState (published each tick by lib/sleeves.js) and shows
// roster size + next-sleeve cost, a memory-completion bar, and a per-sleeve
// status line (shock -> sync -> crime). Returns [] when there's no sleeve state
// (not BN10, or the manager hasn't started yet) so the SLEEVE tab shows its
// placeholder.

import { card, stat, label, progressBar, statRow, el } from "./dashboard-lib.js";

/**
 * @param {NS} ns
 * @param {typeof import("./dashboard-lib.js").COLORS} C
 * @returns {any[]}
 */
export function extraCards(ns, C) {
  const s = globalThis.gordSleeveState;
  if (!s) return [];

  return [rosterCard(ns, C, s), ...(s.sleeves?.length ? [sleeveListCard(ns, C, s)] : [])];
}

/** @param {NS} ns */
function rosterCard(ns, C, s) {
  // Fraction of sleeves at max memory (the "buy 99 memory for each" goal).
  const memFrac = s.sleeves?.length
    ? s.sleeves.filter(x => x.memory >= s.memoryMax).length / s.sleeves.length
    : 0;

  const costColor = s.maxed ? C.green : C.yellow;
  const costText = s.maxed ? "roster maxed" : `$${ns.format.number(s.nextCost)}`;

  return card(C, "SLEEVES", [
    el("div", { style: { display: "flex", justifyContent: "space-between", marginBottom: "6px" } },
      stat(C, "Owned", String(s.count), C.blue),
      stat(C, "Next sleeve", costText, costColor),
    ),
    label(C, s.memoryDone
      ? "Memory maxed on all sleeves"
      : `Memory maxed: ${Math.round(memFrac * 100)}% of sleeves`),
    progressBar(memFrac, s.memoryDone ? C.green : C.yellow),
    label(C, s.allProductive
      ? "All sleeves synced + earning"
      : "Bringing sleeves up (shock -> sync -> crime)"),
  ]);
}

/** @param {NS} ns */
function sleeveListCard(ns, C, s) {
  const rows = s.sleeves.map(x => {
    const color = x.action.startsWith("Crime") ? C.green
      : x.action === "Synchronizing" ? C.yellow
      : C.dim;
    const detail = `sh ${x.shock.toFixed(0)} / sy ${x.sync.toFixed(0)} / mem ${x.memory}`;
    return statRow(C, `#${x.index}`, x.action, detail, color);
  });
  return card(C, "SLEEVE STATUS", rows);
}
