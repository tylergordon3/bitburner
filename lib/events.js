// lib/events.js
//
// Tiny cross-script event bus for the JOURNAL. Any script - the daemon on home or
// an off-home helper - calls emitEvent(...) to record a discrete MILESTONE (a
// server bought, a faction joined, a city move, a contract solved, a sleeve
// purchased) onto the shared globalThis.gordEvents ring buffer. ui/journal.js
// drains that buffer every HUD tick and renders each line as it happened, separate
// from the intention-change narration it already does.
//
// globalThis is shared across every script and host in Bitburner, so a helper on
// any server can emit and the dashboard (wherever it runs) shows it. This module
// imports nothing and touches only globalThis, so it costs 0GB - safe to import
// anywhere, exactly like lib/config.js.
//
// The JOURNAL tail renders a plain text stream that does NOT decode UTF-8, so keep
// every emitted `text` ASCII-only (use markers like "[+]" / "[join]" / "[travel]",
// not arrows or check glyphs).

const MAX_EVENTS = 100;

/**
 * Record a discrete journal event.
 * @param {string} text   ASCII line to show (the journal prepends a timestamp).
 * @param {string} [kind] colour/category the journal maps to a colour:
 *                        "buy" (green) | "faction" (purple) | "travel" (blue) |
 *                        "sys" (blue) | "event" (default). Defaults to "event".
 * @param {{augs?: string[], factions?: string[]}} [hl] exact names to emphasise
 *                        inline (aug = cyan, faction = purple); numbers/$ are
 *                        auto-highlighted regardless.
 */
export function emitEvent(text, kind = "event", hl) {
  const buf = globalThis.gordEvents ?? (globalThis.gordEvents = []);
  buf.push({ text, kind, hl, at: Date.now() });
  // Cap the buffer so it can't grow unbounded if the journal isn't draining it
  // (e.g. the dashboard is closed) - keep only the most recent events.
  if (buf.length > MAX_EVENTS) buf.splice(0, buf.length - MAX_EVENTS);
}
