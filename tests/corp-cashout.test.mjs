// tests/corp-cashout.test.mjs
//
// The corporation fixes from the BN14 audit (2026-10-23 save: a self-funded
// corp, public after four rounds, $150b in and $0 back after 60 hours):
//
//   - corp.cashOut: nodes where a corp cannot pay for itself no longer found
//     one, and sell the shares of one that exists (lib/corp-cashout.js, whose
//     decisions are corp-lib's cashOutStep);
//   - corp-market put a product industry's own INPUT on sale, because a product
//     industry's data has no producedMaterials key and that read as "unknown";
//   - module state in corp-daemon / corp-upkeep outlived the process it was for.
// Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG, forNode } from "../lib/config.js";
import { cashOutStep } from "../lib/corp-lib.js";
import { materialSales, pass as marketPass } from "../lib/corp-market.js";
import { claimRotation, rotationState, notePhaseSlot } from "../lib/corp-daemon.js";

const CO = CONFIG.corp;

// ── Which nodes run a corp ───────────────────────────────────────────────────

test("nodes where a corp cannot pay back neither found one nor run one - they cash out", () => {
  for (const node of [5, 6, 7, 10, 14]) {
    const c = forNode(node).corp;
    assert.equal(c.enabled, false, `BN${node} founds no corp`);
    assert.equal(c.cashOut, true, `BN${node} sells an existing corp's shares`);
  }
  // Unchanged: BN3 is the corp's home, BN1/2/4/12 keep it, and the nodes that
  // were already off stay plain-off (nothing worth selling there).
  for (const node of [1, 2, 3, 4, 12]) {
    assert.equal(forNode(node).corp.enabled, true, `BN${node}`);
    assert.equal(forNode(node).corp.cashOut, false, `BN${node}`);
  }
  for (const node of [8, 11, 13, 15]) {
    assert.equal(forNode(node).corp.enabled, false, `BN${node}`);
    assert.ok(!forNode(node).corp.cashOut, `BN${node}`);
  }
  // The override is only the two switches: the rest of the corp config is intact.
  assert.equal(forNode(14).corp.name, CO.name);
  assert.equal(forNode(14).corp.cashOutMaxShares, CO.cashOutMaxShares);
  assert.equal(CONFIG.paths.corpCashOut, "/lib/corp-cashout.js");
});

// ── cashOutStep ──────────────────────────────────────────────────────────────

test("the BN14 corp: public, 100M shares, no cooldown - one sale of all but one share", () => {
  const corp = { public: true, numShares: 100e6, totalShares: 1e9, shareSaleCooldown: 0 };
  assert.deepEqual(cashOutStep(corp, CO.cashOutMaxShares), { action: "sell", shares: 100e6 - 1 });
});

test("a private corp goes public first; nothing is sold until it has", () => {
  assert.deepEqual(cashOutStep({ public: false, numShares: 1e9, shareSaleCooldown: 0 }, 2e8), { action: "goPublic" });
});

test("a big holding goes in chunks, a cooldown apart", () => {
  const corp = { public: true, numShares: 1e9, shareSaleCooldown: 0 };
  assert.deepEqual(cashOutStep(corp, 2e8), { action: "sell", shares: 2e8 });
  const cooling = cashOutStep({ ...corp, numShares: 8e8, shareSaleCooldown: 18e3 }, 2e8);
  assert.equal(cooling.action, "wait");
  assert.equal(cooling.waitMs, 18e3 * 200, "the game's hour, in wall-clock ms");
  // The last chunk keeps the one share the game will not let go.
  assert.deepEqual(cashOutStep({ ...corp, numShares: 1.5e8 }, 2e8), { action: "sell", shares: 1.5e8 - 1 });
});

test("nothing left to sell (or no corp) is done", () => {
  assert.deepEqual(cashOutStep({ public: true, numShares: 1, shareSaleCooldown: 0 }, 2e8), { action: "done" });
  assert.deepEqual(cashOutStep(undefined, 2e8), { action: "done" });
  // An unset cap means "everything but one".
  assert.deepEqual(cashOutStep({ public: true, numShares: 50, shareSaleCooldown: 0 }, 0), { action: "sell", shares: 49 });
});

// ── corp-market: what a division sells ───────────────────────────────────────

