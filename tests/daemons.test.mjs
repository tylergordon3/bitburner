// tests/daemons.test.mjs
// A smoke test, not a unit test: every script the game will be asked to run must
// at least LOAD. The unit tests import the pure logic modules, which leaves the
// Netscript shells - the daemons, the driver, the HUD, the tools - unparsed
// until the game runs them, and a syntax error there means a BitNode entered
// with a daemon that cannot start. Importing a module evaluates its imports and
// its top level only; nothing here calls main().
// Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { BITNODE, CONFIG, forNode } from "../lib/config.js";

const ROOT = new URL("../", import.meta.url);
const scriptsIn = dir => readdirSync(new URL(`${dir}/`, ROOT)).filter(f => f.endsWith(".js")).map(f => `${dir}/${f}`);

test("every BitNode entry names a daemon that exists and loads", async () => {
  for (const node of Object.keys(BITNODE).map(Number)) {
    const cfg = forNode(node);
    assert.ok(cfg.name, `BN${node} has no name`);
    const daemon = cfg.paths.daemon;
    assert.ok(daemon, `BN${node} has no daemon path`);
    assert.ok(existsSync(new URL(`.${daemon}`, ROOT)), `BN${node}: ${daemon} does not exist`);
    const mod = await import(new URL(`.${daemon}`, ROOT).href);
    assert.equal(typeof mod.main, "function", `${daemon} exports no main`);
  }
});

test("every bnN folder is registered, so the driver boots the daemon it was written for", () => {
  const folders = readdirSync(ROOT).filter(d => /^bn\d+$/.test(d)).map(d => Number(d.slice(2)));
  for (const node of folders) {
    assert.equal(forNode(node).paths.daemon, `/bn${node}/daemon.js`, `bn${node}/ is not in BITNODE`);
  }
});

test("every script path in CONFIG.paths exists and loads", async () => {
  for (const [key, path] of Object.entries(CONFIG.paths)) {
    if (typeof path !== "string" || !path.endsWith(".js")) continue;
    // A legacy entry point the driver only kills, never runs.
    if (key === "legacyStartup") continue;
    assert.ok(existsSync(new URL(`.${path}`, ROOT)), `paths.${key}: ${path} does not exist`);
    const mod = await import(new URL(`.${path}`, ROOT).href);
    assert.equal(typeof mod.main, "function", `${path} exports no main`);
  }
});

test("the remaining scripts load too: lib, the HUD, the tools, the cold-start scripts", async () => {
  for (const dir of ["lib", "ui", "tools", "early", "hacking"]) {
    for (const file of scriptsIn(dir)) {
      await import(new URL(file, ROOT).href);
    }
  }
});
