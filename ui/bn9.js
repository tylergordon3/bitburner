// ui/bn9.js
//
// The HACKNET dashboard card (BitNode 9 / SF9). Reads globalThis.gordHacknetState,
// published every tick by lib/hacknet.js: the fleet, the hash cache and its
// production, what the hashes are being turned into (sold, saved toward an
// investment, blocked on cache), the study/gym multiplier levels, and the
// botnet target the boosts are going to. Returns [] when the manager hasn't
// published yet, so the tab shows its placeholder.

import { card, stat, label, progressBar, el } from "./dashboard-lib.js";

/**
 * @param {NS} ns
 * @param {typeof import("./dashboard-lib.js").COLORS} C
 * @returns {any[]}
 */
export function extraCards(ns, C) {
  const h = globalThis.gordHacknetState;
  if (!h) return [];
  return [hacknetCard(ns, C, h), ...(h.fleet?.length ? [fleetCard(ns, C, h)] : [])];
}

/** @param {NS} ns */
function hacknetCard(ns, C, h) {
  const fill = h.capacity > 0 ? Math.min(1, h.hashes / h.capacity) : 0;
  const fillColor = fill > 0.9 ? C.red : fill > 0.6 ? C.yellow : C.green;
  const stale = Date.now() - (h.updatedAt ?? 0) > 60_000;

  const hashUse = h.dumping ? "Selling everything (install pending)"
    : h.cashPriority ? "Cash priority: selling every hash"
    : h.saving ? `Saving hashes for ${h.saving}`
    : h.blocked ? `${h.blocked} needs more cache - buying cache`
    : `Sold ${h.sold ?? 0} last tick`;

  const children = [
    el("div", { style: { display: "flex", justifyContent: "space-between", marginBottom: "6px" } },
      stat(C, "Fleet", `${h.servers}/${h.maxServers}`, h.servers >= h.maxServers ? C.green : C.blue),
      stat(C, "Hashes", `${ns.format.number(h.hashes)} / ${ns.format.number(h.capacity)}`, fillColor),
      stat(C, "Rate", `${h.ratePerSec.toFixed(3)}/s`, C.green),
      stat(C, "As cash", `$${ns.format.number(h.incomePerSec)}/s`, C.yellow),
    ),
    progressBar(fill, fillColor),
    label(C, stale ? "Manager stale - is lib/hacknet.js running?" : hashUse),
  ];

  const L = h.levels ?? {};
  children.push(label(C,
    `Study +${(L.study ?? 0) * 20}% | Gym +${(L.gym ?? 0) * 20}% | ` +
    `Contracts ${L.contracts ?? 0} | Boosts: -sec ${L.minSec ?? 0}, +money ${L.maxMoney ?? 0}`));

  if (h.boost?.target) {
    children.push(label(C,
      `Boosting ${h.boost.target}: min sec ${h.boost.minSecurity.toFixed(2)}, ` +
      `max money $${ns.format.number(h.boost.maxMoney)}`));
  }

  const budgetNote = h.spent > 0
    ? `Spent $${ns.format.number(h.spent)} of $${ns.format.number(h.budget)} this tick`
    : `Budget $${ns.format.number(h.budget)}${h.stopReason ? ` - ${h.stopReason}` : ""}`;
  children.push(label(C, `${budgetNote} | payback cap ${ns.format.time(h.paybackCapMs)}${h.formulas ? "" : " | no Formulas.exe"}`));

  return card(C, "HACKNET", children);
}

/** @param {NS} ns */
function fleetCard(ns, C, h) {
  const rows = h.fleet.map(s => {
    const used = s.ramUsed > 0 ? ` (${ns.format.ram(s.ramUsed)} used)` : "";
    return label(C, `${s.name}: L${s.level} ${ns.format.ram(s.ram)}${used} ${s.cores}c cache ${s.cache}`);
  });
  return card(C, "HACKNET FLEET", rows);
}