test("REGRESSION: a product industry sells none of its inputs", () => {
  // getIndustryData("Tobacco"): no producedMaterials key at all.
  const tobacco = { requiredMaterials: { Plants: 1 }, makesMaterials: false, makesProducts: true };
  assert.deepEqual(materialSales(tobacco, CO.defaultProducedMaterials),
    { sell: [], clear: ["Plants", "Food"] });
  const agri = { requiredMaterials: { Water: 0.5, Chemicals: 0.2 }, producedMaterials: ["Plants", "Food"] };
  assert.deepEqual(materialSales(agri, CO.defaultProducedMaterials), { sell: ["Plants", "Food"], clear: [] });
  const chem = { requiredMaterials: { Plants: 1, Water: 0.5 }, producedMaterials: ["Chemicals"] };
  assert.deepEqual(materialSales(chem, CO.defaultProducedMaterials), { sell: ["Chemicals"], clear: ["Plants", "Food"] });
  // Only an unreadable industry falls back to the default list.
  assert.deepEqual(materialSales(undefined, CO.defaultProducedMaterials), { sell: ["Plants", "Food"], clear: [] });
});

/** A round-5 corp with one Tobacco division in one city, Smart Supply owned. */
function tobaccoNs(sellOrders) {
  const division = { name: "Tobacco", industry: "Tobacco", researchPoints: 0 };
  const sells = [];
  return {
    sells,
    print: () => {},
    format: { number: n => String(n) },
    corporation: {
      getCorporation: () => ({ funds: 1e9, revenue: 0, expenses: 0, divisions: [division.name] }),
      getDivision: name => { if (name !== division.name) throw new Error("no division"); return division; },
      hasUnlock: () => true,
      hasResearched: () => false,
      getBonusTime: () => 0,
      getIndustryData: () => ({
        requiredMaterials: { Plants: 1 }, makesMaterials: false, makesProducts: true,
        realEstateFactor: 0.15, hardwareFactor: 0.15, robotFactor: 0.2, aiCoreFactor: 0.15,
      }),
      getWarehouse: (div, city) => { if (city !== "Aevum") throw new Error("no warehouse"); return { size: 1000, sizeUsed: 0 }; },
      getMaterial: (div, city, mat) => ({
        stored: 0, marketPrice: 1000, productionAmount: 0, importAmount: 0,
        desiredSellAmount: sellOrders[mat] ?? 0, desiredSellPrice: "MP",
      }),
      buyMaterial: () => {},
      sellMaterial: (div, city, mat, amount, price) => { sells.push([mat, amount, price]); sellOrders[mat] = amount; },
      setSmartSupply: () => {},
      setMaterialMarketTA2: () => {},
    },
  };
}

test("REGRESSION: corp-market takes back the MAX order it put on Tobacco's Plants", () => {
  globalThis.gordCorpRound = 5;
  const orders = { Plants: "MAX", Food: "MAX" };
  const ns = tobaccoNs(orders);
  marketPass(ns);
  assert.deepEqual(ns.sells.filter(([, a]) => a === "MAX"), [], "nothing put on sale");
  assert.ok(ns.sells.some(([m, a]) => m === "Plants" && a === "0"), "the stray order is cleared");
  assert.equal(orders.Plants, "0");
  assert.equal(orders.Food, "0");
  // A second pass finds nothing on MAX to take back, and puts nothing on sale.
  // (Food: only this fix touches it on Tobacco - Plants is also an input, whose
  // drain orders manageOvershoot reviews every pass.)
  const before = ns.sells.length;
  marketPass(ns);
  assert.deepEqual(ns.sells.slice(before).filter(([m]) => m === "Food"), []);
  assert.deepEqual(ns.sells.filter(([, a]) => a === "MAX"), []);
  globalThis.gordCorpRound = undefined;
});

// ── Module state belongs to a process ────────────────────────────────────────

test("REGRESSION: a new daemon process starts the phase rotation over", () => {
  claimRotation(101);
  assert.equal(claimRotation(101), false, "same process: nothing reset");
  const before = rotationState();
  assert.deepEqual(before, { phase: 0, misses: {} });
  // (notePhaseSlot is the pure half; the module copy is what a restart inherited.)
  assert.equal(notePhaseSlot({ corpMarket: 2 }, "corpMarket", false, 3).warn, true);
  assert.equal(claimRotation(202), true, "a different daemon PID resets");
  assert.deepEqual(rotationState(), { phase: 0, misses: {} });
});
