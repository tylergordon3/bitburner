// ui/dashboard.js
//
// GORDNET HUD - one tabbed tail window that combines everything into a single UI:
//   STATS   - cross-BitNode progression (Source-Files, Intelligence, all-time
//             earnings, augs, karma/kills) PLUS the live operational cards
//             (player, goal, infra, network, aug/faction pipeline, stocks).
//   JOURNAL - the plain-text "what am I doing and why" narrative (ui/journal.js).
//   GANG    - the gang / karma-bootstrap card (ui/bn5.js -> ui/bn2.js).
//   CORP    - the corporation card (ui/bn3.js).
//   SLEEVE  - the BN10 duplicate-sleeve roster/status card (ui/bn10.js).
//
// The script loop paints the HUD (clearLog + printRaw). A tab click only flips a
// module variable (activeTab) - it must NOT call any ns function, because calling
// ns from a DOM event handler stops the script. (React hooks in a printRaw'd
// component are also unsupported here, so a self-managing component isn't an
// option - the loop drives rendering.) To keep the JOURNAL tab's scroll from
// resetting, the loop repaints only on a tab switch or every uiRefreshMs. This
// one tail replaces the old separate dashboard + journal windows.

import { CONFIG, forNode } from "../lib/config.js";
import { COLORS, el, card, label, progressBar, stat, statRow, formatDuration } from "./dashboard-lib.js";
// Gang + corp panels reuse the existing per-node card modules. bn5's extraCards
// already composes the running-gang card (via bn2.js) with the BN5 karma
// bootstrap card and returns [] elsewhere, so it doubles as a universal gang
// panel; bn3's returns the corp card (or a pending/empty placeholder).
import { extraCards as gangExtraCards } from "./bn5.js";
import { extraCards as corpExtraCards } from "./bn3.js";
import { extraCards as sleeveExtraCards } from "./bn10.js";
import { updateJournal, journalPanel } from "./journal.js";

// Everything below comes from CONFIG.ui / CONFIG.factions - see lib/config.js.
const UI = CONFIG.ui;
const HUD = UI.hud;
const FACTION_REQUIREMENTS = CONFIG.factions.requirements;

const FINAL_HOST = CONFIG.backdoor.finalHost;

// DOM id on the HUD root element, used to measure content height for dynamic
// tail sizing (see fitTail).
const DASH_ID = UI.rootId;

// Combat stats and their gate thresholds, derived from every combat-gated
// faction requirement (Slum Snakes, Tetrads, Speakers for the Dead, etc.) so
// the player card can show how close we are to full gang/combat eligibility.
const COMBAT_STAT_DEFS = UI.combatStats;

// Servers that need backdoors for faction access / BN progression
const BACKDOOR_CHECKLIST = UI.backdoorChecklist;

// Factions worth joining for aug access - shown as joined / pending
const FACTION_CHECKLIST = UI.factionChecklist;

// The HUD tabs.
const TABS = [
  { id: "stats",   label: "STATS" },
  { id: "journal", label: "JOURNAL" },
  { id: "gang",    label: "GANG" },
  { id: "corp",    label: "CORP" },
  { id: "sleeve",  label: "SLEEVE" },
];

// Module UI state. The HUD paints via the script loop (clearLog + printRaw); a
// tab click ONLY sets activeTab here - a pure JS assignment, no ns call - and the
// loop repaints with the new tab on its next pass. Two hard-won constraints drove
// this design:
//   1. Calling ANY ns function from a DOM event handler (onClick) stops the
//      script, so the handler must not touch ns - it just flips activeTab.
//   2. React hooks (useState/useEffect) in a printRaw'd component are NOT
//      supported in this environment (they throw on mount), so we can't make the
//      component self-managing; the loop drives rendering instead.
let activeTab = "stats";
let statsData = null;
// Repaint only when the tab changed or the refresh interval elapsed, so the
// JOURNAL tab isn't torn down (losing scroll) on every poll.
let lastRenderedTab = null;
let lastRenderAt = 0;
let renderAgain = false;   // one extra paint after a tab switch, for fitTail sizing
let lastStatsAt = 0;

// ── Trend state ─────────────────────────────────────────────────────────────
let lastHackLevel = 0;
let lastHackTime  = Date.now();
let hackLevelsPerHour = 0;

let lastFactionRep  = 0;
let lastFactionTime = Date.now();
let factionRepPerHour = 0;

let lastMoney     = 0;
let lastMoneyTime = Date.now();
let moneyPerHour  = 0;

let lastRamTotal = 0;
let lastRamTime  = Date.now();
let ramPerHour   = 0;

