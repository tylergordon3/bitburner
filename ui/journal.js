// ui/journal.js
//
// The "what am I doing and why" narrative, as a MODULE consumed by the GORDNET
// HUD (ui/dashboard.js) - no longer its own tail window. It exposes:
//   updateJournal(ns)   - call every HUD tick; appends narrative lines to the
//                         in-memory ring buffer globalThis.gordJournal when the
//                         bot's INTENTION changes (plus periodic progress ticks).
//   journalPanel(ns, C) - renders that buffer as the HUD's JOURNAL tab.
//
// It only reads globalThis (gordState, gordGangBootstrap, and the gordEvents bus),
// which the daemon + helpers publish, so it adds no Netscript RAM beyond the base
// script size. To keep the log a NARRATIVE rather than spam, an intention line is
// emitted only when the plan changes (tracked by a stable key that ignores volatile
// figures), plus one indented progress line each time a long goal crosses another
// progressStepPct milestone (CONFIG.ui.journal). Interleaved with those are
// discrete MILESTONE lines drained from globalThis.gordEvents - server buys,
// faction joins, grafting travel, contracts solved, sleeves bought, gang recruits
// / ascensions / warfare toggles, and corp divisions / unlocks / investment
// rounds - which any script records via lib/events.js emitEvent().
//
// Gang and corp lines get their own colours ("gang" red, "corp" yellow) so the
// two passive engines read apart from the hacking narrative they interleave with.
//
// Output is ASCII-only: the tail renders a plain text stream that does not decode
// UTF-8, so box-drawing / arrow / check glyphs show up as mojibake. Keep every
// PRINTED / pushed string to ASCII (comments are fine as-is).

import { CONFIG } from "../lib/config.js";
import { el, formatDuration, shortenAugNames } from "./dashboard-lib.js";

const J = CONFIG.ui.journal;
const STEP = J.progressStepPct || 10;

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
let shownResetAt = 0;     // gordLastReset.at we've already reported (report once)

/**
 * Append an entry {text, kind, hl} to the ring buffer, trimming to bufferSize.
 * `hl` is an optional list of exact substrings (augmentation / faction names) the
 * renderer should emphasise; percentages and $ amounts are highlighted
 * automatically regardless.
 *
 * This is the single funnel every journal line passes through, so it's where the
 * display-only aug-name shortening happens ("Cranial Signal Processors - Gen II"
 * -> "Cranial Signal Processors II") - emitters keep the exact in-game names. The
 * hl.augs tokens get the SAME transform, or the renderer's exact-substring
 * highlight matching would stop finding them in the shortened text.
 */
function push(text, kind, hl) {
  const buf = globalThis.gordJournal ?? (globalThis.gordJournal = []);
  const shortHl = hl?.augs?.length ? { ...hl, augs: hl.augs.map(shortenAugNames) } : hl;
  buf.push({ text: shortenAugNames(text), kind, at: Date.now(), hl: shortHl });
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

  // One-time reset summary. The daemon publishes gordLastReset at boot after an
  // aug install (read from disk, since globalThis is wiped by the install). Emit
  // it once, independent of intention changes, so a reset is always announced.
  const reset = globalThis.gordLastReset;
  if (reset && reset.at && reset.at !== shownResetAt) {
    shownResetAt = reset.at;
    push(resetSummaryText(reset), "sys", { augs: reset.augs ?? [], factions: [] });
  }

  // Discrete milestones any script pushed via lib/events.js (server buys, faction
  // joins, grafting travel, contracts solved, sleeves bought). Drained here so they
  // land in the narrative as they happen, independent of intention changes and even
  // before the daemon has published a first gordState.
  const events = globalThis.gordEvents;
  if (events && events.length) {
    for (const e of events.splice(0, events.length)) {
      push(`${clock()}  ${e.text}`, e.kind ?? "event", e.hl);
    }
  }

  const state = globalThis.gordState;
  if (!state) return;

  const hl = collectHl(state);

  // Purchase events fire on the tick an aug is bought; log them as they land.
  const purch = (state.purchases ?? []).join(" | ");
  // Keyed on the tick that made the purchase, not on the text alone: the same
  // aug bought again later (NeuroFlux, every level) is the same string, and was
  // silently dropped.
  const purchKey = `${state.updatedAt ?? ""}|${purch}`;
  if (purch && purchKey !== lastPurchases) {
    for (const p of state.purchases) {
      const [aug, faction] = String(p).split(" from ");
      push(`${clock()}  [+] Bought ${p}`, "buy", {
        augs: [aug].filter(Boolean),
        factions: [faction].filter(Boolean),
      });
    }
    lastPurchases = purchKey;
  }

  const { key, text } = narrate(ns, state);
  const now = Date.now();

  if (key !== lastKey) {
    // New intention: announce it, seed the milestone from where we are so we
    // don't immediately re-log the same bucket.
    push(`${clock()}  ${withRatioPercent(text)}`, "head", hl);
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
        push(`${clock()}     - ${withRatioPercent(p.line)}`, "prog", hl);
        lastProgressAt = now;
        if (milestone != null) lastMilestone = milestone;
      }
    }
  }
}

