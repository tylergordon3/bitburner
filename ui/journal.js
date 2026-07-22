// ui/journal.js
//
// The "what am I doing and why" narrative, as a MODULE consumed by the GORDNET
// HUD (ui/dashboard.js) - no longer its own tail window. It exposes:
//   updateJournal(ns)   - call every HUD tick; appends narrative lines to the
//                         in-memory ring buffer globalThis.gordJournal when the
//                         bot's INTENTION changes (plus periodic progress ticks).
//   journalPanel(ns, C) - renders that buffer as the HUD's JOURNAL tab.
//
// It only reads globalThis.gordState (+ gordGangBootstrap), which the daemon
// publishes every tick, so it adds no Netscript RAM beyond the base script size.
// To keep the log a NARRATIVE rather than spam, a new line is emitted only when
// the intention changes (tracked by a stable key that ignores volatile figures),
// plus one indented progress line each time a long goal crosses another
// progressStepPct milestone (CONFIG.ui.journal).
//
// Output is ASCII-only: the tail renders a plain text stream that does not decode
// UTF-8, so box-drawing / arrow / check glyphs show up as mojibake. Keep every
// PRINTED / pushed string to ASCII (comments are fine as-is).

import { CONFIG } from "../lib/config.js";
import { el } from "./dashboard-lib.js";

const J = CONFIG.ui.journal;
const STEP = J.progressStepPct || 5;

// Gym stat short-codes (as emitted by lib/player-actions.js) -> full words.
const STAT_NAMES = {
  str: "strength", def: "defense", dex: "dexterity", agi: "agility",
  strength: "strength", defense: "defense", dexterity: "dexterity", agility: "agility",
};

// ── Buffer state (module-level, persists for the life of the HUD process) ─────
let started = false;
let lastKey = null;
let lastProgressAt = 0;
let lastMilestone = -1;   // floor(pct / STEP) last logged for the current intent
let lastPurchases = "";

/** Append an entry {text, kind} to the ring buffer, trimming to bufferSize. */
function push(text, kind) {
  const buf = globalThis.gordJournal ?? (globalThis.gordJournal = []);
  buf.push({ text, kind, at: Date.now() });
  const max = J.bufferSize || 400;
  if (buf.length > max) buf.splice(0, buf.length - max);
}

/**
 * Update the journal buffer for the current tick. Cheap (reads globalThis only).
 * @param {NS} ns
 */
export function updateJournal(ns) {
  if (!started) {
    push(`======== GORDNET journal started ${clock()} ========`, "sys");
    started = true;
  }

  const state = globalThis.gordState;
  if (!state) return;

  // Purchase events fire on the tick an aug is bought; log them as they land.
  const purch = (state.purchases ?? []).join(" | ");
  if (purch && purch !== lastPurchases) {
    for (const p of state.purchases) push(`${clock()}  [+] Bought ${p}`, "buy");
    lastPurchases = purch;
  }

  const { key, text } = narrate(ns, state);
  const now = Date.now();

  if (key !== lastKey) {
    // New intention: announce it, seed the milestone from where we are so we
    // don't immediately re-log the same bucket.
    push(`${clock()}  ${text}`, "head");
    lastKey = key;
    lastProgressAt = now;
    const p0 = progressLine(ns, state);
    lastMilestone = p0 && p0.pct != null ? Math.floor(p0.pct / STEP) : -1;
  } else {
    // Same intention: emit a progress line only when it crosses another STEP%
    // milestone (goals with a %), else fall back to a time interval.
    const p = progressLine(ns, state);
    if (p) {
      const milestone = p.pct != null ? Math.floor(p.pct / STEP) : null;
      const due = milestone != null
        ? milestone > lastMilestone
        : (J.progressMs > 0 && now - lastProgressAt >= J.progressMs);
      if (due) {
        push(`${clock()}     - ${p.line}`, "prog");
        lastProgressAt = now;
        if (milestone != null) lastMilestone = milestone;
      }
    }
  }
}

/**
 * Render the JOURNAL tab: the buffer newest-first (so the current intention is
 * always at the top), scrolling inside a bounded height.
 * @param {NS} ns
 * @param {typeof import("./dashboard-lib.js").COLORS} C
 */