// ── Entry point ──────────────────────────────────────────────────────────────
/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.ui.openTail();
  ns.ui.setTailTitle("GORDNET");
  ns.ui.moveTail(UI.tail.x, UI.tail.y);

  while (true) {
    // Journal buffer is cheap (reads globalThis) - refresh every poll.
    try { updateJournal(ns); } catch (e) { ns.print("journal error: " + String(e)); }

    const now = Date.now();

    // Heavier stats data only while the STATS tab is showing, on a slow cadence.
    if (activeTab === "stats" && (statsData === null || now - lastStatsAt >= HUD.statsRefreshMs)) {
      try { statsData = gatherStats(ns); lastStatsAt = now; } catch (e) { ns.print("stats error: " + String(e)); }
    }

    // Repaint on a tab switch (snappy) or when the refresh interval elapses.
    const tabChanged = activeTab !== lastRenderedTab;
    if (tabChanged || renderAgain || now - lastRenderAt >= HUD.uiRefreshMs) {
      renderHud(ns);
      lastRenderAt = now;
      lastRenderedTab = activeTab;
      // A tab switch changes the panel height; paint once more next poll so
      // fitTail (which measures the prior frame) sizes to the new content.
      renderAgain = tabChanged;
    }

    await ns.sleep(HUD.tickMs);
  }
}

// ── Render ────────────────────────────────────────────────────────────────────

/** @param {NS} ns */
function renderHud(ns) {
  // Measure the previous (committed) frame before redrawing - see fitTail.
  fitTail(ns);
  ns.clearLog();
  try {
    const C = COLORS;
    ns.printRaw(
      el("div", {
        id: DASH_ID,
        style: {
          fontFamily: "'Courier New', monospace",
          fontSize: "14px",
          padding: "2px 10px 6px",
          boxSizing: "border-box",
          width: "100%",
          color: "#e2e8f0",
        },
      },
        headerBar(ns, C),
        tabBar(ns, C),
        activePanel(ns, C),
      )
    );
  } catch (e) {
    ns.print("HUD error: " + String(e));
    ns.print(e?.stack ?? "");
  }
}

/** @param {NS} ns */
function headerBar(ns, C) {
  const node = ns.getResetInfo().currentNode;
  const name = forNode(node).name ?? "";
  return el("div", {
    style: {
      display: "flex", justifyContent: "space-between", alignItems: "baseline",
      marginBottom: "6px", borderBottom: `1px solid ${C.border}`, paddingBottom: "4px",
    },
  },
    el("span", { style: { fontSize: "17px", fontWeight: "bold", letterSpacing: "2px", color: C.green } }, "[ GORDNET ]"),
    el("div", { style: { display: "flex", gap: "14px", alignItems: "baseline" } },
      el("span", { style: { fontSize: "13px", color: C.blue } }, `BN${node}${name ? " " + name : ""}`),
      el("span", { style: { fontSize: "13px", color: C.yellow } }, `run ${getRunDuration(ns)}`),
      el("span", { style: { fontSize: "13px", color: C.dim } }, new Date().toLocaleTimeString()),
    ),
  );
}

/**
 * Tab bar. onClick ONLY sets the module-level activeTab (a pure JS assignment,
 * no ns call); the render loop repaints with the new tab on its next poll. This
 * is the fix for the click-crash: calling any ns function from a DOM event
 * handler stops the script.
 * @param {NS} ns
 */
function tabBar(ns, C) {
  return el("div", { style: { display: "flex", gap: "4px", marginBottom: "8px" } },
    ...TABS.map(t => {
      const on = activeTab === t.id;
      return el("div", {
        key: t.id,
        onClick: () => { activeTab = t.id; },
        style: {
          cursor: "pointer",
          userSelect: "none",
          fontSize: "12px",
          fontWeight: "bold",
          letterSpacing: "1px",
          padding: "3px 12px",
          borderRadius: "4px 4px 0 0",
          color: on ? C.green : C.dim,
          background: on ? C.green + "18" : "transparent",
          borderBottom: on ? `2px solid ${C.green}` : `2px solid ${C.border}`,
        },
      }, t.label);
    }),
  );
}

/** @param {NS} ns */
function activePanel(ns, C) {
  try {
    if (activeTab === "journal") return journalPanel(ns, C);
    if (activeTab === "gang")    return wrapCards(gangPanel(ns, C), C, "No gang yet - grinding toward one (watch the karma line in STATS / JOURNAL).");
    if (activeTab === "corp")    return wrapCards(corpPanel(ns, C), C, "No corporation in this BitNode.");
    if (activeTab === "sleeve")  return wrapCards(sleevePanel(ns, C), C, "No sleeve activity (BN10 only - the manager starts once a host has ~40GB free).");
    if (!statsData) return el("div", { style: { color: C.dim, fontSize: "13px", padding: "8px 2px" } }, "Gathering stats...");
    return el("div", {}, ...statsPanel(ns, C, statsData));
  } catch (e) {
    return el("div", { style: { color: C.red, fontSize: "12px" } }, `panel error: ${String(e)}`);
  }
}

