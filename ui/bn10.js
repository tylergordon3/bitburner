// ui/bn10.js
//
// The SLEEVE and GRAFTING dashboard cards.
//
// SLEEVE reads globalThis.gordSleeveState (published each tick by lib/sleeves.js,
// which every daemon now runs) and shows the roster, what mode it's in - criming
// toward the gang karma gate, or mirroring the player - and a per-sleeve status
// line. The Covenant's sleeve/memory shop only exists in BitNode 10, so the
// next-sleeve cost and memory rows are shown only when state.shopOpen says so.
//
// GRAFTING reads globalThis.gordGraftState (published by lib/grafting.js) and shows
// the entropy budget, the active graft (aug + progress), and the current
// graft-vs-crime decision; that one really is BN10-shaped, since it depends on a
// long no-reset run.
//
// Returns [] when neither state exists (the managers haven't started yet, or this
// run has no sleeves) so the tab shows its placeholder.

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
  // Augs still on offer across the roster - 0 means every sleeve is fully
  // augmented (or still shedding shock, which is what gates buying them).
  const augText = s.augsAvailable
    ? `${s.augsAvailable} available${s.augsThisTick ? ` (+${s.augsThisTick} this tick)` : ""}`
    : "all bought";
  const augColor = s.augsAvailable ? C.yellow : C.green;

  const header = [
    stat(C, "Owned", String(s.count), C.blue),
    stat(C, "Augs", augText, augColor),
  ];
  // Only BitNode 10's Covenant sells sleeves, so elsewhere a price would just be a
  // number for a purchase that can never happen.
  if (s.shopOpen) {
    header.splice(1, 0, stat(C, "Next sleeve",
      s.maxed ? "roster maxed" : s.shopLive === false ? "shop helper starting" : `$${ns.format.number(s.nextCost)}`,
      s.maxed ? C.green : s.shopLive === false ? C.dim : C.yellow));
  }

  const children = [
    el("div", { style: { display: "flex", justifyContent: "space-between", marginBottom: "6px" } }, ...header),
    modeLine(C, s),
  ];

  if (s.shopOpen) {
    // Progress by LEVELS, not by sleeves-at-100: buying out the shop means 100 memory
    // on every sleeve, and a roster sitting at 60 each would otherwise read as 0%.
    const total = (s.sleeves?.length ?? 0) * (s.memoryMax || 1);
    const memFrac = total > 0 ? Math.max(0, total - (s.memoryRemainingLevels ?? 0)) / total : 0;

    const memNote = s.memoryDone ? "Memory maxed on all sleeves"
      : s.savingForSleeve ? `Memory on hold: ${s.memoryRemainingLevels} levels left, saving for the next sleeve first`
      : `Memory: ${s.memoryRemainingLevels} levels left (~$${ns.format.number(s.memoryRemainingCost)})`;

    children.push(
      label(C, memNote),
      progressBar(memFrac, s.memoryDone ? C.green : s.savingForSleeve ? C.dim : C.yellow),
    );
  }

  if (s.shoppingDone) {
    children.push(label(C, "Shop bought out - nothing left to buy in BN10, safe to finish the node."));
  }

  children.push(label(C, s.allProductive
    ? "All sleeves synced + earning"
    : `Bringing sleeves up (${s.earning ?? 0}/${s.count} earning)`));
  if (s.factionGrind) children.push(label(C, `Weak sleeves on field work for ${s.factionGrind}`));

  return card(C, "SLEEVES", children);
}

/**
 * The one line that says what the roster is FOR right now: grinding karma toward
 * founding a gang (with a bar showing how far along), or shadowing the player.
 */
function modeLine(C, s) {
  if (s.mode === "gang") {
    const frac = s.karmaGate ? Math.min(1, (s.karma ?? 0) / s.karmaGate) : 0;
    return el("div", {},
      label(C, `Gang bootstrap - ${s.modeDetail ?? "criming for karma"}`),
      progressBar(frac, frac >= 1 ? C.green : C.red),
    );
  }
  return label(C, s.modeDetail ?? "Mirroring the player");
}

// Status colour per assignment kind, so the list doesn't have to parse the
// human-readable action string.
const KIND_COLORS = {
  crime: "green",
  faction: "purple",
  company: "purple",
  class: "blue",
  gym: "blue",
  sync: "yellow",
  shock: "red",
};

/** @param {NS} ns */
function sleeveListCard(ns, C, s) {
  const rows = s.sleeves.map(x => {
    const color = C[KIND_COLORS[x.kind]] ?? C.dim;
    const detail = `sh ${x.shock.toFixed(0)} / sy ${x.sync.toFixed(0)}${s.shopOpen ? ` / mem ${x.memory}` : ""}`;
    return statRow(C, `#${x.index}`, x.action, detail, color);
  });
  return card(C, "SLEEVE STATUS", rows);
}
