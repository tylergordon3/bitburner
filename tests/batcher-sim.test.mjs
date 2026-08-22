// tests/batcher-sim.test.mjs
//
// End-to-end simulation of hacking/manager.js's scheduler on the ns.* fallback
// path (no Formulas.exe). See tests/helpers/fake-botnet.mjs for the model world
// and the scenarios; tests/batcher-sim-formulas.test.mjs runs the same
// scenarios on the Formulas path that actually runs in-game.
//
// Run: npm test  (needs Node >=20).

import { test } from "node:test";
import assert from "node:assert/strict";
import { defineScenarios } from "./helpers/fake-botnet.mjs";

defineScenarios(test, assert, { formulas: false });
