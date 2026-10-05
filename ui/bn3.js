// ui/bn3.js
//
// BitNode-3 ("Corporatocracy") dashboard extras. The core template
// (ui/dashboard.js) calls extraCards() for the current node and splices the
// result into the layout below the Player/Goal row. BN3's defining mechanic is
// the corporation, so we surface a CORP card fed by globalThis.gordCorpState
// (published by lib/corp-steady.js). Mirrors ui/bn2.js's gang card.

import { card, stat, el } from "./dashboard-lib.js";

/**
 * Cards specific to BN3. Returns an array so the template can spread them in.
 * Empty array = render nothing (e.g. no corp yet).
 * @param {NS} ns
 * @param {typeof import("./dashboard-lib.js").COLORS} C
 * @returns {any[]}
 */
export function extraCards(ns, C) {
  // The HUD's CORP toggle (lib/corp-daemon.js corpAutoEnabled) is off: say so
  // plainly, because every other state this card can show ("manager starting",
  // "corp-steady.js not running") reads as a fault rather than a deliberate choice.
  if (globalThis.gordCorpAuto === false) {
    return [card(C, "CORP", [
      el("div", { style: { color: C.yellow, fontSize: "13px" } },
        "CORP toggle is OFF - no corp scripts are deployed and the running ones were killed."),
      el("div", { style: { color: C.dim, fontSize: "12px", marginTop: "4px" } },
        "The corporation is yours to run by hand. Click CORP: OFF in the header to hand it back."),
    ])];
  }

  const corp = corpCard(ns, C);
  if (corp) return [corp];

  // Corp exists but lib/corp-steady.js hasn't landed on a host yet (see the daemon's
  // ensureCloudManagers): show a placeholder so the card isn't just absent.
  if (globalThis.gordCorpPending) {
    return [card(C, "CORP", [
      el("div", { style: { color: C.yellow, fontSize: "13px" } },
        "Corp manager starting - provisioning cloud-corp / waiting for RAM..."),
    ])];
  }

  return [];
}

/**
 * Rendered only when lib/corp-steady.js is running and publishing gordCorpState;
 * returns null otherwise so nothing shows before the corp exists.
 * @param {NS} ns
 */
function corpCard(ns, C) {
  const s = globalThis.gordCorpState;
  if (!s) return null;

  if (Date.now() - (s.updatedAt ?? 0) > 30_000) {
    return card(C, "CORP", [
      el("div", { style: { color: C.dim, fontSize: "13px" } }, "corp-steady.js not running"),
    ]);
  }

  const profit = s.profit ?? 0;
  const profitColor = profit >= 0 ? C.green : C.red;
  const roundLabel = s.round > 4 ? "public" : `round ${s.round}/4`;

  const divisions = (s.divisions ?? []).map(d => {
    const prod = d.maxProducts ? ` ${d.products}/${d.maxProducts}p` : "";
    return `${d.name}${prod}`;
  }).join("  |  ");

  return card(C, `CORP - ${s.name}`, [
    el("div", { style: { display: "flex", justifyContent: "space-between", marginBottom: "6px" } },
      stat(C, "Funds", `$${ns.format.number(s.funds ?? 0)}`),
      stat(C, "Profit/s", `$${ns.format.number(profit)}`, profitColor),
      stat(C, "Value", `$${ns.format.number(s.valuation ?? 0)}`),
      // The dividend rate; with a tax still on it (tributeModifier > 0) the
      // player gets (their share)^(1 - tax), which the "^" figure spells out.
      stat(C, "Div", s.dividendRate
        ? `${(s.dividendRate * 100).toFixed(0)}%${s.tributeModifier > 0 ? ` ^${(1 - s.tributeModifier).toFixed(2)}` : ""}`
        : "off",
        s.dividendRate ? C.green : C.dim),
    ),
    el("div", { style: { display: "flex", justifyContent: "space-between", marginTop: "4px" } },
      stat(C, "Revenue/s", `$${ns.format.number(s.revenue ?? 0)}`),
      stat(C, "Invest", roundLabel, s.round <= 2 ? C.yellow : C.green),
      stat(C, "Offer", s.offerFunds ? `$${ns.format.number(s.offerFunds)}` : "-",
        s.round <= 2 ? C.yellow : C.dim),
    ),
    el("div", { style: { color: C.dim, fontSize: "11px", marginTop: "6px", wordBreak: "break-word" } },
      divisions || "no divisions yet"
    ),
    growthLine(ns, C, s),
    upkeepLine(ns, C),
  ]);
}

/**
 * One line on the growth loop (CONFIG.corp.growth): whether it is running, the
 * product division's headcount against the 3,000 of "Small town", where Advert
 * stands, what is set aside for the build phases, and what the dividend is
 * doing. Null until the investment rounds are banked - before that the fixed
 * targets rule and there is nothing to say.
 * @param {NS} ns @param {any} s - globalThis.gordCorpState
 */
function growthLine(ns, C, s) {
  if (!s.growing) return null;
  const parts = [];

  // Published by lib/corp-office.js once a rotation.
  const staff = globalThis.gordCorpStaff;
  if (staff && Date.now() - (staff.at ?? 0) < 600_000) {
    parts.push(`${staff.division} staff ${staff.employees}/${staff.seats}` +
      (staff.employees >= 3000 ? " (3,000 reached)" : " (3,000 = Small town)"));
  }
  const product = (s.divisions ?? []).find(d => d.maxProducts);
  if (product) parts.push(product.advertMaxed ? "Advert maxed" : `Advert ${product.adverts}`);
  if (s.envelopes > 0) parts.push(`$${ns.format.number(s.envelopes)} set aside for offices/warehouses`);
  if (s.dividendWhy) parts.push(`dividend: ${s.dividendWhy}`);

  return el("div", { style: { color: C.dim, fontSize: "11px", marginTop: "4px", wordBreak: "break-word" } },
    `Growth: ${parts.join("  |  ") || "on"}`);
}

/**
 * One line on the tea/party loop (lib/corp-upkeep.js) - the piece that must stay
 * alive even when the corp is being managed by hand, so its absence is worth
 * surfacing louder than the rest of the manager's.
 * @param {NS} ns
 */
function upkeepLine(ns, C) {
  const u = globalThis.gordCorpUpkeep;
  const stale = !u || Date.now() - (u.updatedAt ?? 0) > 60_000;
  if (stale) {
    return el("div", { style: { color: C.red, fontSize: "11px", marginTop: "4px" } },
      "[!] tea/party loop not running (corp-upkeep.js) - energy/morale will decay");
  }
  const text = u.allTopped
    ? `Tea/party: all ${u.offices} office(s) at max energy/morale`
    : `Tea/party: ${u.teasThisCycle} tea, ${u.partiesThisCycle} parties ` +
      `($${ns.format.number(u.spendThisCycle)}) across ${u.offices} office(s)`;
  return el("div", { style: { color: u.allTopped ? C.green : C.yellow, fontSize: "11px", marginTop: "4px" } }, text);
}
