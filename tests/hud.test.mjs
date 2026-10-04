// tests/hud.test.mjs
// The HUD's freshness guard (ui/dashboard-lib.js fresh). Everything the HUD shows
// is read off globalThis, which outlives the script that wrote it - so a card
// without this check shows a dead helper's last state as live.
// Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fresh, COLORS } from "../ui/dashboard-lib.js";
import { extraCards as goCards, playedBonuses } from "../ui/go.js";
import { CONFIG } from "../lib/config.js";

test("fresh: a helper's state counts only while it is recent", () => {
  const now = Date.now();
  const live = { updatedAt: now - 5_000, value: 1 };
  assert.equal(fresh(live, 60_000), live);
  assert.equal(fresh({ updatedAt: now - 120_000 }, 60_000), null);
  assert.equal(fresh(null, 60_000), null);
  assert.equal(fresh(undefined, 60_000), null);
  // State that never stamped itself is treated as stale, not as eternally live.
  assert.equal(fresh({ value: 1 }, 60_000), null);
});

// ── GO tab ───────────────────────────────────────────────────────────────────

/** Every string in a rendered element tree, joined. */
function textOf(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node !== "object") return String(node);
  return (node.children ?? []).map(textOf).join(" ");
}

const NS = { format: { time: ms => `${Math.round(ms / 1000)}s`, number: n => String(n) } };

test("GO tab: nothing without a live helper, the game and its bonuses with one", () => {
  const React = globalThis.React;
  globalThis.React = { createElement: (type, props, ...children) => ({ type, props, children }) };
  try {
    delete globalThis.gordGoState;
    assert.deepEqual(goCards(NS, COLORS), []);

    const state = {
      status: "playing 3,4", opponent: "Tetrads", boardSize: 13,
      games: 4, wins: 3, losses: 1, moves: 17, rejected: 0, errors: 0,
      lastResult: { opponent: "Daedalus", won: true, black: 90.5, white: 60, moves: 80, at: Date.now() - 30_000 },
      bonuses: [
        { opponent: "Netburners", percent: 0, description: "hacknet production", wins: 0, losses: 0, winStreak: 0 },
        { opponent: "Daedalus", percent: 1.25, description: "reputation gain", wins: 1, losses: 0, winStreak: 1 },
        { opponent: "Tetrads", percent: 4.5, description: "strength, defense, dexterity, and agility levels", wins: 2, losses: 1, winStreak: 2 },
      ],
      updatedAt: Date.now(),
    };
    globalThis.gordGoState = state;
    const text = goCards(NS, COLORS).map(textOf).join("\n");
    assert.match(text, /Tetrads/);
    assert.match(text, /3W \/ 1L/);
    assert.match(text, /75%/);
    assert.match(text, /Won vs Daedalus 90.5-60/);
    assert.match(text, /\+4\.50% strength/);
    assert.match(text, /streak 2/);
    assert.doesNotMatch(text, /Netburners/, "an unplayed faction is not listed");
    assert.doesNotMatch(text, /Refused moves/, "the trouble line stays off while both counters are zero");
    // Biggest bonus first.
    assert.deepEqual(playedBonuses(state).map(b => b.opponent), ["Tetrads", "Daedalus"]);

    // A helper that stopped publishing reads as not running, not as a live game.
    globalThis.gordGoState = { ...state, updatedAt: Date.now() - CONFIG.ui.staleMs.helper - 1 };
    assert.deepEqual(goCards(NS, COLORS), []);
  } finally {
    delete globalThis.gordGoState;
    globalThis.React = React;
  }
});

test("every stale threshold is several of the publisher's own ticks", () => {
  const S = CONFIG.ui.staleMs;
  assert.ok(S.contracts >= CONFIG.contracts.tickMs * 2);
  assert.ok(S.stocks >= CONFIG.stocks.noTixSleepMs * 2);
  assert.ok(S.helper >= CONFIG.sleeves.tickMs * 4);
  assert.ok(S.helper >= CONFIG.backdoor.tickMs * 4);
  assert.ok(CONFIG.ui.daemonStaleMs >= CONFIG.daemon.tickMs * 3);
});
