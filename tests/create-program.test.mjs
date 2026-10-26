// tests/create-program.test.mjs
// A port opener the money can't reach is written by hand once the hacking
// level is there (lib/player-actions.js createMissingProgram). BN8.1 studied
// Algorithms at hacking 17,000 for a 3,000 world-daemon gate with no
// SQLInject.exe - the treasury never let $250m through.
// Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMissingProgram } from "../lib/player-actions.js";
import { CONFIG } from "../lib/config.js";

const OPENERS = CONFIG.programs.portOpeners;

/** A fake ns with these programs on home, recording createProgram calls. */
function fakeNs({ hacking, owned = OPENERS, work = null }) {
  const g = { created: /** @type {string[]} */ ([]) };
  const ns = /** @type {any} */ ({
    read: () => "",
    getPlayer: () => ({ skills: { hacking } }),
    fileExists: (f, host) => host === "home" && owned.includes(f),
    singularity: {
      getCurrentWork: () => work,
      createProgram: prog => { g.created.push(prog); return true; },
      getOwnedAugmentations: () => [],
      setFocus: () => true,
    },
  });
  return { ns, g };
}

test("every port opener has a createProgram level", () => {
  for (const p of OPENERS) assert.ok(CONFIG.programs.createLevel[p] > 0, p);
});

test("all five owned: nothing to write", () => {
  const { ns, g } = fakeNs({ hacking: 17_000 });
  assert.equal(createMissingProgram(ns), null);
  assert.deepEqual(g.created, []);
});

test("BN8.1: hacking 17,000, no SQLInject - write it instead of studying", () => {
  const { ns, g } = fakeNs({ hacking: 17_000, owned: OPENERS.filter(p => p !== "SQLInject.exe") });
  assert.equal(createMissingProgram(ns)?.action, "Creating Program");
  assert.deepEqual(g.created, ["SQLInject.exe"]);
});

test("below a program's level: left for the darkweb, never studied towards", () => {
  const { ns, g } = fakeNs({ hacking: 600, owned: OPENERS.filter(p => p !== "SQLInject.exe") });
  assert.equal(createMissingProgram(ns), null);
  assert.deepEqual(g.created, []);
});

test("the cheapest reachable opener first", () => {
  const { ns, g } = fakeNs({ hacking: 800, owned: ["BruteSSH.exe", "FTPCrack.exe"] });
  createMissingProgram(ns);
  assert.deepEqual(g.created, ["relaySMTP.exe"]);
});

test("a program already being written is not restarted", () => {
  const { ns, g } = fakeNs({
    hacking: 17_000,
    owned: ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe"],
    work: { type: "CREATE_PROGRAM", programName: "SQLInject.exe" },
  });
  assert.match(createMissingProgram(ns)?.detail ?? "", /SQLInject/);
  assert.deepEqual(g.created, [], "HTTPWorm waits rather than cancel SQLInject's progress");
});
