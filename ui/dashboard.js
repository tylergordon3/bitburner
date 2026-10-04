// ui/dashboard.js
//
// GORDNET HUD - one tabbed tail window that combines everything into a single UI:
//   STATS   - cross-BitNode progression (Source-Files, Intelligence, all-time
//             earnings, augs, karma/kills) PLUS the live operational cards
//             (player, goal, infra, network, aug/faction pipeline, stocks).
//   JOURNAL - the plain-text "what am I doing and why" narrative (ui/journal.js).
//   GANG    - the gang / karma-bootstrap card (ui/bn5.js -> ui/bn2.js).
//   CORP    - the corporation card (ui/bn3.js).
//   SLEEVE  - the duplicate-sleeve roster/status card (ui/bn10.js), on any node
//             with BN10/SF10 sleeves.
//   HACKNET - the hacknet-server fleet + hash cards (ui/bn9.js), wherever
//             lib/hacknet.js runs (BN9 / SF9).
//   BLADE   - the Bladeburner rank / black-op / skills cards (ui/bn6.js),
//             wherever lib/bladeburner.js runs (BN6/7).
//   GO      - the IPvGO game in hand and the stat bonuses earned (ui/go.js),
//             wherever lib/go.js runs (every node, when it finds ~10GB).
//   ACHIEVE - the campaign's next steps and the planned achievements still
//             missing (ui/achievements.js), read from the save by lib/achievements.js.
//   STANEK  - Stanek's Gift: the layout, each fragment's charge, the RAM the
//             charge workers hold (ui/stanek.js), in BN13 or with SF13.
//
// The header also carries the switches (TOGGLES / toggleButton) - the only
// controls in here that change what the BOT does rather than what the HUD shows:
// AUTO-FOCUS (lib/player-actions.js focusFlag), AUTO-FINISH (lib/daemon-lib.js
// ensureBackdoorHelpers) and AUTO-CORP (lib/corp-daemon.js corpAutoEnabled).
// lib/toggles.js persists all three.
//
// The script loop paints the HUD (clearLog + printRaw). A tab click only flips a
// module variable (activeTab) - it must NOT call any ns function, because calling
// ns from a DOM event handler stops the script. (React hooks in a printRaw'd
// component are also unsupported here, so a self-managing component isn't an
// option - the loop drives rendering.) To keep the JOURNAL tab's scroll from
// resetting, the loop repaints only on a tab switch or every uiRefreshMs. This
// one tail replaces the old separate dashboard + journal windows.

import { CONFIG, forNode } from "../lib/config.js";
import { COLORS, el, card, label, progressBar, stat, statRow, formatDuration, shortenAugNames, fresh } from "./dashboard-lib.js";
// Gang + corp panels reuse the existing per-node card modules. bn5's extraCards
// already composes the running-gang card (via bn2.js) with the BN5 karma
// bootstrap card and returns [] elsewhere, so it doubles as a universal gang
// panel; bn3's returns the corp card (or a pending/empty placeholder).
import { extraCards as gangExtraCards } from "./bn5.js";
import { extraCards as corpExtraCards } from "./bn3.js";
import { extraCards as sleeveExtraCards } from "./bn10.js";
import { extraCards as hacknetExtraCards } from "./bn9.js";
import { extraCards as bladeExtraCards } from "./bn6.js";
import { extraCards as goExtraCards } from "./go.js";
import { extraCards as stanekExtraCards } from "./stanek.js";
import { extraCards as achievementCards } from "./achievements.js";
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

