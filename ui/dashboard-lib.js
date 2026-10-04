// ui/dashboard-lib.js
//
// Shared rendering primitives for the dashboard. ui/dashboard.js (the core
// template) and the per-BitNode extras modules (ui/bn2.js, etc.) all build
// their cards from these, so the whole dashboard shares one look and one
// palette. Nothing here touches Singularity or costs RAM beyond the base
// script size - these are pure React element builders.

import { CONFIG } from "../lib/config.js";

// ── Palette ────────────────────────────────────────────────────────────────
// Defined in CONFIG.ui.colors; re-exported here so every card builder can keep
// taking a `C` palette argument.
export const COLORS = CONFIG.ui.colors;

// ── UI primitives ────────────────────────────────────────────────────────────

export function el(type, props = {}, ...children) {
  const React = globalThis.React;
  if (!React?.createElement) throw new Error("React not available");
  return React.createElement(type, props, ...children);
}

export function card(C, title, children) {
  return el("div", {
    style: {
      border: `1px solid ${C.border}`,
      borderRadius: "6px",
      padding: "7px 10px",
      marginBottom: "5px",
      background: C.cardBg,
    },
  },
    el("div", {
      style: {
        fontWeight: "bold",
        fontSize: "13px",
        letterSpacing: "1px",
        color: C.dim,
        marginBottom: "7px",
        textTransform: "uppercase",
      },
    }, title),
    ...children,
  );
}

/**
 * A helper's published state, or null once it is older than `maxAgeMs`.
 *
 * Everything on the HUD is read off globalThis, and globalThis outlives the
 * script that wrote it - through a crash, a kill, an aug install, even a change
 * of BitNode. A card that reads its state unguarded therefore keeps showing a
 * dead helper's last words as if they were live. Every helper stamps
 * `updatedAt`; this is the one check for it.
 * @template T
 * @param {T} state @param {number} maxAgeMs
 * @returns {T | null}
 */
export function fresh(state, maxAgeMs) {
  if (!state) return null;
  const at = /** @type {any} */ (state).updatedAt ?? 0;
  return Date.now() - at <= maxAgeMs ? state : null;
}

export function label(C, text) {
  return el("div", {
    style: { fontSize: "12px", color: C.dim, marginBottom: "3px", letterSpacing: "0.5px" },
  }, text);
}

export function progressBar(pct, color) {
  const filled = Math.round(Math.max(0, Math.min(1, pct)) * 20);
  const empty  = 20 - filled;
  return el("div", {
    style: {
      height: "6px",
      borderRadius: "2px",
      background: "rgba(255,255,255,0.08)",
      marginBottom: "3px",
      overflow: "hidden",
    },
  },
    el("div", {
      style: {
        width: `${Math.round(pct * 100)}%`,
        height: "100%",
        background: color,
        borderRadius: "2px",
        transition: "width 0.3s",
      },
    }),
  );
}

export function statRow(C, icon, primary, secondary, color) {
  return el("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "baseline",
      marginBottom: "4px",
    },
  },
    el("span", { style: { color: C.dim, fontSize: "13px" } }, `${icon} ${primary}`),
    el("span", { style: { color, fontSize: "13px", fontWeight: "bold" } }, secondary),
  );
}

export function stat(C, label_, value, color) {
  return el("div", { style: { fontSize: "13px" } },
    el("span", { style: { color: C.dim } }, `${label_} `),
    el("span", { style: { fontWeight: "bold", color } }, String(value)),
  );
}

// ── Formatting ────────────────────────────────────────────────────────────────

// Display shortenings for the game's most long-winded augmentation names, so
// journal lines and the AUGS pipeline column stay readable. DISPLAY-ONLY: every
// API call and config entry keeps the exact in-game name - these are applied at
// render time (ui/journal.js push, ui/dashboard.js pipeline), never at emit time.
//
// Ordered longest-first WITHIN each family so a base name ("Embedded Netburner
// Module") can't pre-empt its longer variants ("... Core V2 Upgrade") - the
// replacement walks this list top to bottom.
const AUG_SHORT_NAMES = [
  ["Embedded Netburner Module Direct Memory Access Upgrade", "ENM DMA"],
  ["Embedded Netburner Module Core V3 Upgrade", "ENM Core V3"],
  ["Embedded Netburner Module Core V2 Upgrade", "ENM Core V2"],
  ["Embedded Netburner Module Core Implant", "ENM Core"],
  ["Embedded Netburner Module Analyze Engine", "ENM Analyze Engine"],
  ["Embedded Netburner Module", "ENM"],
  ["Hacknet Node CPU Architecture Neural-Upload", "Hacknet CPU Upload"],
  ["Hacknet Node Cache Architecture Neural-Upload", "Hacknet Cache Upload"],
  ["Hacknet Node NIC Architecture Neural-Upload", "Hacknet NIC Upload"],
  ["Hacknet Node Kernel Direct-Access Upload", "Hacknet Kernel Upload"],
  ["Hacknet Node Core Direct-Access Upload", "Hacknet Core Upload"],
  ["PC Direct-Neural Interface Optimization Submodule", "PCDNI Optimization"],
  ["PC Direct-Neural Interface NeuroNet Injector", "PCDNI NeuroNet"],
  ["PC Direct-Neural Interface", "PCDNI"],
  ["Artificial Bio-neural Network Implant", "Bio-neural Network"],
  ["Nuoptimal Nootropic Injector Implant", "Nuoptimal Injector"],
  ["Neuroreceptor Management Implant", "Neuroreceptor Mgmt"],
  ["Enhanced Social Interaction Implant", "Social Interaction Implant"],
  ["NeuroFlux Governor", "NeuroFlux"],
];

/**
 * Shorten known aug names anywhere in `text` (works on a bare name or a whole
 * composed line), plus the generic "X - Gen II" -> "X II" rule that covers the
 * Cranial Signal Processors family. Pure string work - safe on any journal line.
 */
export function shortenAugNames(text) {
  let out = String(text);
  for (const [long, short] of AUG_SHORT_NAMES) {
    if (out.includes(long)) out = out.split(long).join(short);
  }
  // " - Gen II" -> " II", only when a roman numeral follows, so ordinary " - "
  // separators in narration lines are never touched.
  return out.replace(/ - Gen (?=[IVXL]+\b)/g, " ");
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hr  = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  if (day > 0) return `${day}d ${hr % 24}h`;
  if (hr  > 0) return `${hr}h ${min % 60}m`;
  if (min > 0) return `${min}m ${sec % 60}s`;
  return `${sec}s`;
}
