// ui/bn3.js
//
// BitNode-3 ("Corporatocracy") dashboard extras. The core template
// (ui/dashboard.js) calls extraCards() for the current node and splices the
// result into the layout below the Player/Goal row. BN3's defining mechanic is
// the corporation, so we surface a CORP card fed by globalThis.gordCorpState
// (published by lib/corp.js). Mirrors ui/bn2.js's gang card.

import { card, stat, label, progressBar, el } from "./dashboard-lib.js";

/**
 * Cards specific to BN3. Returns an array so the template can spread them in.
 * Empty array = render nothing (e.g. no corp yet).
 * @param {NS} ns
 * @param {typeof import("./dashboard-lib.js").COLORS} C
 * @returns {any[]}
 */
export function extraCards(ns, C) {
  const corp = corpCard(ns, C);
  if (corp) return [corp];

  // Corp exists but lib/corp.js hasn't landed on a host yet (see the daemon's
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
 * Rendered only when lib/corp.js is running and publishing gordCorpState;
 * returns null otherwise so nothing shows before the corp exists.
 * @param {NS} ns
 */
function corpCard(ns, C) {
  const s = globalThis.gordCorpState;
  if (!s) return null;

  if (Date.now() - (s.updatedAt ?? 0) > 30_000) {
    return card(C, "CORP", [
      el("div", { style: { color: C.dim, fontSize: "13px" } }, "corp.js not running"),
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
      stat(C, "Div", s.dividendRate ? `${(s.dividendRate * 100).toFixed(0)}%` : "off",
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
  ]);
}