// The HUD tabs.
const TABS = [
  { id: "stats",   label: "STATS" },
  { id: "journal", label: "JOURNAL" },
  { id: "gang",    label: "GANG" },
  { id: "corp",    label: "CORP" },
  { id: "sleeve",  label: "SLEEVE" },
  { id: "hacknet", label: "HACKNET" },
  { id: "blade",   label: "BLADE" },
  { id: "go",      label: "GO" },
  { id: "stanek",  label: "STANEK" },
  { id: "achieve", label: "ACHIEVE" },
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
// Set by a header toggle's onClick so the next poll repaints immediately - a switch
// has to feel like a switch, not like something that responds a second later.
let forceRender = false;

// ── Trend state ─────────────────────────────────────────────────────────────

/**
 * An hourly-rate tracker: feed it a sampled value, get back an EMA of the
 * per-hour gain (only positive gains count - a reset, a spend, or a sample
 * going backwards just holds the last rate). One closure replaces the four
 * copies of last-value / last-time / per-hour module state this file used to
 * carry for hack level, faction rep, money and RAM.
 * @param {number} [alpha] weight of the newest sample
 */
function makeTrend(alpha = 0.2) {
  let last = 0;
  let lastAt = Date.now();
  let perHour = 0;
  let lastKey = /** @type {any} */ (undefined);
  return {
    /**
     * @param {number} value
     * @param {any} [key] what the value belongs to (the faction being ground, the
     *   run since the last reset). A new key starts the trend over: without it a
     *   switch from a 10k-rep faction to a 500k one read as 490k gained in one
     *   tick, and a rate from before an install carried into the run after it.
     * @returns {number} the smoothed per-hour rate
     */
    update(value, key) {
      const now = Date.now();
      if (key !== lastKey) {
        lastKey = key;
        last = value;
        lastAt = now;
        perHour = 0;
        return perHour;
      }
      if (last > 0 && now > lastAt) {
        const gain = value - last;
        const hours = (now - lastAt) / 3_600_000;
        if (gain > 0 && hours > 0) {
          const instant = gain / hours;
          perHour = perHour === 0 ? instant : perHour * (1 - alpha) + instant * alpha;
        }
      }
      last = value;
      lastAt = now;
      return perHour;
    },
    get rate() { return perHour; },
  };
}

const hackTrend = makeTrend();
const repTrend = makeTrend();
const moneyTrend = makeTrend();
const ramTrend = makeTrend();

// ── Entry point ──────────────────────────────────────────────────────────────
/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.ui.openTail();
  // A tail window outlives its script. Left open, the dead HUD keeps its last
  // frame on screen - with toggle buttons that still flip the real switches but
  // never repaint - and the restarted HUD opens a second window on top of it.
  ns.atExit(() => ns.ui.closeTail());
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
    if (tabChanged || renderAgain || forceRender || now - lastRenderAt >= HUD.uiRefreshMs) {
      forceRender = false;
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

/** How long since the daemon last published its state (0 before it ever has). */
function daemonSilentMs() {
  const at = globalThis.gordState?.updatedAt;
  return at ? Date.now() - at : 0;
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
      // The daemon stamps gordState every tick. Without this, a daemon that died
      // left its last GOAL and PIPELINE on screen under a clock that kept ticking,
      // and nothing said the bot had stopped.
      ...(daemonSilentMs() > UI.daemonStaleMs
        ? [el("span", { style: { fontSize: "13px", fontWeight: "bold", color: C.red } },
            `DAEMON DOWN ${Math.round(daemonSilentMs() / 1000)}s`)]
        : []),
      el("span", { style: { fontSize: "13px", color: C.blue } }, `BN${node}${name ? " " + name : ""}`),
      el("span", { style: { fontSize: "13px", color: C.yellow } }, `run ${getRunDuration(ns)}`),
      ...TOGGLES.map(t => toggleButton(ns, C, t)),
      el("span", { style: { fontSize: "13px", color: C.dim } }, new Date().toLocaleTimeString()),
    ),
  );
}

/**
 * The header switches. Each is a globalThis boolean the daemon reads and
 * lib/toggles.js persists; the HUD only ever assigns to it, because any ns call from
 * a DOM event handler stops the script (same constraint as the tab handlers).
 *
 * All default ON, i.e. to the behaviour the bot had before they existed.
 */