function wrapCards(cards, C, emptyMsg) {
  if (!cards || cards.length === 0) {
    return el("div", { style: { color: C.dim, fontSize: "13px", padding: "8px 2px" } }, emptyMsg);
  }
  return el("div", {}, ...cards);
}

/** @param {NS} ns */
function gangPanel(ns, C) {
  try { return gangExtraCards(ns, C) ?? []; } catch { return []; }
}

/** @param {NS} ns */
function corpPanel(ns, C) {
  try { return corpExtraCards(ns, C) ?? []; } catch { return []; }
}

/** @param {NS} ns */
function sleevePanel(ns, C) {
  try { return sleeveExtraCards(ns, C) ?? []; } catch { return []; }
}

// ── STATS tab ─────────────────────────────────────────────────────────────────

/**
 * Persistent progression card (leads the STATS tab) followed by the live
 * operational cards. Returns an array of cards for the panel wrapper.
 * @param {NS} ns
 */
function statsPanel(ns, C, d) {
  return [progressionCard(ns, C, d), ...buildOperationalCards(ns, C, d)];
}

/**
 * Cross-BitNode progression: Source-Files, Intelligence, augs, karma/kills, and
 * all-time earnings. These carry across BitNodes (SF, Intelligence) or represent
 * whole-run progress, unlike the per-tick operational cards below.
 * @param {NS} ns
 */
function progressionCard(ns, C, d) {
  const fmt = (v) => (v == null ? "-" : ns.format.number(v));
  const rowStyle = { display: "flex", justifyContent: "space-between", marginTop: "6px" };
  const badge = (color) => ({
    fontSize: "11px", padding: "1px 6px", borderRadius: "3px",
    border: `1px solid ${color}55`, color, background: color + "11",
  });

  const sfBadges = d.sf.length
    ? d.sf.map(([num, lvl]) => el("span", { key: num, style: badge(C.purple) }, `SF${num}.${lvl}`))
    : [el("span", { style: { color: C.dim, fontSize: "12px" } }, "none yet")];

  return card(C, "PROGRESSION - persists across BitNodes", [
    el("div", { style: rowStyle },
      stat(C, "BitNode", `${d.node}${d.nodeName ? " " + d.nodeName : ""}`, C.blue),
      stat(C, "Intelligence", ns.format.number(d.intelligence), C.purple),
      stat(C, "Augs", `${d.augsInstalled} installed`),
    ),
    el("div", { style: rowStyle },
      stat(C, "Karma", ns.format.number(d.karma), d.karma < 0 ? C.red : C.dim),
      stat(C, "Kills", d.kills),
      stat(C, "Run", d.runDuration, C.yellow),
    ),
    el("div", { style: { marginTop: "8px" } },
      label(C, "SOURCE-FILES"),
      el("div", { style: { display: "flex", flexWrap: "wrap", gap: "4px" } }, ...sfBadges),
    ),
    el("div", { style: { ...rowStyle, marginTop: "8px" } },
      stat(C, "$ all-time", `$${fmt(d.allTime)}`, C.green),
      stat(C, "$ this install", `$${fmt(d.install)}`, C.green),
    ),
  ]);
}

/**
 * The live operational cards (player, goal, infra, network, pipeline, stocks) -
 * the former dashboard body, minus the header (now shared) and the per-BN
 * gang/corp cards (now their own tabs). Returns an array of card elements.
 * @param {NS} ns
 */