export function journalPanel(ns, C) {
  const buf = globalThis.gordJournal ?? [];
  const lines = buf.slice(-(J.visibleLines || 100)).reverse();

  const colorFor = (k) => k === "buy" ? C.green
                        : k === "prog" ? C.dim
                        : k === "sys" ? C.blue
                        : "#e2e8f0";

  return el("div", {
    style: {
      maxHeight: `${J.panelHeight || 520}px`,
      overflowY: "auto",
      display: "flex",
      flexDirection: "column",
      fontFamily: "'Courier New', monospace",
      fontSize: "12px",
      lineHeight: "1.5",
      padding: "2px",
    },
  },
    ...(lines.length
      ? lines.map((e, i) => el("div", {
          key: i,
          style: { color: colorFor(e.kind), whiteSpace: "pre-wrap", wordBreak: "break-word" },
        }, e.text))
      : [el("div", { style: { color: C.dim } }, "No activity yet - the daemon hasn't published a state.")]),
  );
}

// ── Intention -> sentence ─────────────────────────────────────────────────────

/**
 * Turn the daemon's structured gordState into { key, text }:
 *   - key : a stable identity for this intention that ignores volatile numbers,
 *           so we log once per genuine change of plan (not once per tick).
 *   - text: the human-readable sentence.
 * Prefers the structured `target` fields (faction/aug names, rep progress) for a
 * richer sentence, and falls back to "Action - detail" for anything unmapped.
 * @param {NS} ns
 */
function narrate(ns, state) {
  const a = state.action ?? "Idle";
  const d = state.detail ?? "";
  const t = state.target ?? null;
  const fmt = (n) => ns.format.number(n ?? 0);
  const faction = t?.faction;
  const aug = t?.aug;
  const repPct = t && t.repReq > 0 ? Math.round((t.rep / t.repReq) * 100) : null;

  // One-off events
  if (a === "Gang Created") {
    return { key: "gang-created", text: `Founded a gang with ${d}! Handing day-to-day control to the gang manager.` };
  }
  if (a === "Corp Created") {
    return { key: "corp-created", text: `Founded the corporation ${d}.` };
  }

  // Travel
  if (a.startsWith("Traveling")) {
    const to = state.city ?? d;
    return {
      key: `travel-${state.city}-${state.faction ?? ""}`,
      text: state.faction ? `Traveling to ${to} to reach ${state.faction}.` : `Traveling to ${to}.`,
    };
  }

  // Programs
  if (a === "Studying for Program") {
    return {
      key: `study-prog-${state.prog}`,
      text: `Studying to reach hacking level ${state.reqLevel} so I can write ${state.prog} (currently below it).`,
    };
  }
  if (a === "Creating Program") {
    return { key: `create-${state.prog}`, text: `Writing ${state.prog} myself now that my hacking level is high enough.` };
  }

  // Study
  if (a.startsWith("Studying")) {
    if (/idle/i.test(a)) return { key: "study-idle", text: `Studying Algorithms to grow my hacking level for the next run.` };
    return { key: "study-bootstrap", text: `Studying Algorithms at Rothman University to raise my hacking level (${d}).` };
  }

  // Gym training
  if (a.startsWith("Training")) {
    const stat = STAT_NAMES[state.stat] ?? "combat stats";
    if (/mug chance/i.test(d)) {
      return { key: "train-crime-prep", text: `Training ${stat} at the gym to raise my crime success rate (${d.split("|")[0].trim()}).` };
    }
    const paren = (d.match(/\(([^)]+)\)\s*$/) || [])[1] || "";
    const why = paren.startsWith("for ") ? ` to join ${paren.slice(4)}`
              : paren.startsWith("toward") ? ` toward ${paren.replace(/^toward\s*/, "")}`
              : "";
    const prog = state.needed ? ` (${state.current}/${state.needed})` : "";
    return { key: `train-${state.stat}${why}`, text: `Training ${stat} at Powerhouse Gym${why}${prog}.` };
  }

  // Crime
  if (a.startsWith("Crime")) {
    const crime = (state.crime ?? "crime").toLowerCase();
    const chance = state.chance != null ? ` (${Math.round(state.chance * 100)}% success)` : "";
    if (/gang|karma/i.test(d)) {
      return { key: "crime-karma-gang", text: `Committing ${crime}${chance} to grind karma toward founding a gang.` };
    }
    const reason = d.replace(/^\w+ for /, "").replace(/\s*\(\d+%\)\s*$/, "").trim();
    return { key: `crime-${aug ?? "money"}`, text: `Committing ${crime}${chance} to earn ${reason || "money"}.` };
  }

  // Gang faction rep is passive (comes from respect, not player work)
  if (a === "Gang Rep (passive)") {
    return { key: `gangrep-${faction}-${aug}`, text: `Letting gang respect build ${faction}'s reputation toward ${aug}.` };
  }

  // Faction reputation work
  if (a === "Faction Rep" || a.startsWith("Faction Work")) {
    if (a.includes("secondary")) {
      const sec = d.replace(/^Secondary:\s*/, "").split("|")[0].trim();
      return { key: `secondary-${aug}`, text: `Banking spare reputation (${sec}) while saving for ${aug}.` };
    }
    const banking = a.includes("banking");
    const prog = repPct != null ? ` - ${repPct}% (${fmt(t.rep)}/${fmt(t.repReq)})` : "";
    return {
      key: `rep-${faction}-${aug}`,
      text: `${banking ? "Banking extra reputation" : "Farming reputation"} at ${faction} for ${aug}${prog}.`,
    };
  }
  if (a === "Faction Rep (idle)") {
    const fac = d.split(" (")[0];
    return { key: `idlerep-${fac}`, text: `Banking reputation with ${fac} for future augmentations.` };
  }

  // Buying / saving
  if (a === "Ready to Purchase") {
    return { key: `buy-${faction}-${aug}`, text: `Ready to buy ${aug} from ${faction} - purchasing now.` };
  }
  if (a === "Saving for Faction") {
    return { key: `savefac-${state.faction}`, text: `Working toward joining ${state.faction}: ${d}.` };
  }
  if (a === "Saving for Gang") {
    return { key: "save-gang", text: `Saving money to join a criminal faction and found a gang (${d}).` };
  }
  if (a === "Saving for Aug" || a === "Saving") {
    if (t && aug) return { key: `save-${faction}-${aug}`, text: `Saving $${fmt(t.moneyMissing)} to buy ${aug} from ${faction}.` };
    return { key: "save-generic", text: `Saving money - ${d}.` };
  }

  // Gang bootstrap statuses (pre-gang)
  if (a.startsWith("Gang") || a === "Awaiting Invite") {
    return { key: `gang-${a}`, text: `Gang bootstrap: ${d || a}.` };
  }

  // Fallback
  return { key: `${a}-${d}`, text: `${a}${d ? ` - ${d}` : ""}.` };
}