const TOGGLES = [
  {
    key: "gordAutoFocus",
    file: CONFIG.paths.focusFile,
    on: "FOCUS: AUTO",
    off: "FOCUS: OFF",
    // Focused work pins the game to its work screen and the daemon re-issues that
    // work every tick, so hand-managing the corp or the gang is impossible while
    // the bot is focus-working. Read by lib/player-actions.js (focusFlag), which
    // also drops focus on the work already running so the effect is immediate.
    onTitle: "Auto-focus ON - the bot focuses its work (full rate). Click to release the UI so you can manage the corp/gang by hand.",
    offTitle: "Auto-focus OFF - the bot works unfocused (-20% rate without the Neuroreceptor implant) and leaves the UI alone. Click to resume focusing.",
  },
  {
    key: "gordAutoFinish",
    file: CONFIG.paths.autoFinishFile,
    on: "FINISH: AUTO",
    off: "FINISH: OFF",
    // Read by lib/daemon-lib.js (ensureBackdoorHelpers). Off changes nothing except
    // the one irreversible step: everything still runs, we just don't end the
    // node (the bot never backdoors w0r1d_d43m0n itself - that IS the finish).
    onTitle: "Auto-finish ON - the bot destroys w0r1d_d43m0n and enters the next BitNode once it can. Click to stay in this node.",
    offTitle: "Auto-finish OFF - the daemon runs as normal and won't beat the BitNode - w0r1d_d43m0n is left for you to backdoor. Click to let it finish.",
  },
  {
    key: "gordCorpAuto",
    file: CONFIG.paths.autoCorpFile,
    on: "CORP: AUTO",
    off: "CORP: OFF",
    // Read by lib/corp-daemon.js (corpAutoEnabled). Off stops the daemon deploying
    // any corp script AND kills the ones already running (creator, operator,
    // upkeep, and the four build phases), so the corporation is entirely hand-run
    // until it's switched back on. Everything else the bot does is unaffected.
    onTitle: "Auto-corp ON - the bot creates and runs the corporation. Click to stop deploying corp scripts and kill the running ones so you can run it by hand.",
    offTitle: "Auto-corp OFF - no corp script is deployed and any running ones were killed; the corporation is yours to run. Click to hand it back to the bot.",
  },
];

/**
 * Displayed state of a toggle. globalThis is the live value the daemon acts on, but
 * a page load wipes it while the persisted file survives - so between a reload and
 * the daemon's first tick the header used to paint FINISH: AUTO over a deliberate
 * "off", which is the last thing this switch should ever misreport. Seed the display
 * from disk in that window.
 *
 * One-directional on purpose: we only ever seed OFF, never ON. ns.read sees the LOCAL
 * host's files and this HUD is usually placed off-home (ensureHelper), where the file
 * simply is not present - an absent file must not read as "on" and clobber a real
 * "off" for lib/toggles.js to then persist.
 * @param {NS} ns
 */
function toggleState(ns, t) {
  if (globalThis[t.key] === undefined && String(ns.read(t.file)).trim() === "off") {
    globalThis[t.key] = false;
  }
  return globalThis[t.key] !== false;
}