function buildOperationalCards(ns, C, data) {
  const { player, money, hack, incomeHour, ram, cloud, final,
          state, target, goal, moneyRate, moneyEta, ramRate,
          augQueue, network, stocks, combat, augsOwned } = data;

  // Derived
  const hackPct     = Math.min(1, hack / Math.max(1, Number(final.required) || hack));
  const ramPct      = ram.max > 0 ? ram.used / ram.max : 0;
  const repPct      = target.repReq  > 0 ? Math.min(1, (target.rep  ?? 0) / target.repReq)  : 1;
  const moneyPct    = target.price   > 0 ? Math.min(1, money / target.price)                 : 1;
  const augInstall  = augQueue.urgency === "high"   ? C.red
                    : augQueue.urgency === "medium" ? C.yellow
                    : C.green;

  const actionColor = state.action?.startsWith("Crime")    ? C.red
                    : state.action?.startsWith("Studying") ? C.blue
                    : state.action?.startsWith("Training") ? C.yellow
                    : state.action?.startsWith("Faction")  ? C.purple
                    : C.green;

  return [
    // ── Row 1: Player + Goal side-by-side ───────────────────────────────────
    el("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginBottom: "8px" } },

      // Player card
      card(C, "PLAYER", [
        statRow(C, "$", `${ns.format.number(money)}`, `+${ns.format.number(incomeHour)}/hr`, C.green),
        statRow(C, "~", `Hack ${hack}`, final.missing <= 0 ? "[OK]" : `${final.eta} to BN`, hack >= (Number(final.required) || hack) ? C.green : C.yellow),
        progressBar(hackPct, C.blue),

        // Combat stats - gate for Slum Snakes/Tetrads/Syndicate/etc.
        el("div", { style: { display: "flex", justifyContent: "space-between", marginTop: "6px" } },
          ...combat.map(s =>
            stat(C, s.label, s.have, s.met ? C.green : s.close ? C.yellow : C.dim)
          ),
        ),

        el("div", { style: { display: "flex", justifyContent: "space-between", marginTop: "6px" } },
          stat(C, "City",   player.city),
          stat(C, "Karma",  ns.format.number(data.player.karma)),
          stat(C, "Kills",  data.player.numPeopleKilled),
        ),

        el("div", { style: { display: "flex", justifyContent: "space-between", marginTop: "6px" } },
          stat(C, "Factions", `${(player.factions ?? []).length} joined`),
          stat(C, "Augs",     `${augsOwned} owned`),
        ),
      ]),

      // Current Goal card
      card(C, "GOAL", [
        el("div", { style: { display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px" } },
          el("span", {
            style: {
              background: actionColor + "22",
              border: `1px solid ${actionColor}55`,
              color: actionColor,
              borderRadius: "4px",
              padding: "1px 6px",
              fontSize: "13px",
              fontWeight: "bold",
            },
          }, state.action ?? "Idle"),
        ),
        el("div", { style: { color: C.dim, fontSize: "13px", marginBottom: "8px", wordBreak: "break-word", lineHeight: "1.4" } },
          state.detail ?? "-"
        ),
        target.faction ? el("div", { style: {} },
          label(C, "Rep"),
          progressBar(repPct, C.purple),
          el("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "13px", color: C.dim, marginBottom: "5px" } },
            el("span", {}, `${ns.format.number(target.rep ?? 0)} / ${ns.format.number(target.repReq ?? 0)}`),
            el("span", {}, goal.eta),
          ),
          label(C, "Price"),
          progressBar(moneyPct, C.green),
          el("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "13px", color: C.dim } },
            el("span", {}, `$${ns.format.number(money)} / $${ns.format.number(target.price ?? 0)}`),
            el("span", {}, moneyEta),
          ),
        ) : el("div", { style: { color: C.dim, fontSize: "13px" } }, "No aug target"),
      ]),
    ),

    // ── Infra + Aug Queue in one card ───────────────────────────────────────
    card(C, "INFRA / AUGS", [
      el("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 20px" } },

        // Left: RAM + cloud
        el("div", {},
          progressBar(ramPct, ramPct > 0.9 ? C.red : ramPct > 0.7 ? C.yellow : C.blue),
          el("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "12px", color: C.dim, marginBottom: "5px" } },
            el("span", {}, `${ns.format.ram(ram.used)} / ${ns.format.ram(ram.max)}`),
            el("span", {}, `+${ns.format.ram(ramRate)}/hr`),
          ),
          el("div", { style: { display: "flex", gap: "10px", fontSize: "12px" } },
            stat(C, "Cloud", `${cloud.count}/${cloud.limit}`),
            stat(C, "RAM",   ns.format.ram(cloud.ram)),
          ),
        ),

        // Right: aug queue
        el("div", {},
          el("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "5px" } },
            el("span", { style: { color: C.dim, fontSize: "12px" } }, "Queued augs"),
            el("span", {
              style: {
                background: augInstall + "22",
                border: `1px solid ${augInstall}55`,
                color: augInstall,
                borderRadius: "4px",
                padding: "0 7px",
                fontWeight: "bold",
                fontSize: "13px",
              },
            }, String(augQueue.queued)),
          ),
          el("div", {
            style: {
              fontSize: "12px",
              color: augInstall,
              padding: "3px 6px",
              background: augInstall + "11",
              borderRadius: "4px",
              borderLeft: `3px solid ${augInstall}`,
            },
          }, augQueue.recommendation),
        ),
      ),
    ]),

    // ── Network Checklist ───────────────────────────────────────────────────
    card(C, "NETWORK", [
      el("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 16px" } },

        // Backdoors - compact badge row
        el("div", {},
          el("div", { style: { fontSize: "11px", color: C.dim, letterSpacing: "1px", marginBottom: "4px" } }, "BACKDOORS"),
          el("div", { style: { display: "flex", flexWrap: "wrap", gap: "4px" } },
            ...network.backdoors.map(b => {
              const color = b.done ? C.green : !b.exists ? "rgba(255,255,255,0.2)" : !b.rooted ? C.red : C.yellow;
              return el("span", {
                key: b.server,
                style: {
                  fontSize: "11px",
                  padding: "1px 6px",
                  borderRadius: "3px",
                  border: `1px solid ${color}55`,
                  color,
                  background: color + "11",
                },
              }, b.label);
            }),
          ),
        ),

        // Factions - compact badge row
        el("div", {},
          el("div", { style: { fontSize: "11px", color: C.dim, letterSpacing: "1px", marginBottom: "4px" } }, "FACTIONS"),
          el("div", { style: { display: "flex", flexWrap: "wrap", gap: "4px" } },
            ...network.factions.map(f => {
              const color = f.joined ? C.green : C.dim;
              return el("span", {
                key: f.name,
                style: {
                  fontSize: "11px",
                  padding: "1px 6px",
                  borderRadius: "3px",
                  border: `1px solid ${color}55`,
                  color,
                  background: color + "11",
                },
              }, f.name);
            }),
          ),
        ),
      ),

      // Programs - full-width badge row below the grid
      el("div", { style: { marginTop: "8px", borderTop: `1px solid ${C.border}`, paddingTop: "6px" } },
        el("div", { style: { fontSize: "11px", color: C.dim, letterSpacing: "1px", marginBottom: "4px" } }, "PROGRAMS"),
        el("div", { style: { display: "flex", flexWrap: "wrap", gap: "4px" } },
          ...network.programs.map(p => {
            const color = p.owned ? C.green : C.dim;
            return el("span", {
              key: p.name,
              style: {
                fontSize: "11px",
                padding: "1px 6px",
                borderRadius: "3px",
                border: `1px solid ${color}55`,
                color,
                background: color + "11",
              },
            }, p.label);
          }),
        ),
      ),
    ]),

    // ── Aug Pipeline + Faction Pipeline (merged) ────────────────────────────
    card(C, "PIPELINE", [
      el("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" } },

        // Left: aug pipeline
        el("div", { style: { minWidth: 0 } },
          el("div", { style: { fontSize: "11px", color: C.dim, letterSpacing: "1px", marginBottom: "6px" } }, "AUGS"),
          ...(globalThis.gordAugPipeline ?? []).slice(0, 10).map((a, i) => {
            const done    = a.canBuy;
            const repDone = a.repMissing <= 0;
            const color   = done ? C.green : repDone ? C.yellow : C.dim;
            const etaStr  = done ? "READY"
                          : isFinite(a.estimatedMs) ? formatDuration(a.estimatedMs)
                          : repDone ? `$${ns.format.number(a.moneyMissing)}`
                          : `${ns.format.number(a.repMissing)} rep`;
            return el("div", {
              key: i,
              style: {
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                fontSize: "11px",
                padding: "2px 0",
                borderBottom: i < 9 ? `1px solid ${C.border}` : "none",
                minWidth: 0,
              },
            },
              el("span", { style: { color: i === 0 ? "#e2e8f0" : C.dim, fontWeight: i === 0 ? "bold" : "normal", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                `${i === 0 ? "> " : "  "}${a.aug}`
              ),
              el("span", { style: { color, fontWeight: "bold", flexShrink: 0, marginLeft: "8px", whiteSpace: "nowrap" } }, etaStr),
            );
          }),
        ),

        // Right: faction pipeline
        el("div", { style: { minWidth: 0 } },
          el("div", { style: { fontSize: "11px", color: C.dim, letterSpacing: "1px", marginBottom: "6px" } }, "FACTIONS"),
          ...(globalThis.gordFactionPipeline ?? []).slice(0, 10).map((op, i) => {
            const urgencyColor = op.urgency === "high"   ? C.red
                               : op.urgency === "medium" ? C.yellow
                               : C.dim;
            return el("div", {
              key: i,
              style: {
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                fontSize: "11px",
                padding: "2px 0",
                borderBottom: i < 9 ? `1px solid ${C.border}` : "none",
                minWidth: 0,
              },
            },
              el("span", { style: { color: op.hackingFocus ? C.blue : "#e2e8f0", flex: "0 0 auto", whiteSpace: "nowrap", marginRight: "8px" } },
                op.faction
              ),
              el("span", { style: { color: urgencyColor, flex: 1, minWidth: 0, whiteSpace: "normal", wordBreak: "break-word", textAlign: "right", lineHeight: "1.3" } }, op.reason ?? ""),
            );
          }),
        ),
      ),
    ]),

    // ── Stocks ──────────────────────────────────────────────────────────────
    (() => {
      if (!stocks) {
        return card(C, "STOCKS", [
          el("div", { style: { color: C.dim, fontSize: "13px" } }, "stocks.js not running"),
        ]);
      }

      const tierLabel = stocks.tier === 2 ? "4S (forecast)" : stocks.tier === 1 ? "Momentum" : "No TIX access";
      const tierColor = stocks.tier === 2 ? C.green : stocks.tier === 1 ? C.yellow : C.dim;

      return card(C, "STOCKS", [
        // Header: tier + total portfolio value
        el("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" } },
          el("span", { style: { color: tierColor, fontSize: "12px", fontWeight: "bold" } }, tierLabel),
          el("span", { style: { color: C.green, fontSize: "13px", fontWeight: "bold" } },
            stocks.totalValue > 0 ? `Portfolio: $${ns.format.number(stocks.totalValue)}` : "No positions"
          ),
        ),

        // Position rows
        ...(stocks.positions.length === 0
          ? [el("div", { style: { color: C.dim, fontSize: "12px" } }, "No open positions")]
          : stocks.positions.slice(0, 6).map((p, i) => {
              const isLong   = p.sharesLong  > 0;
              const isShort  = p.sharesShort > 0;
              const pl       = isLong ? p.longPL : p.shortPL;
              const posVal   = isLong ? p.longValue : p.shortValue;
              const plColor  = pl >= 0 ? C.green : C.red;
              const typeTag  = isShort ? "[S]" : "[L]";
              const typeClr  = isShort ? C.purple : C.blue;
              const fStr     = p.forecast !== null
                ? ` ${(p.forecast * 100).toFixed(0)}%`
                : "";

              return el("div", {
                key: i,
                style: {
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  fontSize: "12px",
                  padding: "2px 0",
                  borderBottom: i < Math.min(stocks.positions.length, 6) - 1 ? `1px solid ${C.border}` : "none",
                },
              },
                el("div", { style: { display: "flex", gap: "5px", alignItems: "center" } },
                  el("span", { style: { color: typeClr, fontWeight: "bold", fontSize: "11px" } }, typeTag),
                  el("span", { style: { color: "#e2e8f0" } }, p.sym),
                  el("span", { style: { color: C.dim, fontSize: "11px" } }, fStr),
                ),
                el("div", { style: { display: "flex", gap: "10px", alignItems: "center" } },
                  el("span", { style: { color: C.dim, fontSize: "11px" } }, `$${ns.format.number(posVal)}`),
                  el("span", { style: { color: plColor, fontWeight: "bold", fontSize: "11px" } },
                    `${pl >= 0 ? "+" : ""}$${ns.format.number(pl)}`
                  ),
                ),
              );
            })
        ),

        // Recent trade log (last 2 lines)
        ...((globalThis.gordStockLog ?? []).slice(-2).map((line, i) =>
          el("div", { key: `log-${i}`, style: { color: C.dim, fontSize: "11px", marginTop: i === 0 ? "6px" : "1px", fontFamily: "monospace" } }, line)
        )),
      ]);
    })(),
  ];
}

