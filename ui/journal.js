// ui/journal.js
//
// A dedicated, plain-text "console log" that auto-opens its own tail window and
// narrates what the bot is CURRENTLY TRYING TO DO, in English - e.g.
//   14:02:11  Farming reputation at Daedalus for The Red Pill — 43% (1.1m/2.5m).
//   14:03:44    ↳ Daedalus rep 1.3m/2.5m (52%) for The Red Pill
//   14:20:05  Committing homicide (91% success) to grind karma toward a gang.
// instead of the daemon's terse per-tick "Money / Hack / Karma" line.
//
// It's a read-only view: it only reads globalThis.gordState (+ gordGangBootstrap),
// which the daemon publishes every tick, so it adds no Netscript RAM beyond the
// script base and never touches game state. To keep the log a NARRATIVE rather
// than spam, it prints a new line only when the *intention* changes (tracked by a
// stable key that ignores volatile figures), plus an occasional indented progress
// tick for long-running goals (rep / savings / karma).
//
// Launched off-home by each bnX/daemon.js via ensureHelper(CFG.paths.journal).

import { CONFIG } from "../lib/config.js";

const J = CONFIG.ui.journal;

// Gym stat short-codes (as emitted by lib/player-actions.js) -> full words.
const STAT_NAMES = {
  str: "strength", def: "defense", dex: "dexterity", agi: "agility",
  strength: "strength", defense: "defense", dexterity: "dexterity", agility: "agility",
};

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.ui.openTail();
  ns.ui.setTailTitle("GORDNET — Journal");
  ns.ui.moveTail(J.x, J.y);
  ns.ui.resizeTail(J.width, J.height);
  if (J.fontSize) ns.ui.setTailFontSize(J.fontSize);

  let lastKey = null;
  let lastProgressAt = 0;
  let lastPurchases = "";

  ns.print(`──────── GORDNET journal started ${clock()} ────────`);

  while (true) {
    const state = globalThis.gordState;
    if (state) {
      // Purchase events fire on the tick an aug is bought; log them as they land.
      const purch = (state.purchases ?? []).join(" | ");
      if (purch && purch !== lastPurchases) {
        for (const p of state.purchases) ns.print(`${clock()}  ✔ Bought ${p}`);
        lastPurchases = purch;
      }

      const { key, text } = narrate(ns, state);
      const now = Date.now();

      if (key !== lastKey) {
        ns.print(`${clock()}  ${text}`);
        lastKey = key;
        lastProgressAt = now;
      } else if (J.progressMs > 0 && now - lastProgressAt >= J.progressMs) {
        const prog = progressLine(ns, state);
        if (prog) {
          ns.print(`${clock()}    ↳ ${prog}`);
          lastProgressAt = now;
        }
      }
    }

    await ns.sleep(J.refreshMs);
  }
}

// ── Intention → sentence ──────────────────────────────────────────────────────