function toggleButton(ns, C, t) {
  const on = toggleState(ns, t);
  const color = on ? C.green : C.yellow;
  return el("span", {
    key: t.key,
    onClick: () => { globalThis[t.key] = !on; forceRender = true; },
    title: on ? t.onTitle : t.offTitle,
    style: {
      cursor: "pointer",
      userSelect: "none",
      fontSize: "12px",
      fontWeight: "bold",
      letterSpacing: "1px",
      padding: "1px 8px",
      borderRadius: "4px",
      color,
      background: color + "18",
      border: `1px solid ${color}55`,
    },
  }, on ? t.on : t.off);
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
    if (activeTab === "sleeve")  return wrapCards(sleevePanel(ns, C), C, "No sleeve activity (needs BN10 or SF10, and a host with ~72GB free for the manager).");
    if (activeTab === "hacknet") return wrapCards(hacknetPanel(ns, C), C, "No hacknet-server manager running (BN9 / SF9 only - lib/hacknet.js).");
    if (activeTab === "blade")   return wrapCards(bladePanel(ns, C), C, "No Bladeburner loop running (BN6/7 - lib/bladeburner.js).");
    if (activeTab === "go")      return wrapCards(goExtraCards(ns, C) ?? [], C, "No IPvGO player running (lib/go.js - needs a host with ~10GB free, and go.enabled).");
    if (activeTab === "stanek")  return wrapCards(stanekExtraCards(ns, C) ?? [], C, "No Stanek's Gift manager running (BN13 / SF13 only - lib/stanek.js).");
    if (activeTab === "achieve") return wrapCards(achievementCards(ns, C) ?? [], C, "Achievements not read yet (lib/achievements.js reads them out of the save - needs Singularity and ~3GB free somewhere).");
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

// No try/catch in these wrappers: an exception used to come back as an empty
// list, which wrapCards renders as "nothing running" - so one missing field in a
// helper's state made a live helper look dead. Errors now reach activePanel's
// catch and are shown as what they are.
/** @param {NS} ns */
function gangPanel(ns, C) {
  return gangExtraCards(ns, C) ?? [];
}

/** @param {NS} ns */
function corpPanel(ns, C) {
  return corpExtraCards(ns, C) ?? [];
}

/** @param {NS} ns */
function sleevePanel(ns, C) {
  return sleeveExtraCards(ns, C) ?? [];
}

/** @param {NS} ns */
function hacknetPanel(ns, C) {
  return hacknetExtraCards(ns, C) ?? [];
}

/** @param {NS} ns */
function bladePanel(ns, C) {
  return bladeExtraCards(ns, C) ?? [];
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
 * Progression, split into two side-by-side cards:
 *   CURRENT RUN - everything scoped to this run / BitNode, reset on an install or
 *                 on entering a new node (BitNode, karma, kills, run time, augs
 *                 installed, money earned this install and all-time).
 *   OVERALL     - what genuinely PERSISTS across BitNodes: today just Intelligence
 *                 and the owned Source-Files. New persistent stats go here.
 * @param {NS} ns
 */
function progressionCard(ns, C, d) {
  const fmt = (v) => (v == null ? "-" : ns.format.number(v));
  const rowStyle = { display: "flex", justifyContent: "space-between", marginTop: "6px" };
  const firstRow = { ...rowStyle, marginTop: 0 };
  const badge = (color) => ({
    fontSize: "11px", padding: "1px 6px", borderRadius: "3px",
    border: `1px solid ${color}55`, color, background: color + "11",
  });

  const sfBadges = d.sf.length
    ? d.sf.map(([num, lvl]) => el("span", { key: num, style: badge(C.purple) }, `SF${num}.${lvl}`))
    : [el("span", { style: { color: C.dim, fontSize: "12px" } }, "none yet")];

  const currentCard = card(C, "CURRENT RUN", [
    el("div", { style: firstRow },
      stat(C, "BitNode", `${d.node}${d.nodeName ? " " + d.nodeName : ""}`, C.blue),
      stat(C, "Run", d.runDuration, C.yellow),
    ),
    el("div", { style: rowStyle },
      stat(C, "Karma", ns.format.number(d.karma), d.karma < 0 ? C.red : C.dim),
      stat(C, "Kills", d.kills),
      stat(C, "Augs", `${d.augsInstalled}`),
    ),
    el("div", { style: rowStyle },
      stat(C, "$ this install", `$${fmt(d.install)}`, C.green),
      stat(C, "$ all-time", `$${fmt(d.allTime)}`, C.green),
    ),
  ]);

  const overallCard = card(C, "OVERALL - persists across BitNodes", [
    el("div", { style: firstRow },
      stat(C, "Intelligence", ns.format.number(d.intelligence), C.purple),
    ),
    el("div", { style: { marginTop: "8px" } },
      label(C, "SOURCE-FILES"),
      el("div", { style: { display: "flex", flexWrap: "wrap", gap: "4px" } }, ...sfBadges),
    ),
  ]);

  return el("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" } },
    currentCard,
    overallCard,
  );
}