// Width is fixed to what the card layout was designed for; height tracks the
// rendered content so every tab (stats, journal, gang, corp) is fully visible.
const DASH_WIDTH = UI.tail.width;
const DASH_MIN_H = UI.tail.minHeight;
const DASH_MAX_H = UI.tail.maxHeight;

/**
 * Size the tail window to fit the rendered HUD. Measures the actual DOM height
 * of our root element (id=DASH_ID) and resizes to match, so nothing gets clipped
 * and there's no empty space. Falls back to a sane default before the first
 * frame exists or if the DOM isn't reachable.
 * @param {NS} ns
 */
function fitTail(ns) {
  let height = 820;
  try {
    // Access document via a string key: referencing the `document` identifier
    // directly costs 25GB of script RAM in Bitburner; `globalThis["document"]`
    // isn't flagged by the static RAM analyzer.
    const doc = globalThis["document"];
    const node = doc?.getElementById(DASH_ID);
    if (node) {
      // +58 covers the tail title bar and the log container's own padding.
      height = Math.ceil(node.getBoundingClientRect().height) + 58;
    }
  } catch {}
  height = Math.max(DASH_MIN_H, Math.min(DASH_MAX_H, height));
  ns.ui.resizeTail(DASH_WIDTH, height);
}

// ── Data helpers ─────────────────────────────────────────────────────────────