/** Highlight tokens present in the current intention, split by kind. */
function collectHl(state) {
  const t = state.target ?? null;
  const augs = new Set();
  const factions = new Set();
  if (t?.aug) augs.add(t.aug);
  if (t?.faction) factions.add(t.faction);
  if (state.faction) factions.add(state.faction);
  const gangFac = globalThis.gordGangState?.faction;
  if (gangFac) factions.add(gangFac);
  return { augs: [...augs].filter(Boolean), factions: [...factions].filter(Boolean) };
}

/** The one-line summary for a completed aug install. */
function resetSummaryText(reset) {
  const augs = reset.augs ?? [];
  const n = augs.length;
  const dur = formatDuration(reset.sinceMs ?? 0);
  const names = n ? `: ${augs.join(", ")}` : "";
  return `======== Reset: installed ${n} augmentation${n === 1 ? "" : "s"} after ${dur}${names} ========`;
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
                        : k === "faction" ? C.purple
                        : k === "travel" ? C.blue
                        : k === "prog" ? C.dim
                        : k === "sys" ? C.blue
                        : k === "corp" ? C.yellow
                        : k === "gang" ? C.red
                        : "#e2e8f0";

  return el("div", {
    style: {
      maxHeight: `${J.panelHeight || 520}px`,
      overflowY: "auto",
      overflowX: "auto",              // long lines scroll horizontally, never wrap
      display: "flex",
      flexDirection: "column",
      alignItems: "flex-start",       // size lines to content so the widest sets scroll width
      fontFamily: "'Courier New', monospace",
      fontSize: "13px",
      lineHeight: "1.5",
      padding: "2px",
    },
  },
    ...(lines.length
      ? lines.map((e, i) => el("div", {
          key: i,
          style: { color: colorFor(e.kind), whiteSpace: "pre" },  // no wrapping
        }, ...lineChildren(e.text, e.hl, C)))
      : [el("div", { style: { color: C.dim } }, "No activity yet - the daemon hasn't published a state.")]),
  );
}

// ── Inline highlighting ───────────────────────────────────────────────────────
// Emphasise the parts of a line the player cares about, each in its own colour so
// they read apart: augmentation names (cyan), faction names (light purple), and
// any percentage or $ amount - the "fractions" (yellow). Aug/faction names are
// passed in as exact `hl` tokens ({ augs, factions }) since they can't be
// pattern-matched; numbers are found by regex. Non-highlighted text inherits the
// line's base kind colour from the parent div.

const NUM_PATTERNS = [
  /\d+(?:\.\d+)?%/g,                 // percentages: 96.00%, 4.25%
  /\$\d[\d.,]*[kmbtqKMBTQ]?/g,       // money: $98.953k, $54.655m
];

/**
 * Non-overlapping, ordered highlight ranges for `text`. Exact aug/faction tokens
 * win over the numeric patterns on overlap, and longer matches win at the same
 * start, so "Speech Enhancement" isn't split by a shorter token.
 */
function buildRanges(text, hl) {
  const ranges = [];
  const addTokens = (tokens, cls) => {
    for (const tok of tokens ?? []) {
      if (!tok) continue;
      let idx = 0;
      while ((idx = text.indexOf(tok, idx)) !== -1) {
        ranges.push({ start: idx, end: idx + tok.length, cls });
        idx += tok.length;
      }
    }
  };
  addTokens(hl?.augs, "aug");
  addTokens(hl?.factions, "faction");
  // matchAll, not RegExp.exec: Bitburner's RAM analyzer bills identifiers by
  // name, so a `.exec(` on a RegExp is charged as ns.exec (1.3GB).
  for (const re of NUM_PATTERNS) {
    for (const m of text.matchAll(re)) {
      ranges.push({ start: m.index, end: m.index + m[0].length, cls: "num" });
    }
  }
  // Order by start; on ties prefer the longer span, then names over numbers.
  const nameRank = (cls) => (cls === "num" ? 1 : 0);
  ranges.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start)
                       || nameRank(a.cls) - nameRank(b.cls));
  const out = [];
  let lastEnd = 0;
  for (const r of ranges) {
    if (r.start < lastEnd) continue; // drop overlap
    out.push(r);
    lastEnd = r.end;
  }
  return out;
}

/** Split `text` into styled span children for the JOURNAL tab. */
function lineChildren(text, hl, C) {
  const ranges = buildRanges(text, hl);
  if (!ranges.length) return [text];

  const styleFor = (cls) => cls === "aug"     ? { color: C.augHl, fontWeight: "bold" }
                          : cls === "faction" ? { color: C.factionHl, fontWeight: "bold" }
                          : { color: C.numHl };

  const out = [];
  let pos = 0;
  let k = 0;
  for (const r of ranges) {
    if (r.start > pos) out.push(el("span", { key: k++ }, text.slice(pos, r.start)));
    out.push(el("span", { key: k++, style: styleFor(r.cls) }, text.slice(r.start, r.end)));
    pos = r.end;
  }
  if (pos < text.length) out.push(el("span", { key: k++ }, text.slice(pos)));
  return out;
}