/**
 * The live operational cards (player, goal, infra, network, pipeline, stocks) -
 * the former dashboard body, minus the header (now shared) and the per-BN
 * gang/corp cards (now their own tabs). Returns an array of card elements.
 * @param {NS} ns
 */
function buildOperationalCards(ns, C, data) {
  // (`hack: hackLevel` - a local called `hack` is billed as ns.hack, 0.1GB.)
  const { player, money, hack: hackLevel, incomeHour, ram, cloud, final,
          state, target, goal, moneyRate, moneyEta, ramRate,
          augQueue, network, stocks, combat, augsOwned } = data;

  // Derived
  const hackPct     = Math.min(1, hackLevel / Math.max(1, Number(final.required) || hackLevel));
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
        statRow(C, "~", `Hack ${hackLevel}`, final.missing <= 0 ? "[OK]" : `${final.eta} to BN`, hackLevel >= (Number(final.required) || hackLevel) ? C.green : C.yellow),
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

    // ── Botnet: what the batcher is doing right now ─────────────────────────
    botnetCard(ns, C),

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

    // ── Network + Contracts, side by side ───────────────────────────────────
    // NETWORK (programs over backdoors, split by a rule, no labels) on the left,
    // CONTRACTS on the right.
    el("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" } },
      card(C, "NETWORK", [
        // Port-opener programs on top, faction backdoors below, split by a thin rule
        // (no sub-labels, tight spacing). Colour carries status: programs green when
        // owned; backdoors green (done) / yellow (ready) / red (rooted, level too
        // low) / faint (not yet reachable).
        el("div", { style: { display: "flex", flexWrap: "wrap", gap: "4px" } },
          ...network.programs.map(p => {
            const color = p.owned ? C.green : C.dim;
            return el("span", {
              key: `prog-${p.name}`,
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
        el("div", { style: { marginTop: "4px", paddingTop: "4px", borderTop: `1px solid ${C.border}`, display: "flex", flexWrap: "wrap", gap: "4px" } },
          ...network.backdoors.map(b => {
            const color = b.done ? C.green : !b.exists ? "rgba(255,255,255,0.2)" : !b.rooted ? C.red : C.yellow;
            return el("span", {
              key: `bd-${b.server}`,
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
      ]),

      contractsCard(ns, C),
    ),

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
              // Why it ranks where it does (lib/aug-value.js): hover for the numbers.
              title: a.value == null ? undefined
                : `${a.faction} - value ${a.value.toFixed(2)}` +
                  (a.bundleValue > a.value ? `, ${a.bundleValue.toFixed(2)} with the cheaper augs its rep unlocks` : ""),
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
                `${i === 0 ? "> " : "  "}${shortenAugNames(a.aug)}`
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

      const tierLabel = stocks.tier === 2 ? "4S (forecast)" : stocks.tier === 1 ? "Estimated forecast" : "No TIX access";
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

/**
 * The HGW batcher's live state (hacking/manager.js publishes gordHackState every
 * tick): mode, primary target, batches in flight against the planned depth, the
 * bite per batch and its launch cadence, and the target's money/security so a
 * stuck prep or a drift drain is visible at a glance.
 *
 * The last two lines are about RAM: which OTHER targets the manager spilled onto
 * (it works several at once, since one target's income is capped by timing) and
 * how much of the botnet all of them add up to. A claimed figure far below
 * capacity is the thing to notice - it means the fleet is idling.
 * @param {NS} ns
 */
function botnetCard(ns, C) {
  const h = globalThis.gordHackState;
  if (!h || Date.now() - (h.updatedAt ?? 0) > 30_000) {
    return card(C, "BOTNET", [
      el("div", { style: { color: C.dim, fontSize: "13px" } }, "manager.js not running"),
    ]);
  }

  const mode = String(h.mode ?? "");
  const modeColor = mode === "Batching" ? C.green
                  : mode.startsWith("Prepping") ? C.yellow
                  : mode.startsWith("Draining") ? C.red
                  : C.dim;
  const secOver = (h.security ?? 0) - (h.minSecurity ?? 0);
  const moneyPct = h.moneyPercent ?? 0;

  return card(C, "BOTNET", [
    el("div", { style: { display: "flex", justifyContent: "space-between", marginBottom: "6px" } },
      stat(C, "Mode", mode, modeColor),
      stat(C, "Target", h.target ?? "-", C.blue),
      stat(C, "In flight", `${h.inFlight ?? 0}/${h.depth ?? 0}`),
      stat(C, "Bite", `${((h.fraction ?? 0) * 100).toFixed(2)}%`),
    ),
    el("div", { style: { display: "flex", justifyContent: "space-between" } },
      stat(C, "Batch", `${ns.format.ram(h.batchRam ?? 0)} every ${((h.launchIntervalMs ?? 0) / 1000).toFixed(1)}s`),
      stat(C, "Weaken", ns.format.time(h.weakenTimeMs ?? 0)),
      stat(C, "Money", `${(moneyPct * 100).toFixed(0)}%`, moneyPct >= 0.95 ? C.green : C.yellow),
      stat(C, "Sec", `+${secOver.toFixed(2)}`, secOver <= 1 ? C.green : C.yellow),
    ),
    ...((h.targets ?? []).length > 1 ? [
      el("div", { style: { color: C.dim, fontSize: "11px", marginTop: "4px" } },
        `also: ${h.targets.slice(1).map(t => `${t.target} ${t.inFlight}/${t.depth} @${(t.fraction * 100).toFixed(1)}%`).join("  |  ")}`
      ),
    ] : []),
    el("div", { style: { color: C.dim, fontSize: "11px", marginTop: "4px" } },
      `using ${ns.format.ram(h.claimedRam ?? 0)} of ${ns.format.ram(h.capacityRam ?? 0)} | free ${ns.format.ram(h.freeRam ?? 0)} | ` +
      `${h.formulas ? "Formulas" : "ns.* fallback"} | batches launched ${h.batchId ?? 0}`
    ),
  ]);
}

/**
 * Coding-contract solver status. lib/contracts.js publishes
 * globalThis.gordContractState (cumulative solved/failed, last reward, unknown
 * types skipped). Universal across BitNodes, so it rides in the STATS tab rather
 * than a per-node extra. Reads globalThis directly, so it's independent of the
 * slow statsData refresh.
 * @param {NS} ns
 */
function contractsCard(ns, C) {
  const s = fresh(globalThis.gordContractState, UI.staleMs.contracts);
  if (!s) {
    return card(C, "CONTRACTS", [
      el("div", { style: { color: C.dim, fontSize: "13px" } }, "contracts.js not running"),
    ]);
  }

  const failColor = s.failedTotal > 0 ? C.red : C.dim;
  const children = [
    el("div", { style: { display: "flex", justifyContent: "space-between", marginBottom: "6px" } },
      stat(C, "Solved", ns.format.number(s.solvedTotal), C.green),
      stat(C, "Failed", ns.format.number(s.failedTotal), failColor),
      stat(C, "Solvers", `${s.supportedCount} types`, C.blue),
    ),
    el("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "12px", color: C.dim } },
      el("span", {}, `Found last scan: ${s.found}`),
      s.unsupported?.length
        ? el("span", { style: { color: C.yellow } }, `${s.unsupported.length} unknown type(s) skipped`)
        : el("span", {}, "all types known"),
    ),
  ];

  if (s.lastReward) {
    // Reward strings can be long (e.g. "... reputation for each of: A, B, C, ...").
    // The card is now half-width, so truncate to keep it to ~2 lines and expose the
    // full text as a hover title.
    const reward = String(s.lastReward);
    const shortReward = reward.length > 80 ? `${reward.slice(0, 77).trimEnd()}...` : reward;
    children.push(
      el("div", {
        title: reward,
        style: {
          marginTop: "6px", fontSize: "11px", color: C.green,
          padding: "3px 6px", background: C.green + "11", borderRadius: "4px",
          borderLeft: `3px solid ${C.green}`, wordBreak: "break-word",
        },
      }, `Last: ${shortReward}`),
    );
  }

  return card(C, "CONTRACTS", children);
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
    stocks:      fresh(globalThis.gordStockState, UI.staleMs.stocks),
    combat:      getCombatStats(ns),
    // From the daemon's aug snapshot (lib/daemon-lib.js maybeInstall) rather than
    // getOwnedAugmentations here - 5GB the HUD doesn't need to carry.
    augsOwned:   globalThis.gordAugSnapshot?.owned?.length ?? 0,

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
  // Backdoor status comes from lib/backdoor.js's published state, not from
  // ns.getServer (2GB): the helper is what installs them, so it's the authority.
  // Fresh only: after an install the previous run's backdoors would otherwise
  // stay ticked until (and unless) the helper is placed again.
  const bd = fresh(globalThis.gordBackdoorState, UI.staleMs.helper);
  const backdoored = new Set(bd?.done ?? []);
  const backdoors = BACKDOOR_CHECKLIST.map(({ server, label }) => {
    const exists = ns.serverExists(server);
    const rooted = exists && ns.hasRootAccess(server);
    // The world daemon is never backdoored by the bot (that ends the node), so
    // its tick means "ready to finish": rooted, hacking level met.
    const done   = exists && (server === FINAL_HOST ? bd?.finalReady === true : backdoored.has(server));
    return { server, label, exists, rooted, done };
  });

  const programs = ROOTING_PROGRAMS.map(({ name, label }) => ({
    name,
    label,
    owned: ns.fileExists(name, "home"),
  }));

  return { backdoors, programs };
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
  const hackLevelsPerHour = hackTrend.update(current, ns.getResetInfo().lastAugReset);

  const eta = missing <= 0           ? "ready now"
            : hackLevelsPerHour > 0  ? formatDuration((missing / hackLevelsPerHour) * 3_600_000)
            : "-";

  return { required, missing, eta, rate: hackLevelsPerHour };
}

/** @param {NS} ns */
function getGoalEstimate(ns, target) {
  if (!target?.faction) return { rate: 0, eta: "-" };

  // The daemon refreshes target.rep every tick (getAllAugCandidates), which is
  // plenty for an hourly-rate EMA - no getFactionRep (1GB) needed here.
  const currentRep = Number(target.rep ?? 0);
  const factionRepPerHour = repTrend.update(currentRep, target.faction);

  const eta = (target.repMissing ?? 0) <= 0  ? "complete"
            : factionRepPerHour > 0           ? formatDuration((target.repMissing / factionRepPerHour) * 3_600_000)
            : "-";

  return { rate: factionRepPerHour, eta };
}

/** @param {NS} ns */
function updateMoneyTrend(ns) {
  return moneyTrend.update(ns.getPlayer().money, ns.getResetInfo().lastAugReset);
}

/** @param {NS} ns */
function updateRamTrend(ns, totalRam) {
  return ramTrend.update(totalRam, ns.getResetInfo().lastAugReset);
}

/** @param {NS} ns */
function getAugQueueInfo(ns) {
  // Published by the daemon each tick (lib/daemon-lib.js maybeInstall).
  const snap = globalThis.gordAugSnapshot;
  const queued     = snap?.queued ?? 0;
  const hasRedPill = snap?.redPillQueued === true;

  // The node's own threshold (BN7/BN9 batch bigger), published with the snapshot.
  const installAt      = snap?.installAt ?? CONFIG.augs.install.queuedThreshold;
  const urgency        = hasRedPill ? "high" : queued >= installAt ? "medium" : "low";
  const recommendation = hasRedPill         ? "[!!] Install now - Red Pill queued!"
                       : queued >= installAt ? "[!]  Install soon - threshold met"
                       : queued > 0         ? "Keep grinding"
                       : "Nothing queued";

  return { queued, recommendation, urgency };
}

function etaFromRate(remaining, ratePerHour) {
  if (remaining <= 0) return "complete";
  if (!ratePerHour || ratePerHour <= 0) return "-";
  return formatDuration((remaining / ratePerHour) * 3_600_000);
}