/**
 * Gather everything the STATS tab needs in one pass: persistent progression
 * (Source-Files, Intelligence, all-time money) plus the live operational data.
 * @param {NS} ns
 */
function gatherStats(ns) {
  const player = ns.getPlayer();
  const reset  = ns.getResetInfo();
  const ram    = getRamStats(ns);
  const state  = globalThis.gordState ?? {};
  const target = state.target ?? {};
  const moneyRate = updateMoneyTrend(ns);

  let allTime = null, install = null;
  try {
    const n = /** @type {any} */ (ns);
    const ms = n.getMoneySources?.();
    allTime = ms?.sinceStart?.total ?? null;
    install = ms?.sinceInstall?.total ?? null;
  } catch {}

  const sf = [...(reset.ownedSF ?? new Map()).entries()].sort((a, b) => a[0] - b[0]);

  return {
    // Live operational
    player,
    money:       player.money,
    hack:        player.skills.hacking,
    incomeHour:  getIncomePerHour(ns),
    ram,
    cloud:       getCloudStats(ns),
    final:       getHackTargetEstimate(ns, FINAL_HOST),
    state,
    target,
    goal:        getGoalEstimate(ns, target),
    moneyRate,
    moneyEta:    etaFromRate(target.moneyMissing ?? 0, moneyRate),
    ramRate:     updateRamTrend(ns, ram.max),
    augQueue:    getAugQueueInfo(ns),
    network:     getNetworkStatus(ns),
    stocks:      globalThis.gordStockState ?? null,
    combat:      getCombatStats(ns),
    augsOwned:   ns.singularity.getOwnedAugmentations(true).length,

    // Persistent-across-BitNodes progression
    node:          reset.currentNode,
    nodeName:      forNode(reset.currentNode).name ?? "",
    sf,
    intelligence:  player.skills.intelligence ?? 0,
    augsInstalled: (reset.ownedAugs ?? new Map()).size,
    karma:         player.karma ?? 0,
    kills:         player.numPeopleKilled ?? 0,
    runDuration:   getRunDuration(ns),
    allTime,
    install,
  };
}

