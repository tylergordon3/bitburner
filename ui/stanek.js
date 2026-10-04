// ui/stanek.js
//
// The STANEK dashboard cards. Reads globalThis.gordStanekState - published every
// tick by lib/stanek.js, and once by early/stanek-boot.js before the manager is
// up - and shows the three things worth watching: whether the gift was taken
// (the daemons hold their first augmentation and the Bladeburner join for that
// answer), what is on the grid and how far each fragment has been charged, and
// the RAM the charge workers hold instead of the batcher.
//
// A fragment's bonus is ln() of its biggest single charge times the 0.07th
// power of how many it has had, so the fragment rows show both numbers: a small
// "biggest" means the large worker has not reached that fragment yet, and that
// is worth far more than any amount of extra charging.
//
// Returns [] when neither script has published recently, so the tab shows its
// placeholder.

import { card, stat, label, statRow, el, fresh } from "./dashboard-lib.js";
import { CONFIG } from "../lib/config.js";

// Two letters per fragment type for the grid (CotMG/FragmentType.ts numbers).
const SHORT = {
  3: "Sp", 4: "H$", 5: "Gr", 6: "Hk", 7: "St", 8: "De", 9: "Dx", 10: "Ag",
  11: "Ch", 12: "Hn", 13: "Hc", 14: "Rp", 15: "Wk", 16: "Cr", 17: "BB", 18: "+",
};
// "-x% cheaper hacknet costs": the one fragment whose multiplier is a divisor.
const HACKNET_COST = 13;

/**
 * @param {NS} ns
 * @param {typeof import("./dashboard-lib.js").COLORS} C
 * @returns {any[]}
 */
export function extraCards(ns, C) {
  const g = fresh(globalThis.gordStanekState, CONFIG.ui.staleMs.helper);
  if (!g) return [];
  const charged = chargedFragments(g);
  return [giftCard(ns, C, g), ...(charged.length ? [fragmentCard(ns, C, charged)] : [])];
}

/**
 * The stat fragments on the gift, strongest bonus first (boosters carry no
 * bonus of their own and are left out).
 * @param {{ fragments?: any[] }} g
 */
export function chargedFragments(g) {
  return (g.fragments ?? [])
    .filter(f => !f.booster)
    .sort((a, b) => (b.effect ?? 1) - (a.effect ?? 1) || (b.weight ?? 0) - (a.weight ?? 0));
}

/**
 * A fragment's multiplier as the game words it: "+25.0%", or for the hacknet
 * cost fragment the reduction it buys ("-20.0%" at 1.25).
 * @param {{ type?: number, effect?: number }} f
 */
export function bonusText(f) {
  const effect = f.effect ?? 1;
  if (f.type === HACKNET_COST) return `-${((1 - 1 / effect) * 100).toFixed(1)}%`;
  return `+${((effect - 1) * 100).toFixed(1)}%`;
}

/** @param {NS} ns */
function giftCard(ns, C, g) {
  const failing = String(g.status ?? "").startsWith("error") || g.gate === "refused";
  const gateColor = g.gate === "accepted" ? C.green : g.gate === "refused" ? C.red : C.yellow;
  const ram = g.ram ?? {};

  const children = [
    el("div", { style: { display: "flex", justifyContent: "space-between", marginBottom: "6px" } },
      stat(C, "Gift", g.gate ?? "-", gateColor),
      stat(C, "Grid", g.width ? `${g.width}x${g.height}` : "-", C.dim),
      stat(C, "Placed", g.placed != null ? `${g.stats ?? 0} + ${g.boosters ?? 0} boosters` : "-", C.blue),
      stat(C, "Profile", g.profile ?? "-", C.dim),
    ),
    el("div", { style: { fontSize: "12px", color: failing ? C.red : C.dim, marginBottom: "3px" } },
      String(g.status ?? "-")),
  ];

  if (g.width && (g.fragments ?? []).length) children.push(gridView(C, g));

  if (g.layout?.pending) {
    children.push(label(C, "A different layout is planned - it waits for the next install (re-placing a fragment resets its charge)."));
  }
  if ((g.layout?.failed ?? 0) > 0) {
    children.push(label(C, `The game refused ${g.layout.failed} planned placement(s).`));
  }

  if (ram.threads != null) {
    // (`slice`, not `share`: the RAM analyser bills that identifier as ns.share.)
    const slice = `${Math.round((ram.fraction ?? 0) * 100)}%${ram.fresh ? " (fresh gift)" : ""}`;
    children.push(statRow(C, ">", `Charge RAM - ${ram.processes ?? 0} worker(s), target ${slice} of the botnet`,
      `${ns.format.ram(ram.inUse ?? 0)} / ${ns.format.ram(ram.budget ?? 0)}`,
      (ram.threads ?? 0) > 0 ? C.green : C.yellow));
    for (const h of (ram.hosts ?? []).slice(0, 4)) {
      const filling = h.threads < h.want;
      children.push(statRow(C, " ", h.host,
        `${ns.format.number(h.threads)}${filling ? ` of ${ns.format.number(h.want)}` : ""} threads` +
          (h.processes > 1 ? ` in ${h.processes}` : ""),
        filling ? C.yellow : C.dim));
    }
    if ((ram.hosts ?? []).length > 4) children.push(label(C, `... and ${ram.hosts.length - 4} more host(s)`));
  }
  if ((g.errors ?? 0) > 0) children.push(label(C, `Errors: ${g.errors} - last: ${g.lastError ?? ""}`));
  return card(C, "STANEK'S GIFT", children);
}

/** The grid itself: one small box per cell, lettered by what occupies it. */
function gridView(C, g) {
  const owner = new Map();
  for (const f of g.fragments ?? []) {
    for (const [x, y] of f.cells ?? []) owner.set(`${x},${y}`, f);
  }
  const boxes = [];
  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      const f = owner.get(`${x},${y}`);
      const color = !f ? C.border : f.booster ? C.purple : (f.highestCharge ?? 0) > 0 ? C.green : C.yellow;
      boxes.push(el("div", {
        key: `${x},${y}`,
        style: {
          width: "22px", height: "18px", lineHeight: "18px", textAlign: "center",
          fontSize: "11px", borderRadius: "2px",
          border: `1px solid ${color}`, color: f ? color : C.dim,
        },
      }, f ? (SHORT[f.type] ?? "?") : ""));
    }
  }
  return el("div", {
    style: {
      display: "grid", gridTemplateColumns: `repeat(${g.width}, 22px)`, gap: "2px",
      margin: "4px 0 6px",
    },
  }, ...boxes);
}

/** @param {NS} ns */
function fragmentCard(ns, C, fragments) {
  const rows = fragments.map(f => {
    const boosted = (f.boosters ?? 0) > 0 ? ` x${f.boosters} booster${f.boosters > 1 ? "s" : ""}` : "";
    const charge = (f.highestCharge ?? 0) > 0
      ? `biggest ${ns.format.number(f.highestCharge)} x ${ns.format.number(f.numCharge ?? 0)}`
      : "uncharged";
    return statRow(C, SHORT[f.type] ?? "?", `${f.label ?? `Fragment ${f.id}`}${boosted} - ${charge}`,
      bonusText(f), (f.highestCharge ?? 0) > 0 ? C.green : C.dim);
  });
  rows.push(label(C, "Charges reset with an aug install; the layout stays."));
  return card(C, "FRAGMENTS", rows);
}
