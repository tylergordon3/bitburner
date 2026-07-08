// ui/bn2.js
//
// BitNode-2 ("Rise of the Underworld") dashboard extras. The core template
// (ui/dashboard.js) calls extraCards() for the current node and splices the
// result into the layout below the Player/Goal row. BN2's defining mechanic is
// the gang, so we surface a GANG card here fed by globalThis.gordGangState
// (published by lib/gang.js).

import { card, stat, label, progressBar, el } from "./dashboard-lib.js";

/**
 * Cards specific to BN2. Returns an array so the template can spread them into
 * the layout. Empty array = render nothing (e.g. no gang yet), matching the old
 * behaviour where the gang card only appeared once lib/gang.js was publishing.
 * @param {NS} ns
 * @param {typeof import("./dashboard-lib.js").COLORS} C
 * @returns {any[]}
 */
export function extraCards(ns, C) {
  const gang = gangCard(ns, C);
  if (gang) return [gang];

  // In a gang but lib/gang.js hasn't landed on a host yet (see the daemon's
  // ensureGangManagerRunning): show a placeholder so the card isn't just absent.
  if (globalThis.gordGangPending) {
    return [card(C, "GANG", [
      el("div", { style: { color: C.yellow, fontSize: "13px" } },
        "Gang manager starting - waiting for RAM to free up..."),
    ])];
  }

  return [];
}

/**
 * Rendered only when lib/gang.js is running and publishing gordGangState;
 * returns null otherwise so nothing shows before the gang exists.
 * @param {NS} ns
 */
function gangCard(ns, C) {
  const g = globalThis.gordGangState;
  if (!g) return null;

  if (Date.now() - (g.updatedAt ?? 0) > 30_000) {
    return card(C, "GANG", [
      el("div", { style: { color: C.dim, fontSize: "13px" } }, "gang.js not running"),
    ]);
  }

  const penaltyColor = g.wantedPenalty >= 0.99 ? C.green
                     : g.wantedPenalty >= 0.95 ? C.yellow
                     : C.red;
  const clashColor   = (g.minClash ?? 0) >= 0.6 ? C.green
                     : (g.minClash ?? 0) >= 0.5 ? C.yellow
                     : C.dim;

  const tasks = Object.entries(g.taskCounts ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([task, n]) => `${task} x${n}`)
    .join("  |  ");

  return card(C, `GANG - ${g.faction}`, [
    el("div", { style: { display: "flex", justifyContent: "space-between", marginBottom: "6px" } },
      stat(C, "Members", `${g.members}/${g.maxMembers}`),
      stat(C, "Respect", ns.format.number(g.respect)),
      stat(C, "$/s", ns.format.number(g.moneyRate), C.green),
      stat(C, "Wanted", `${((1 - g.wantedPenalty) * 100).toFixed(1)}% pen`, penaltyColor),
    ),
    label(C, `Territory ${(g.territory * 100).toFixed(1)}%`),
    progressBar(g.territory, C.red),
    el("div", { style: { display: "flex", justifyContent: "space-between", marginTop: "4px" } },
      stat(C, "Power", ns.format.number(g.power)),
      stat(C, "Clash", `${Math.round((g.minClash ?? 0) * 100)}%`, clashColor),
      stat(C, "Warfare", g.warfare ? "ENGAGED" : "off", g.warfare ? C.red : C.dim),
    ),
    el("div", { style: { color: C.dim, fontSize: "11px", marginTop: "6px", wordBreak: "break-word" } },
      tasks || "-"
    ),
  ]);
}