// The 5 port openers, labelled by filename minus the .exe.
const ROOTING_PROGRAMS = CONFIG.programs.portOpeners.map(name => ({
  name,
  label: name.replace(/\.exe$/, ""),
}));

/** @param {NS} ns */
function getNetworkStatus(ns) {
  const joinedSet = /** @type {Set<string>} */ (new Set(ns.getPlayer().factions ?? []));

  const backdoors = BACKDOOR_CHECKLIST.map(({ server, label }) => {
    const exists = ns.serverExists(server);
    const rooted = exists && ns.hasRootAccess(server);
    const done   = exists && ns.getServer(server).backdoorInstalled;
    return { server, label, exists, rooted, done };
  });

  const factions = FACTION_CHECKLIST.map(name => ({
    name,
    joined: joinedSet.has(name),
  }));

  const programs = ROOTING_PROGRAMS.map(({ name, label }) => ({
    name,
    label,
    owned: ns.fileExists(name, "home"),
  }));

  return { backdoors, factions, programs };
}

/** @param {NS} ns */
function getIncomePerHour(ns) {
  const n = /** @type {any} */ (ns);
  if (!n.getMoneySources || !n.getResetInfo) return 0;
  const sources = n.getMoneySources();
  const reset   = n.getResetInfo();
  const total   = sources.sinceInstall.total;
  const seconds = Math.max(1, (Date.now() - reset.lastAugReset) / 1000);
  return (total / seconds) * 3600;
}

/** @param {NS} ns */
function getCombatStats(ns) {
  const skills = ns.getPlayer().skills ?? {};

  // Highest requirement any tracked faction demands for each stat (currently
  // Speakers for the Dead / The Dark Army at 300) - our "fully gated" bar.
  const maxReq = {};
  for (const { key } of COMBAT_STAT_DEFS) {
    maxReq[key] = Math.max(0, ...Object.values(FACTION_REQUIREMENTS).map(r => r[key] ?? 0));
  }

  return COMBAT_STAT_DEFS.map(({ key, label }) => {
    const have = skills[key] ?? 0;
    const need = maxReq[key];
    return {
      label,
      have,
      met:   need > 0 && have >= need,
      close: need > 0 && have < need && need - have <= UI.closeStatGap,
    };
  });
}

/** @param {NS} ns */
function getRunDuration(ns) {
  try {
    const n = /** @type {any} */ (ns);
    if (!n.getResetInfo) return "?";
    const reset = n.getResetInfo();
    return formatDuration(Date.now() - reset.lastAugReset);
  } catch {
    return "?";
  }
}

/** @param {NS} ns */
function getRamStats(ns) {
  const hosts = ["home", ...ns.cloud.getServerNames()];
  let used = 0, max = 0;
  for (const h of hosts) {
    used += ns.getServerUsedRam(h);
    max  += ns.getServerMaxRam(h);
  }
  return { used, max, free: max - used };
}

