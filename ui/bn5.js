// ui/bn5.js
//
// BitNode-5 ("Artificial Intelligence") dashboard extras. Like BN2, BN5's
// defining mechanic is the gang - but here we have to grind crime to -54,000
// karma before we can found one (see bn5/daemon.js), which takes a while. So:
//   - Once a gang exists, reuse BN2's GANG card verbatim (same gordGangState).
//   - Before that, show a GANG BOOTSTRAP card tracking karma toward the -54k
//     gate, fed by globalThis.gordGangBootstrap (published by bn5/daemon.js).

import { extraCards as gangExtraCards } from "./bn2.js";
import { card, stat, label, progressBar, el } from "./dashboard-lib.js";

/**
 * @param {NS} ns
 * @param {typeof import("./dashboard-lib.js").COLORS} C
 * @returns {any[]}
 */
export function extraCards(ns, C) {
  // In a gang (or one is starting up): show BN2's gang card / pending placeholder.
  const gang = gangExtraCards(ns, C);
  if (gang.length) return gang;

  // Pre-gang: show the karma grind toward the -54k founding gate.
  const boot = bootstrapCard(ns, C);
  return boot ? [boot] : [];
}

/** @param {NS} ns */
function bootstrapCard(ns, C) {
  const b = globalThis.gordGangBootstrap;
  if (!b) return null;

  // karma and target are both negative; more-negative karma = closer to the
  // gate, so karma/target rises from 0 toward 1 as we grind.
  const frac = b.target ? Math.min(1, Math.max(0, b.karma / b.target)) : 0;
  const ready = b.karma <= b.target;
  const barColor = ready ? C.green : C.yellow;

  return card(C, "GANG BOOTSTRAP", [
    el("div", { style: { display: "flex", justifyContent: "space-between", marginBottom: "6px" } },
      stat(C, "Karma", `${ns.format.number(b.karma)} / ${ns.format.number(b.target)}`, barColor),
      stat(C, "Criminal faction", b.inCriminalFaction ? "joined" : "pending",
        b.inCriminalFaction ? C.green : C.dim),
    ),
    label(C, ready ? "Karma gate reached - founding gang" : `Grinding crime to found a gang (${Math.round(frac * 100)}%)`),
    progressBar(frac, barColor),
  ]);
}
