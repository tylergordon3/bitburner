// tests/sf-bonuses.test.mjs
// The Source-File bonus table behind the HUD's SF tab (lib/sf-bonuses.js). The
// expected numbers are the game's own (bitburner-src v3.0.1 BitNode.tsx
// sfDescription and applySourceFile.ts). Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  halvingBonus,
  sourceFileBonuses,
  ownedSourceFiles,
  sourceFileBonusList,
  exploitBonus,
  SF_NAMES,
} from "../lib/sf-bonuses.js";

test("halvingBonus matches the game's level tables", () => {
  // SF1 16/24/28, SF2 24/36/42, SF3/5/6/7 8/12/14, SF8/9 12/18/21, SF11 32/48/56.
  for (const [base, expected] of [[16, [16, 24, 28]], [24, [24, 36, 42]], [8, [8, 12, 14]], [12, [12, 18, 21]], [32, [32, 48, 56]]]) {
    assert.deepEqual([1, 2, 3].map(l => halvingBonus(base, l)), expected, `base ${base}`);
  }
  assert.equal(halvingBonus(16, 0), 0);
});

test("each Source-File's lines carry its numbers", () => {
  const text = (sf, level) => sourceFileBonuses(sf, level).join("\n");
  assert.match(text(1, 3), /\+28% to every multiplier/);
  assert.match(text(1, 1), /32GB home RAM/);
  assert.match(text(2, 1), /\+24% crime success/);
  assert.match(text(3, 2), /\+12% charisma and company salary/);
  assert.doesNotMatch(text(3, 2), /Office and Warehouse/);
  assert.match(text(3, 3), /Office and Warehouse/);
  assert.match(text(4, 1), /x16/);
  assert.match(text(4, 2), /x4/);
  assert.match(text(4, 3), /x1 /);
  assert.match(text(5, 3), /\+14% hacking/);
  assert.match(text(5, 1), /Formulas\.exe/);
  assert.match(text(6, 2), /\+12% combat/);
  assert.match(text(7, 3), /Blade's Simulacrum/);
  assert.match(text(8, 1), /\+12% hacking grow/);
  assert.doesNotMatch(text(8, 1), /Short/);
  assert.match(text(8, 3), /Short selling[\s\S]*Limit and stop/);
  assert.match(text(9, 3), /\+21% hacknet production, -21% hacknet costs/);
  assert.match(text(9, 2), /128GB/);
  assert.match(text(9, 3), /level-100/);
  assert.match(text(10, 1), /^1 sleeve /);
  assert.match(text(10, 3), /^3 sleeves/);
  assert.match(text(11, 3), /\+56% company salary/);
  assert.match(text(11, 3), /x1\.767/);
  assert.match(text(12, 7), /NeuroFlux Governor level 7/);
  assert.match(text(13, 2), /Stanek's Gift \+2 size/);
  assert.match(text(14, 1), /200k/);
  assert.doesNotMatch(text(14, 1), /go\.cheat/);
  assert.match(text(14, 3), /400k[\s\S]*go\.cheat API[\s\S]*\+25%/);
  assert.match(text(15, 1), /DarkscapeNavigator/);
  assert.match(text(15, 3), /\.cache files/);
  // Every known Source-File has a name and a non-placeholder table.
  for (let sf = 1; sf <= 15; sf++) {
    assert.ok(SF_NAMES[sf], `SF${sf} name`);
    assert.doesNotMatch(text(sf, 1), /no table/, `SF${sf}`);
  }
  assert.match(text(16, 1), /no table/);
  assert.deepEqual(sourceFileBonuses(1, 0), []);
});

test("ownedSourceFiles reads the Map, sorted, dropping zero levels", () => {
  const reset = { ownedSF: new Map([[10, 3], [1, 3], [5, 0], [4, 2]]) };
  assert.deepEqual(ownedSourceFiles(reset), [[1, 3], [4, 2], [10, 3]]);
  assert.deepEqual(ownedSourceFiles({ ownedSF: { 2: 1 } }), [[2, 1]]);
  assert.deepEqual(ownedSourceFiles({}), []);
  const list = sourceFileBonusList(reset);
  assert.deepEqual(list.map(s => `${s.sf}.${s.level} ${s.name}`), ["1.3 Source Genesis", "4.2 The Singularity", "10.3 Digital Carbon"]);
  assert.ok(list.every(s => s.lines.length > 0));
});

test("exploitBonus compounds 0.1% per exploit", () => {
  assert.equal(exploitBonus(0), 0);
  assert.ok(Math.abs(exploitBonus(1) - 0.1) < 1e-9);
  assert.ok(Math.abs(exploitBonus(11) - (Math.pow(1.001, 11) - 1) * 100) < 1e-9);
});