/**
 * Turn the daemon's structured gordState into { key, text }:
 *   - key : a stable identity for this intention that ignores volatile numbers,
 *           so we log once per genuine change of plan (not once per tick).
 *   - text: the human-readable sentence to print.
 * Prefers the structured `target` fields (faction/aug names, rep progress) for a
 * richer sentence, and falls back to "Action — detail" for anything unmapped.
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

  // ── One-off events ─────────────────────────────────────────────────────────
  if (a === "Gang Created") {
    return { key: "gang-created", text: `Founded a gang with ${d}! Handing day-to-day control to the gang manager.` };
  }
  if (a === "Corp Created") {
    return { key: "corp-created", text: `Founded the corporation ${d}.` };
  }

  // ── Travel ─────────────────────────────────────────────────────────────────
  if (a.startsWith("Traveling")) {
    const to = state.city ?? d;
    return {
      key: `travel-${state.city}-${state.faction ?? ""}`,
      text: state.faction ? `Traveling to ${to} to reach ${state.faction}.` : `Traveling to ${to}.`,
    };
  }

  // ── Programs ───────────────────────────────────────────────────────────────
  if (a === "Studying for Program") {
    return {
      key: `study-prog-${state.prog}`,
      text: `Studying to reach hacking level ${state.reqLevel} so I can write ${state.prog} (currently below it).`,
    };
  }
  if (a === "Creating Program") {
    return { key: `create-${state.prog}`, text: `Writing ${state.prog} myself now that my hacking level is high enough.` };
  }

  // ── Study ──────────────────────────────────────────────────────────────────
  if (a.startsWith("Studying")) {
    if (/idle/i.test(a)) return { key: "study-idle", text: `Studying Algorithms to grow my hacking level for the next run.` };
    return { key: "study-bootstrap", text: `Studying Algorithms at Rothman University to raise my hacking level (${d}).` };
  }

  // ── Gym training ───────────────────────────────────────────────────────────
  if (a.startsWith("Training")) {
    const stat = STAT_NAMES[state.stat] ?? "combat stats";
    // Early-bootstrap training is about raising crime success rate.
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

  // ── Crime ──────────────────────────────────────────────────────────────────
  if (a.startsWith("Crime")) {
    const crime = (state.crime ?? "crime").toLowerCase();
    const chance = state.chance != null ? ` (${Math.round(state.chance * 100)}% success)` : "";
    if (/gang|karma/i.test(d)) {
      return { key: "crime-karma-gang", text: `Committing ${crime}${chance} to grind karma toward founding a gang.` };
    }
    const reason = d.replace(/^\w+ for /, "").replace(/\s*\(\d+%\)\s*$/, "").trim();
    return { key: `crime-${aug ?? "money"}`, text: `Committing ${crime}${chance} to earn ${reason || "money"}.` };
  }

  // ── Gang faction rep is passive (comes from respect, not player work) ───────
  if (a === "Gang Rep (passive)") {
    return { key: `gangrep-${faction}-${aug}`, text: `Letting gang respect build ${faction}'s reputation toward ${aug}.` };
  }

  // ── Faction reputation work ────────────────────────────────────────────────
  if (a === "Faction Rep" || a.startsWith("Faction Work")) {
    if (a.includes("secondary")) {
      const sec = d.replace(/^Secondary:\s*/, "").split("|")[0].trim();
      return { key: `secondary-${aug}`, text: `Banking spare reputation (${sec}) while saving for ${aug}.` };
    }
    const banking = a.includes("banking");
    const prog = repPct != null ? ` — ${repPct}% (${fmt(t.rep)}/${fmt(t.repReq)})` : "";
    return {
      key: `rep-${faction}-${aug}`,
      text: `${banking ? "Banking extra reputation" : "Farming reputation"} at ${faction} for ${aug}${prog}.`,
    };
  }
  if (a === "Faction Rep (idle)") {
    const fac = d.split(" (")[0];
    return { key: `idlerep-${fac}`, text: `Banking reputation with ${fac} for future augmentations.` };
  }

  // ── Buying / saving ────────────────────────────────────────────────────────
  if (a === "Ready to Purchase") {
    return { key: `buy-${faction}-${aug}`, text: `Ready to buy ${aug} from ${faction} — purchasing now.` };
  }
  if (a === "Saving for Faction") {
    return { key: `savefac-${state.faction}`, text: `Working toward joining ${state.faction}: ${d}.` };
  }
  if (a === "Saving for Gang") {
    return { key: "save-gang", text: `Saving money to join a criminal faction and found a gang (${d}).` };
  }
  if (a === "Saving for Aug" || a === "Saving") {
    if (t && aug) return { key: `save-${faction}-${aug}`, text: `Saving $${fmt(t.moneyMissing)} to buy ${aug} from ${faction}.` };
    return { key: "save-generic", text: `Saving money — ${d}.` };
  }

  // ── Gang bootstrap statuses (pre-gang) ─────────────────────────────────────
  if (a.startsWith("Gang") || a === "Awaiting Invite") {
    return { key: `gang-${a}`, text: `Gang bootstrap: ${d || a}.` };
  }

  // ── Fallback ───────────────────────────────────────────────────────────────
  return { key: `${a}-${d}`, text: `${a}${d ? ` — ${d}` : ""}.` };
}

/**
 * A short indented progress line for a long-running intention, so the log shows
 * movement without re-announcing the whole plan. Returns null when there's no
 * meaningful progress figure to show.
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
      const pct = Math.round((b.karma / b.target) * 100);
      return `karma ${fmt(b.karma)} / ${fmt(b.target)} (${pct}% to a gang)`;
    }
  }

  if (t && t.repReq > 0 && t.repMissing > 0) {
    const pct = Math.round((t.rep / t.repReq) * 100);
    return `${t.faction} rep ${fmt(t.rep)}/${fmt(t.repReq)} (${pct}%) for ${t.aug}`;
  }
  if (t && t.moneyMissing > 0) {
    return `still saving $${fmt(t.moneyMissing)} for ${t.aug}`;
  }
  return null;
}

function clock() {
  return new Date().toLocaleTimeString();
}
