// tests/pserv.test.mjs
// The purchased-server buyer's choice rule (lib/pserv.js bestRamPerDollar),
// against the game's own price curve: cost = ram * 55000 * mult, times
// softcap^(log2(ram) - 6) above 64GB (bitburner-src Server/ServerPurchases.ts).
// Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { bestRamPerDollar } from "../lib/pserv.js";

const cost = (ram, softcap) => ram * 55_000 * (ram > 64 ? Math.pow(softcap, Math.log2(ram) - 6) : 1);
const buyOptions = (budget, softcap) => {
  const out = [];
  for (let ram = 2; ram <= 2 ** 20 && cost(ram, softcap) <= budget; ram *= 2) out.push({ ram, cost: cost(ram, softcap), gain: ram });
  return out;
};

test("flat pricing: every tier ties, so the biggest affordable step wins (the old behaviour)", () => {
  const pick = bestRamPerDollar(buyOptions(1e9, 1));
  assert.equal(pick.ram, 16384); // $901M of the $1b
});

test("REGRESSION: on BN7's softcap curve the largest affordable tier is the worst buy", () => {
  // $/GB doubles with each doubling past 64GB.
  assert.equal(cost(64, 2), 3.52e6);
  assert.ok(Math.abs(cost(1024, 2) - 901.12e6) < 1);
  const pick = bestRamPerDollar(buyOptions(1e9, 2));
  assert.equal(pick.ram, 64);

  // Spending $1b greedily by RAM per dollar across 25 slots: fill them at 64GB,
  // then raise the weakest a doubling at a time. Far more RAM than one 1TB box.
  const fleet = [];
  let money = 1e9;
  for (let guard = 0; guard < 500; guard++) {
    const options = fleet.length < 25 ? buyOptions(money, 2) : [];
    if (fleet.length) {
      const i = fleet.indexOf(Math.min(...fleet));
      for (let ram = fleet[i] * 2; cost(ram, 2) - cost(fleet[i], 2) <= money; ram *= 2) {
        options.push({ i, ram, cost: cost(ram, 2) - cost(fleet[i], 2), gain: ram - fleet[i] });
      }
    }
    const p = bestRamPerDollar(options);
    if (!p) break;
    if (p.i === undefined) fleet.push(p.ram); else fleet[p.i] = p.ram;
    money -= p.cost;
  }
  const total = fleet.reduce((a, b) => a + b, 0);
  assert.ok(total >= 4096, `levelled fleet holds ${total}GB`);
  assert.ok(Math.max(...fleet) <= 256, "no slot ran ahead up the curve");
});

test("nothing affordable, or nothing to gain: no pick", () => {
  assert.equal(bestRamPerDollar([]), null);
  assert.equal(bestRamPerDollar([{ cost: 0, gain: 8 }, { cost: 5, gain: 0 }]), null);
});
