// ui/bn10.js
//
// BitNode-10 ("Digital Carbon") dashboard extras: the SLEEVE and GRAFTING cards.
// SLEEVE reads globalThis.gordSleeveState (published each tick by lib/sleeves.js)
// and shows roster size + next-sleeve cost, a memory-completion bar, and a
// per-sleeve status line (shock -> sync -> crime). GRAFTING reads
// globalThis.gordGraftState (published by lib/grafting.js) and shows the entropy
// budget, the active graft (aug + progress), and the current graft-vs-crime
// decision. Returns [] when neither state exists (not BN10, or the managers
// haven't started yet) so the tab shows its placeholder.

import { card, stat, label, progressBar, statRow, el } from "./dashboard-lib.js";

/**
 * @param {NS} ns
 * @param {typeof import("./dashboard-lib.js").COLORS} C
 * @returns {any[]}
 */
export function extraCards(ns, C) {
  const cards = [];

  const s = globalThis.gordSleeveState;
  if (s) cards.push(rosterCard(ns, C, s), ...(s.sleeves?.length ? [sleeveListCard(ns, C, s)] : []));

  const g = globalThis.gordGraftState;
  if (g) cards.push(graftCard(ns, C, g));

  return cards;
}

/** @param {NS} ns */
function graftCard(ns, C, g) {
  const entropyFrac = g.entropyCap ? Math.min(1, g.entropy / g.entropyCap) : 0;
  const entropyColor = g.capped ? C.red : entropyFrac > 0.6 ? C.yellow : C.green;

  const statusText = g.active ? "Grafting" : g.capped ? "Entropy capped" : g.worthwhile ? "Starting" : "Idle";
  const statusColor = g.active ? C.purple : g.capped ? C.red : g.worthwhile ? C.yellow : C.dim;

  const children = [
    el("div", { style: { display: "flex", justifyContent: "space-between", marginBottom: "6px" } },
      stat(C, "Status", statusText, statusColor),
      stat(C, "Entropy", `${g.entropy}/${g.entropyCap}`, entropyColor),
    ),
    progressBar(entropyFrac, entropyColor),
  ];

  if (g.active) {
    const eta = g.etaMs ? ` (~${ns.format.time(g.etaMs)} left)` : "";
    children.push(label(C, `Grafting ${g.aug}${eta}`));
    children.push(progressBar(g.progress ?? 0, C.purple));
  } else if (g.best) {
    children.push(statRow(C, "->", g.best.aug,
      `$${ns.format.number(g.best.price)} / ~${ns.format.time(g.best.timeMs)}`,
      g.worthwhile ? C.yellow : C.dim));
    if (!g.worthwhile) children.push(label(C, g.reason ?? "not worthwhile yet"));
  } else {
    children.push(label(C, g.reason ?? "no graftable augs"));
  }

  return card(C, "GRAFTING", children);
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
      : `Bringing sleeves up (${s.earning ?? 0}/${s.count} earning)`),
    ...(s.factionGrind ? [label(C, `Weak sleeves on field work for ${s.factionGrind}`)] : []),
  ]);
}

/** @param {NS} ns */
function sleeveListCard(ns, C, s) {
  const rows = s.sleeves.map(x => {
    const color = x.action.startsWith("Crime") ? C.green
      : x.action.startsWith("Faction") ? C.purple
      : x.action.startsWith("Gym") ? C.blue
      : x.action === "Synchronizing" ? C.yellow
      : C.dim;
    const detail = `sh ${x.shock.toFixed(0)} / sy ${x.sync.toFixed(0)} / mem ${x.memory}`;
    return statRow(C, `#${x.index}`, x.action, detail, color);
  });
  return card(C, "SLEEVE STATUS", rows);
}
