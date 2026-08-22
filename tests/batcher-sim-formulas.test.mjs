// tests/batcher-sim-formulas.test.mjs
//
// The batcher simulation on the Formulas.exe path - lib/formulas.js's exact
// prepped-state math over ns.formulas.mockServer(), which is what runs in-game
// (SF-5 grants the exe). Its own file on purpose: lib/formulas.js caches
// "Formulas.exe is present" for the life of the process, and `node --test`
// runs each file in its own process.
//
// Run: npm test  (needs Node >=20).

import { test } from "node:test";
import assert from "node:assert/strict";
import { defineScenarios } from "./helpers/fake-botnet.mjs";

defineScenarios(test, assert, { formulas: true });
