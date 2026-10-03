// tests/config-captures.test.mjs
// A lint, not a unit test. BITNODE[n] overrides only reach code that resolves
// its config with forNode(n). A module that captures `const X = CONFIG.section`
// at module scope and then reads a key some BITNODE entry overrides will run on
// the DEFAULT forever, silently - which is how BN7's skill weights and BN7/BN9's
// install thresholds sat dead in lib/config.js while the comments said otherwise.
//
// So: for every module-scope `const NAME = CONFIG.<section>` (a `let` is assumed
// to be re-pointed with forNode in main(), which is the fix), no `NAME.<key>`
// read in that file may be a key that any BITNODE entry overrides in that section.
// Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { BITNODE } from "../lib/config.js";

const ROOT = new URL("../", import.meta.url);
const DIRS = ["lib", "hacking", "early", "ui", "tools", "bn2", "bn3", "bn4", "bn5", "bn6", "bn7", "bn9", "bn10"];

/** section -> the set of top-level keys overridden in it by any BITNODE entry. */
const overridden = new Map();
for (const entry of Object.values(BITNODE)) {
  for (const [section, value] of Object.entries(entry)) {
    if (typeof value !== "object" || value === null) continue;
    if (!overridden.has(section)) overridden.set(section, new Set());
    for (const key of Object.keys(value)) overridden.get(section).add(key);
  }
}

// Reads that are correct as they stand, with the reason.
const ALLOWED = new Set([
  // tools/* and the driver resolve the node's daemon through forNode themselves;
  // P.daemon is never read off the capture.
]);

test("no module-scope CONFIG capture reads a key that a BITNODE entry overrides", () => {
  const problems = [];
  for (const dir of DIRS) {
    for (const file of readdirSync(new URL(`${dir}/`, ROOT)).filter(f => f.endsWith(".js"))) {
      const path = `${dir}/${file}`;
      const src = readFileSync(new URL(path, ROOT), "utf8");
      const captures = [...src.matchAll(/^const (\w+) = (?:\/\*\*.*?\*\/ \()?CONFIG\.(\w+)\)?;/gm)];
      for (const [, name, section] of captures) {
        const keys = overridden.get(section);
        if (!keys) continue;
        for (const key of keys) {
          if (new RegExp(`\\b${name}\\.${key}\\b`).test(src) && !ALLOWED.has(`${path}:${name}.${key}`)) {
            problems.push(`${path}: ${name}.${key} reads CONFIG.${section}.${key}, which a BITNODE entry overrides - resolve it with forNode()`);
          }
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("the lint sees the overrides it exists for", () => {
  assert.ok(overridden.get("augs").has("install"));
  assert.ok(overridden.get("bladeburner").has("skills"));
  assert.ok(overridden.get("backdoor").has("skipFinalHost"));
});