/** @param {NS} ns */
function getCloudStats(ns) {
  const servers = ns.cloud.getServerNames();
  return {
    count: servers.length,
    limit: ns.cloud.getServerLimit(),
    ram:   servers.reduce((s, n) => s + ns.getServerMaxRam(n), 0),
  };
}

/** @param {NS} ns */
function getHackTargetEstimate(ns, host) {
  if (!ns.serverExists(host)) {
    return { required: "?", missing: "?", eta: "not discovered", rate: 0 };
  }

  const required = ns.getServerRequiredHackingLevel(host);
  const current  = ns.getPlayer().skills.hacking;
  const missing  = Math.max(0, required - current);
  const now      = Date.now();

  if (lastHackLevel > 0 && now > lastHackTime) {
    const gain  = current - lastHackLevel;
    const hours = (now - lastHackTime) / 3_600_000;
    if (gain > 0 && hours > 0) {
      const instant = gain / hours;
      hackLevelsPerHour = hackLevelsPerHour === 0
        ? instant
        : hackLevelsPerHour * 0.8 + instant * 0.2;
    }
  }
  lastHackLevel = current;
  lastHackTime  = now;

  const eta = missing <= 0           ? "ready now"
            : hackLevelsPerHour > 0  ? formatDuration((missing / hackLevelsPerHour) * 3_600_000)
            : "-";

  return { required, missing, eta, rate: hackLevelsPerHour };
}

/** @param {NS} ns */
function getGoalEstimate(ns, target) {
  if (!target?.faction) return { rate: 0, eta: "-" };

  const currentRep = ns.singularity.getFactionRep(/** @type {any} */ (target.faction));
  const now        = Date.now();

  if (lastFactionRep > 0 && now > lastFactionTime) {
    const gained = currentRep - lastFactionRep;
    const hours  = (now - lastFactionTime) / 3_600_000;
    if (gained > 0 && hours > 0) {
      const instant = gained / hours;
      factionRepPerHour = factionRepPerHour === 0
        ? instant
        : factionRepPerHour * 0.8 + instant * 0.2;
    }
  }
  lastFactionRep  = currentRep;
  lastFactionTime = now;

  const eta = (target.repMissing ?? 0) <= 0  ? "complete"
            : factionRepPerHour > 0           ? formatDuration((target.repMissing / factionRepPerHour) * 3_600_000)
            : "-";

  return { rate: factionRepPerHour, eta };
}

/** @param {NS} ns */
function updateMoneyTrend(ns) {
  const money = ns.getPlayer().money;
  const now   = Date.now();
  if (lastMoney > 0 && now > lastMoneyTime) {
    const gained = money - lastMoney;
    const hours  = (now - lastMoneyTime) / 3_600_000;
    if (gained > 0 && hours > 0) {
      const instant = gained / hours;
      moneyPerHour = moneyPerHour === 0 ? instant : moneyPerHour * 0.8 + instant * 0.2;
    }
  }
  lastMoney     = money;
  lastMoneyTime = now;
  return moneyPerHour;
}

/** @param {NS} ns */
function updateRamTrend(ns, totalRam) {
  const now = Date.now();
  if (lastRamTotal > 0 && now > lastRamTime) {
    const gained = totalRam - lastRamTotal;
    const hours  = (now - lastRamTime) / 3_600_000;
    if (gained > 0 && hours > 0) {
      const instant = gained / hours;
      ramPerHour = ramPerHour === 0 ? instant : ramPerHour * 0.8 + instant * 0.2;
    }
  }
  lastRamTotal = totalRam;
  lastRamTime  = now;
  return ramPerHour;
}

/** @param {NS} ns */
function getAugQueueInfo(ns) {
  const withPurchased = ns.singularity.getOwnedAugmentations(true);
  const installed     = ns.singularity.getOwnedAugmentations(false);
  const queued        = withPurchased.length - installed.length;

  const hasRedPill = withPurchased.includes(CONFIG.augs.redPill) && !installed.includes(CONFIG.augs.redPill);

  const urgency        = hasRedPill ? "high" : queued >= 5 ? "medium" : "low";
  const recommendation = hasRedPill         ? "[!!] Install now - Red Pill queued!"
                       : queued >= 5        ? "[!]  Install soon - threshold met"
                       : queued > 0         ? "Keep grinding"
                       : "Nothing queued";

  return { queued, recommendation, urgency };
}

function etaFromRate(remaining, ratePerHour) {
  if (remaining <= 0) return "complete";
  if (!ratePerHour || ratePerHour <= 0) return "-";
  return formatDuration((remaining / ratePerHour) * 3_600_000);
}