/**
 * A short progress line for a long-running intention. Returns { line, pct }
 * where pct is 0..100 percent-complete (or null when the goal has no clean %),
 * or null when there's nothing meaningful to show. The caller throttles to one
 * line per STEP% milestone using pct.
 * @param {NS} ns
 */
function progressLine(ns, state) {
  const a = state.action ?? "";
  const t = state.target ?? null;
  const fmt = (n) => ns.format.number(n ?? 0);

  // Karma grind toward the gang gate (BN5) - published by bn5/daemon.js.
  if (/gang|karma/i.test(a) || /gang|karma/i.test(state.detail ?? "")) {
    const b = globalThis.gordGangBootstrap;
    if (b && b.target) {
      const pct = (b.karma / b.target) * 100;
      return { line: `karma ${fmt(b.karma)} / ${fmt(b.target)} (${Math.round(pct)}% to a gang)`, pct };
    }
  }

  if (t && t.repReq > 0 && t.repMissing > 0) {
    const pct = (t.rep / t.repReq) * 100;
    return { line: `${t.faction} rep ${fmt(t.rep)}/${fmt(t.repReq)} (${Math.round(pct)}%) for ${t.aug}`, pct };
  }
  if (t && t.moneyMissing > 0) {
    const pct = t.price > 0 ? ((t.price - t.moneyMissing) / t.price) * 100 : null;
    return { line: `still saving $${fmt(t.moneyMissing)} for ${t.aug}`, pct };
  }
  return null;
}

function clock() {
  return new Date().toLocaleTimeString();
}
