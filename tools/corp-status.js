// tools/corp-status.js
//
// One-shot corporation diagnostic: what the corp actually owns, what it can
// afford, and - if it's doing nothing - which purchase it's blocked on.
//
// Written after the BN10 corp bricked itself: the buildout bought every unlock
// before founding a division, and since corp funds can never be topped up from
// personal money, a corp that spends its founding stake without founding a
// division is stuck at $0 revenue permanently. This prints enough to tell that
// state apart from "just slow" at a glance.
//
// Run it off-home (it carries the corporation API, so it's fat):
//   run tools/corp-status.js
//
// Read-only: it buys nothing and changes nothing.

import { CONFIG } from "../lib/config.js";

const CO = CONFIG.corp;

/** @param {NS} ns */
export async function main(ns) {
  const c = ns.corporation;
  const $ = n => `$${ns.format.number(n)}`;

  if (!c.hasCorporation()) {
    ns.tprint("No corporation. Self-funding needs " +
      `${$(CO.selfFundCost * CO.selfFundBuffer)} of personal money (${$(CO.selfFundCost)} cost x ${CO.selfFundBuffer} buffer).`);
    return;
  }

  const corp = c.getCorporation();
  const round = safe(() => c.getInvestmentOffer().round) ?? 99;
  const offer = safe(() => c.getInvestmentOffer().funds) ?? 0;

  ns.tprint("=".repeat(66));
  ns.tprint(`${corp.name} | ${corp.public ? "public" : "private"} | investment round ${round}`);
  ns.tprint(`funds ${$(corp.funds)} | revenue ${$(corp.revenue ?? 0)}/s | expenses ${$(corp.expenses ?? 0)}/s ` +
    `| profit ${$((corp.revenue ?? 0) - (corp.expenses ?? 0))}/s`);
  ns.tprint(`valuation ${$(corp.valuation ?? 0)} | standing offer ${$(offer)}`);

  // ── Unlocks ────────────────────────────────────────────────────────────────
  ns.tprint("-".repeat(66));
  const groups = [
    ["API (buildout can't run without these)", CO.apiUnlocks],
    ["optional", CO.optionalUnlocks],
    ["dividend tax", CO.taxUnlocks],
  ];
  for (const [label, names] of groups) {
    for (const name of /** @type {any[]} */ (names)) {
      const owned = safe(() => c.hasUnlock(name)) ?? false;
      const cost = safe(() => c.getUnlockCost(name)) ?? NaN;
      ns.tprint(`  [${owned ? "x" : " "}] ${name.padEnd(24)} ${owned ? "owned" : $(cost)}   (${label})`);
    }
  }

  // ── Divisions ──────────────────────────────────────────────────────────────
  ns.tprint("-".repeat(66));
  if (!corp.divisions.length) {
    ns.tprint("  NO DIVISIONS - the corp cannot earn anything in this state.");
  }
  for (const name of corp.divisions) {
    const d = safe(() => c.getDivision(name));
    if (!d) continue;
    ns.tprint(`  ${name} [${d.industry}] cities ${d.cities.length}/${CO.cities.length} ` +
      `| advert ${d.numAdVerts ?? 0} | research ${ns.format.number(d.researchPoints ?? 0)} ` +
      `| profit ${$((d.lastCycleRevenue ?? 0) - (d.lastCycleExpenses ?? 0))}/s`);
    for (const city of d.cities) {
      const wh = safe(() => c.getWarehouse(name, /** @type {any} */ (city)));
      const off = safe(() => c.getOffice(name, /** @type {any} */ (city)));
      const whStr = wh ? `wh lvl ${wh.level} (${ns.format.number(wh.sizeUsed)}/${ns.format.number(wh.size)})` : "NO WAREHOUSE";
      const offStr = off ? `office ${off.numEmployees}/${off.size}` : "office n/a";
      ns.tprint(`     ${String(city).padEnd(11)} ${whStr.padEnd(34)} ${offStr}`);
    }
  }

  // ── What we're blocked on ──────────────────────────────────────────────────
  ns.tprint("-".repeat(66));
  // Matched by industry, not by CO.agriDivision.name - same rule the buildout
  // uses, so a hand-made division under another name counts.
  const agri = corp.divisions.find(n => safe(() => c.getDivision(n).industry) === CO.agriDivision.industry);
  if (!agri) {
    const cost = safe(() => c.getIndustryData(/** @type {any} */ (CO.agriDivision.industry)).startingCost) ?? NaN;
    const missingApis = /** @type {any[]} */ (CO.apiUnlocks)
      .filter(u => !safe(() => c.hasUnlock(u)))
      .map(u => ({ u, cost: safe(() => c.getUnlockCost(u)) ?? NaN }));
    const apiTotal = missingApis.reduce((s, m) => s + m.cost, 0);
    ns.tprint(`BLOCKED: no ${CO.agriDivision.industry} division. Needs ${$(cost)}; corp holds ${$(corp.funds)}.`);
    if (missingApis.length) {
      ns.tprint(`         plus ${$(apiTotal)} of unbought API unlocks (${missingApis.map(m => m.u).join(", ")}).`);
    }
    ns.tprint(`         Total to a working corp: ${$(cost + apiTotal)}.`);
    if (corp.funds < cost) {
      ns.tprint("         Corp funds can NEVER be topped up from personal money, and with no");
      ns.tprint("         division there is no revenue - so this corp cannot recover on its own.");
    }
  } else {
    const missingApis = /** @type {any[]} */ (CO.apiUnlocks).filter(u => !safe(() => c.hasUnlock(u)));
    if (missingApis.length) {
      const owed = missingApis.reduce((s, u) => s + (safe(() => c.getUnlockCost(u)) ?? NaN), 0);
      ns.tprint(`SAVING: ${agri} exists, but ${missingApis.join(" + ")} (${$(owed)}) is unbought, so the`);
      ns.tprint(`        buildout can't staff or expand it. Corp holds ${$(corp.funds)}. Until then the`);
      ns.tprint("        script only buys input materials and sells output - everything else waits.");
    }
    ns.tprint(`capacity built: ${globalThis.gordCorpExpandDone ? "yes" : "no"} ` +
      `| offices built: ${globalThis.gordCorpOfficeDone ? "yes" : "no"} ` +
      `| round published: ${globalThis.gordCorpRound ?? "(corp-invest not run yet)"}`);
  }
  ns.tprint("=".repeat(66));
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