// ── Fraction -> percent ───────────────────────────────────────────────────────
// The daemon publishes some progress as a bare "$have / $need" ratio (e.g. the
// early crime-for-TOR goal). Prepend the computed percentage so every progress
// line leads with a percent and keeps the ratio in parentheses, e.g.
// "... ($98.953k / $500.000k)" -> "... 19.79% ($98.953k / $500.000k)".

const MONEY_SUFFIX = { k: 1e3, m: 1e6, b: 1e9, t: 1e12, q: 1e15 };

/** Parse a formatted money string like "$98.953k" into a number. */
function parseMoney(s) {
  const mm = String(s).match(/([\d,]*\.?\d+)\s*([kmbtq]?)/i);
  if (!mm) return NaN;
  const n = Number(mm[1].replace(/,/g, ""));
  return n * (MONEY_SUFFIX[mm[2].toLowerCase()] ?? 1);
}

/** Prepend "P.PP% " before a "($A / $B)" money ratio, unless one is already there. */
function withRatioPercent(text) {
  const re = /\((\$[\d.,]+\s*[kmbtqKMBTQ]?)\s*\/\s*(\$[\d.,]+\s*[kmbtqKMBTQ]?)\)/;
  const m = text.match(re);
  if (!m) return text;
  const before = text.slice(0, m.index);
  if (/\d(?:\.\d+)?%\s*$/.test(before)) return text; // a percent already leads it
  const a = parseMoney(m[1]);
  const b = parseMoney(m[2]);
  if (!(b > 0)) return text;
  const pct = (a / b) * 100;
  return `${before}${pct.toFixed(2)}% ${m[0]}${text.slice(m.index + m[0].length)}`;
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
  const repPct = t && t.repReq > 0 ? (t.rep / t.repReq) * 100 : null;

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
    // The success chance is only worth words while it's imperfect - "(100.00%
    // success)" after every homicide is noise. Omitted whenever it would FORMAT
    // as 100.00, so 99.996 doesn't sneak through as a printed "100.00%".
    const pctText = state.chance != null ? (state.chance * 100).toFixed(2) : null;
    const chance = pctText != null && pctText !== "100.00" ? ` (${pctText}% success)` : "";
    if (/gang|karma/i.test(d)) {
      return { key: "crime-karma-gang", text: `Committing ${crime}${chance} to grind karma toward founding a gang.` };
    }
    // Strip the detail's own trailing "(100%, 1.23x Mug)" qualifier - the chance
    // is already handled above (or deliberately omitted), so keeping the paren
    // duplicated the percentage on every crime line.
    const reason = d.replace(/^\w+ for /, "").replace(/\s*\(\d[^)]*\)\s*$/, "").trim();
    return { key: `crime-${aug ?? "money"}`, text: `Committing ${crime}${chance} to earn ${reason || "money"}.` };
  }

  // Bladeburner (bn6/daemon.js). Keyed by PHASE, not by contract or rest cycle:
  // the loop switches contracts and lends its rest phases to faction work every
  // few minutes, and one journal line per switch would bury everything else.
  if (a === "Bladeburner" || a === "Faction Work (blade resting)") {
    const phase = state.bladePhase ?? "ops";
    const b = globalThis.gordBladeState;
    const rank = b ? ` (rank ${fmt(b.rank)})` : "";
    if (phase === "join") return { key: "blade-join", text: `Joined the Bladeburner division.` };
    if (phase.startsWith("blackop-")) {
      return { key: `blade-${phase}`, text: `Attempting the black op ${phase.slice(8)}${rank}.` };
    }
    if (phase.startsWith("general-")) {
      return { key: `blade-${phase}`, text: `Bladeburner: ${phase.slice(8)} - ${b?.want?.reason ?? d}.` };
    }
    return { key: "blade-ops", text: `Running Bladeburner contracts and operations for rank${rank}, lending rest phases to faction work.` };
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
    const prog = repPct != null ? ` - ${repPct.toFixed(2)}% (${fmt(t.rep)}/${fmt(t.repReq)})` : "";
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
      return { line: `${pct.toFixed(2)}% to a gang (karma ${fmt(b.karma)} / ${fmt(b.target)})`, pct };
    }
  }

  if (t && t.repReq > 0 && t.repMissing > 0) {
    const pct = (t.rep / t.repReq) * 100;
    return { line: `${t.faction} rep ${pct.toFixed(2)}% (${fmt(t.rep)}/${fmt(t.repReq)}) for ${t.aug}`, pct };
  }
  if (t && t.moneyMissing > 0) {
    const price = t.price ?? 0;
    const have = Math.max(0, price - t.moneyMissing);
    const pct = price > 0 ? (have / price) * 100 : null;
    // The percent is added uniformly by withRatioPercent from the "($have/$price)"
    // ratio; here we just supply the ratio (and pct for milestone bucketing).
    const line = price > 0
      ? `saving ($${fmt(have)} / $${fmt(price)}) for ${t.aug}`
      : `still saving $${fmt(t.moneyMissing)} for ${t.aug}`;
    return { line, pct };
  }
  return null;
}

function clock() {
  return new Date().toLocaleTimeString();
}
