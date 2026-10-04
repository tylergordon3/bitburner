// ui/go.js
//
// The GO dashboard cards. Reads globalThis.gordGoState (published every turn by
// lib/go.js) and shows the game in hand, this helper's record since it started,
// and - the point of playing at all - the stat bonus each faction's games have
// bought so far. Those bonuses are the game's own numbers (go.analysis.getStats),
// and they reset with an aug install, so the card is also the place to see how
// much of the bonus has been re-earned since the last one.
//
// Returns [] when the helper isn't running (or its state is stale), so the tab
// shows its placeholder.

import { card, stat, label, progressBar, statRow, el, fresh } from "./dashboard-lib.js";
import { CONFIG } from "../lib/config.js";

/**
 * @param {NS} ns
 * @param {typeof import("./dashboard-lib.js").COLORS} C
 * @returns {any[]}
 */
export function extraCards(ns, C) {
  const g = fresh(globalThis.gordGoState, CONFIG.ui.staleMs.helper);
  if (!g) return [];
  const bonuses = playedBonuses(g);
  return [gameCard(ns, C, g), ...(bonuses.length ? [bonusCard(ns, C, bonuses)] : [])];
}

/**
 * The factions that have actually been played, biggest bonus first. getStats
 * lists every opponent the game knows, most of them at zero.
 * @param {{ bonuses?: any[] }} g
 */
export function playedBonuses(g) {
  return (g.bonuses ?? [])
    .filter(b => (b.wins ?? 0) + (b.losses ?? 0) > 0 || (b.percent ?? 0) > 0)
    .sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0));
}

/** @param {NS} ns */
function gameCard(ns, C, g) {
  const games = g.games ?? 0;
  const winFrac = games > 0 ? (g.wins ?? 0) / games : 0;
  const winColor = games === 0 ? C.dim : winFrac >= 0.6 ? C.green : winFrac >= 0.4 ? C.yellow : C.red;
  const failing = String(g.status ?? "").startsWith("error");

  const children = [
    el("div", { style: { display: "flex", justifyContent: "space-between", marginBottom: "6px" } },
      stat(C, "Vs", g.opponent ?? "-", C.blue),
      stat(C, "Board", g.boardSize ? `${g.boardSize}x${g.boardSize}` : "-", C.dim),
      stat(C, "Record", `${g.wins ?? 0}W / ${g.losses ?? 0}L`, winColor),
      stat(C, "Win rate", games > 0 ? `${Math.round(winFrac * 100)}%` : "-", winColor),
    ),
    progressBar(winFrac, winColor),
    el("div", { style: { fontSize: "12px", color: failing ? C.red : C.dim, marginBottom: "3px" } },
      `Move ${g.moves ?? 0}: ${g.status ?? "-"}`),
  ];

  const r = g.lastResult;
  if (r) {
    children.push(statRow(C, r.won ? "+" : "-",
      `${r.won ? "Won" : "Lost"} vs ${r.opponent} ${r.black}-${r.white} in ${r.moves} moves`,
      `${ns.format.time(Date.now() - r.at)} ago`,
      r.won ? C.green : C.red));
  }
  // Both should stay at zero. Refused moves mean lib/go-logic.js disagrees with
  // the game about what is legal; errors mean something else is moving on the board.
  if ((g.rejected ?? 0) > 0 || (g.errors ?? 0) > 0) {
    children.push(label(C, `Refused moves: ${g.rejected ?? 0} | errors: ${g.errors ?? 0}`));
  }
  return card(C, "IPvGO", children);
}

/** @param {NS} ns */
function bonusCard(ns, C, bonuses) {
  const rows = bonuses.map(b => {
    const streak = (b.winStreak ?? 0) > 1 ? `, streak ${b.winStreak}` : "";
    return statRow(C, ">", `${b.opponent} (${b.wins ?? 0}W/${b.losses ?? 0}L${streak})`,
      `+${(b.percent ?? 0).toFixed(2)}% ${b.description ?? ""}`.trim(),
      (b.percent ?? 0) > 0 ? C.green : C.dim);
  });
  rows.push(label(C, "Reset by an aug install - re-earned by the games played since."));
  return card(C, "NODE POWER BONUSES", rows);
}
