// ui/bn6.js
//
// The BLADE dashboard cards (BitNode 6/7 or SF6/7). Reads what the two
// Bladeburner helpers publish - globalThis.gordBladeState (lib/bladeburner.js:
// rank, stamina, the action and why, black ops) and globalThis.gordBladeUpkeep
// (lib/blade-upkeep.js: city, chaos, skill points and levels). Returns [] until
// the action loop has published, so the tab shows its placeholder.

import { card, stat, label, progressBar, el } from "./dashboard-lib.js";

/**
 * @param {NS} ns
 * @param {typeof import("./dashboard-lib.js").COLORS} C
 * @returns {any[]}
 */
export function extraCards(ns, C) {
  const b = globalThis.gordBladeState;
  if (!b) return [];
  if (!b.joined) {
    return [card(C, "BLADEBURNER", [label(C, "Not in the division yet - training every combat stat to 100 to join.")])];
  }
  const u = globalThis.gordBladeUpkeep;
  return [bladeCard(ns, C, b, u), actionsCard(ns, C, b), ...(u?.joined ? [skillsCard(ns, C, u)] : [])];
}

/** @param {NS} ns */
function bladeCard(ns, C, b, u) {
  const stamFrac = b.maxStamina > 0 ? b.stamina / b.maxStamina : 0;
  const stamColor = b.resting ? C.yellow : stamFrac < 0.6 ? C.yellow : C.green;
  const stale = Date.now() - (b.updatedAt ?? 0) > 30_000;

  const slot = stale ? "Action loop stale - is lib/bladeburner.js running?"
    : b.controlStale ? "Daemon not publishing - running on our own"
    : !b.allowed ? "Slot lent to the daemon (faction work while resting)"
    : b.acting ? `${b.action?.name ?? "idle"} - ${b.want?.reason ?? ""}`
    : "Waiting to start";

  const children = [
    el("div", { style: { display: "flex", justifyContent: "space-between", marginBottom: "6px" } },
      stat(C, "Rank", ns.format.number(b.rank ?? 0), C.green),
      stat(C, "Stamina", `${Math.round(stamFrac * 100)}%${b.resting ? " (resting)" : ""}`, stamColor),
      stat(C, "City", u?.city ?? "?", C.blue),
      stat(C, "Chaos", u?.chaos != null ? u.chaos.toFixed(1) : "?", (u?.chaos ?? 0) > 50 ? C.red : C.dim),
    ),
    progressBar(stamFrac, stamColor),
    label(C, slot),
  ];

  const ops = b.blackOps ?? { done: 0, total: 0 };
  if (b.nextBlackOp) {
    const n = b.nextBlackOp;
    const frac = n.rank > 0 ? Math.min(1, (b.rank ?? 0) / n.rank) : 0;
    children.push(label(C, `Black ops ${ops.done}/${ops.total} - next ${n.name} at rank ${ns.format.number(n.rank)}`));
    children.push(progressBar(frac, b.finalHeld ? C.yellow : C.purple));
    children.push(label(C, b.blackOpReason ?? ""));
  } else if (b.allBlackOpsDone) {
    children.push(label(C, `All ${ops.total} black ops complete - the BitNode can be finished.`));
  }

  if ((b.bonusMs ?? 0) > 1_000) children.push(label(C, `Bonus time: ${ns.format.time(b.bonusMs)}`));
  return card(C, "BLADEBURNER", children);
}

/** @param {NS} ns */
function actionsCard(ns, C, b) {
  const rows = (b.candidates ?? []).map(c => {
    const on = b.action?.name === c.name;
    const pct = Math.round((c.chance ?? 0) * 100);
    const color = on ? C.green : pct >= 80 ? C.dim : C.red;
    return el("div", { style: { fontSize: "12px", color, marginBottom: "2px" } },
      `${on ? "> " : "  "}${c.name} L${c.level}: ${pct}%, ${ns.format.number(c.rankPerMin)} rank/min, ${Math.floor(c.count)} left`);
  });
  return card(C, "CONTRACTS + OPERATIONS", rows.length ? rows : [label(C, "No candidates yet.")]);
}

/** @param {NS} ns */
function skillsCard(ns, C, u) {
  const levels = Object.entries(u.levels ?? {})
    .filter(([, lvl]) => lvl > 0)
    .map(([name, lvl]) => `${name} ${lvl}`)
    .join(" | ");
  return card(C, "SKILLS", [
    label(C, `Skill points: ${ns.format.number(u.skillPoints ?? 0)} | Team: ${u.teamSize ?? 0}` +
      `${u.factionJoined ? "" : " | Bladeburners faction: not joined yet (rank 25)"}`),
    label(C, levels || "No skills bought yet."),
  ]);
}
