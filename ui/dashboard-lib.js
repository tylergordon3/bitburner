// ui/dashboard-lib.js
//
// Shared rendering primitives for the dashboard. ui/dashboard.js (the core
// template) and the per-BitNode extras modules (ui/bn2.js, etc.) all build
// their cards from these, so the whole dashboard shares one look and one
// palette. Nothing here touches Singularity or costs RAM beyond the base
// script size - these are pure React element builders.

// ── Palette ────────────────────────────────────────────────────────────────
export const COLORS = {
  green:   "#4ade80",
  yellow:  "#facc15",
  red:     "#f87171",
  blue:    "#60a5fa",
  purple:  "#c084fc",
  dim:     "rgba(255,255,255,0.45)",
  border:  "rgba(255,255,255,0.10)",
  cardBg:  "rgba(255,255,255,0.03)",
};

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
