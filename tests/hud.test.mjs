// tests/hud.test.mjs
// The HUD's freshness guard (ui/dashboard-lib.js fresh). Everything the HUD shows
// is read off globalThis, which outlives the script that wrote it - so a card
// without this check shows a dead helper's last state as live.
// Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fresh } from "../ui/dashboard-lib.js";
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

test("every stale threshold is several of the publisher's own ticks", () => {
  const S = CONFIG.ui.staleMs;
  assert.ok(S.contracts >= CONFIG.contracts.tickMs * 2);
  assert.ok(S.stocks >= CONFIG.stocks.noTixSleepMs * 2);
  assert.ok(S.helper >= CONFIG.sleeves.tickMs * 4);
  assert.ok(S.helper >= CONFIG.backdoor.tickMs * 4);
  assert.ok(CONFIG.ui.daemonStaleMs >= CONFIG.daemon.tickMs * 3);
});
