// tests/corp-module-state.test.mjs
//
// Corp fixes that came out of reading bitburner-src rather than the corp
// manual - most of them about state outliving the thing it described:
//
//   - A script's MODULE scope is not per-run scope. NetscriptJSEvaluator keeps a
//     moduleCache keyed by source text, so every run of an unchanged script - on
//     any server, after a restart, an install or a BitNode change - is handed the
//     same module instance, variables and all. The one-shot build phases kept
//     their per-pass journal tallies in module constants "zeroed by construction
//     each launch"; they weren't, so each pass re-journalled the lifetime total.
//     Node's module cache behaves the same way, which is what lets these tests
//     reproduce it: two calls to pass() here ARE two runs in the game.
//   - globalThis outlives the corporation: the game destroys the corp on
//     entering a BitNode, and the next one inherited its handshakes.
//   - corp-steady's upgrade budget ignored the objective corp-expand banks for.
//   - Nothing banked for the dividend-tax unlocks.
// Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../lib/config.js";
import { pass as officePass } from "../lib/corp-office.js";
import { pass as marketPass } from "../lib/corp-market.js";
import { upgradeBudget } from "../lib/corp-steady.js";
import { chooseObjective, pendingTaxUnlockCost } from "../lib/corp-expand.js";
import { dropStaleCorpState } from "../lib/corp-daemon.js";

const CO = CONFIG.corp;

const GLOBALS = [
  "gordCorpRound", "gordCorpSavingFor", "gordCorpOfferHold", "gordCorpOfferHoldAt", "gordCorpOfficeDone",
  "gordCorpOfficeNeed", "gordCorpJournalAccum", "gordCorpLogAt", "gordCorpStaffMode", "gordEvents",
  "gordCorpExpandDone", "gordCorpCheapestStep", "gordCorpSmartSupplyOn",
];
function reset() {
  for (const k of GLOBALS) globalThis[k] = undefined;
}

/** What the journal accumulator is still holding for `key` (pending, unflushed). */
const pending = key => globalThis.gordCorpJournalAccum?.[key] ?? {};
const journal = () => (globalThis.gordEvents ?? []).map(e => e.text);

// ── corp-office ──────────────────────────────────────────────────────────────

/** A round-1 corp: Agriculture in one city, office of 3, rich enough to grow it. */
function officeNs() {
  const office = {
    size: 3, numEmployees: 3,
    employeeJobs: { Operations: 0, Engineer: 0, Business: 0, Management: 0, "Research & Development": 3, Intern: 0 },
  };
  const division = { name: "Agriculture", industry: "Agriculture", researchPoints: 0, numAdVerts: 2, cities: ["Aevum"] };
  return {
    office,
    print: () => {},
    format: { number: n => String(n) },
    corporation: {
      getCorporation: () => ({ funds: 1e12, divisions: [division.name] }),
      getDivision: name => { if (name !== division.name) throw new Error("no division"); return division; },
      getOffice: (div, city) => { if (city !== "Aevum") throw new Error("no office"); return { ...office, employeeJobs: { ...office.employeeJobs } }; },
      getOfficeSizeUpgradeCost: () => 1e9,
      upgradeOfficeSize: (div, city, n) => { office.size += n; },
      hireEmployee: () => { if (office.numEmployees >= office.size) return false; office.numEmployees++; return true; },
      setJobAssignment: (div, city, job, n) => { office.employeeJobs[job] = n; return true; },
      getHireAdVertCost: () => 1e9,
      hireAdVert: () => {},
    },
  };
}

test("REGRESSION: a second corp-office pass does not re-journal the first one's growth", () => {
  reset();
  globalThis.gordCorpRound = 1;
  const ns = officeNs();

  officePass(ns); // grows 3 -> 4 (round 1's target) and hires the new seat
  assert.equal(ns.office.size, CO.agriTargets[1].office);
  const first = journal().filter(t => t.startsWith("[corp] Grew:"));
  assert.equal(first.length, 1);
  assert.match(first[0], /office seats \+1\b/);
  assert.match(first[0], /hires \+1\b/);

  // The next rotation: nothing left to grow. The module-level tally used to
  // still read "1 seat, 1 hire" and fed it to the accumulator again - and again
  // every pass after, so the corp "grew" forever.
  officePass(ns);
  officePass(ns);
  assert.deepEqual(pending("officeBuild"), {}, "nothing grew, so nothing is waiting to be journalled");
  assert.equal(journal().filter(t => t.startsWith("[corp] Grew:")).length, 1);
  reset();
});

// ── corp-market ──────────────────────────────────────────────────────────────

/** A round-1 Agriculture warehouse (no Smart Supply) that is short of Water. */
function marketNs(stock) {
  const division = { name: "Agriculture", industry: "Agriculture", researchPoints: 0 };
  const wh = { size: 100, sizeUsed: 0 };
  const orders = [];
  return {
    orders,
    print: () => {},
    format: { number: n => String(n) },
    corporation: {
      getCorporation: () => ({ funds: 1e9, divisions: [division.name] }),
      getDivision: name => { if (name !== division.name) throw new Error("no division"); return division; },
      hasUnlock: () => false,
      hasResearched: () => false,
      getBonusTime: () => 0,
      getIndustryData: () => ({
        requiredMaterials: { Water: 0.5, Chemicals: 0.2 }, producedMaterials: ["Plants", "Food"],
        realEstateFactor: 0.72, hardwareFactor: 0.2, robotFactor: 0.3, aiCoreFactor: 0.3, makesProducts: false,
      }),
      getWarehouse: (div, city) => { if (city !== "Aevum") throw new Error("no warehouse"); return { ...wh }; },
      getMaterial: (div, city, mat) => ({ stored: stock[mat] ?? 0, marketPrice: 1000, productionAmount: 0, importAmount: 0 }),
      buyMaterial: (div, city, mat, rate) => { if (rate > 0) orders.push(mat); },
      sellMaterial: () => {},
      setSmartSupply: () => {},
    },
  };
}

test("REGRESSION: a second corp-market pass does not re-journal the first one's orders", () => {
  reset();
  globalThis.gordCorpRound = 1;

  const stock = {};
  const ns = marketNs(stock);
  marketPass(ns); // empty warehouse: an input order each for Water and Chemicals
  assert.deepEqual([...new Set(ns.orders)].sort(), ["Chemicals", "Water"]);
  const first = journal().filter(t => t.startsWith("[corp] Ordering materials:"));
  assert.equal(first.length, 1);
  assert.match(first[0], /purchase orders \+2\b/);

  // Stock arrives; the next passes have nothing to fill. The line "goes quiet on
  // its own" only if this pass's tally starts from zero.
  stock.Water = 1e6;
  stock.Chemicals = 1e6;
  marketPass(ns);
  marketPass(ns);
  assert.deepEqual(pending("marketOrders"), {}, "no fill orders placed, so nothing to journal");
  reset();
});

// ── corp-daemon: another corporation's state is not this one's ───────────────

test("REGRESSION: a new BitNode's corp does not inherit the last corp's handshakes", () => {
  // The old corp ended fully built and public - which is what it usually does.
  const g = {
    gordCorpNodeStamp: 1000,
    gordCorpRound: 5, gordCorpExpandDone: true, gordCorpOfficeDone: true,
    gordCorpSavingFor: 2e15, gordCorpCheapestStep: Infinity, gordCorpOfferHold: false,
    gordCorpAuto: false,      // the player's switch
    gordHadCorp: true,        // corp-daemon's own bookkeeping
  };

  // Same node, the corp is alive: nothing is touched.
  assert.equal(dropStaleCorpState(g, 1000, true), false);
  assert.equal(g.gordCorpExpandDone, true);
  assert.equal(g.gordCorpRound, 5);

  // New node (the game destroyed the corp on the way in), no corp yet.
  assert.equal(dropStaleCorpState(g, 2000, false), true);
  // These two being true is what let corp-steady spend 36% of a fresh $150b on
  // corp-wide upgrades every cycle, before Agriculture was even founded...
  assert.equal(g.gordCorpExpandDone, undefined);
  assert.equal(g.gordCorpOfficeDone, undefined);
  // ...and a known round is what let the phases build against "round 5".
  assert.equal(g.gordCorpRound, undefined);
  assert.equal(g.gordCorpSavingFor, undefined);
  assert.equal(g.gordCorpAuto, false, "the CORP toggle is the player's");
  assert.equal(g.gordHadCorp, true);

  // The new corp is founded and the phases publish for it: kept from here on.
  g.gordCorpRound = 1;
  g.gordCorpExpandDone = false;
  assert.equal(dropStaleCorpState(g, 2000, true), false);
  assert.equal(g.gordCorpRound, 1);

  // A corp made by hand before the daemon ever ticked in the node: the stamp
  // alone gives it away.
  const late = { gordCorpNodeStamp: 1000, gordCorpExpandDone: true, gordCorpRound: 5 };
  assert.equal(dropStaleCorpState(late, 2000, true), true);
  assert.equal(late.gordCorpExpandDone, undefined);

  // No corporation at all (sold mid-node): dropped every tick until there is one.
  const sold = { gordCorpNodeStamp: 2000, gordCorpRound: 3 };
  assert.equal(dropStaleCorpState(sold, 2000, false), true);
  assert.equal(sold.gordCorpRound, undefined);
});

// ── corp-steady: corp-wide upgrades queue behind the objective ───────────────

test("the upgrade budget is a share of the surplus above the reserve AND the objective", () => {
  const share = CO.upgradeBudgetFraction;
  const keep = 1 - CO.fundsReserveFraction;
  // Nothing being banked: the old figure.
  assert.equal(upgradeBudget(10e9, 0), 10e9 * keep * share);
  assert.equal(upgradeBudget(10e9, undefined), 10e9 * keep * share);
  // Banking for a $9b city: only what is above it is spendable...
  assert.equal(upgradeBudget(20e9, 9e9), (20e9 * keep - 9e9) * share);
  // ...and while funds are short of it, nothing is. (This was 36% of funds a
  // cycle: saving $9b out of $1b a cycle levelled off at $2.8b.)
  assert.equal(upgradeBudget(5e9, 9e9), 0);
  assert.equal(upgradeBudget(-1e9, 0), 0, "a corp in debt buys no upgrades");
});

// ── corp-expand: the dividend-tax unlocks are banked for ─────────────────────

/** ns for a corp that owns the unlocks in `owned`. */
function unlockNs(owned, prices = { "Shady Accounting": 500e12, "Government Partnership": 2e15 }) {
  return {
    corporation: {
      hasUnlock: name => owned.includes(name),
      getUnlockCost: name => { if (!(name in prices)) throw new Error("no such unlock"); return prices[name]; },
    },
  };
}

test("pendingTaxUnlockCost is the next unowned tax unlock, cheapest first, then nothing", () => {
  assert.deepEqual(CO.taxUnlocks, ["Shady Accounting", "Government Partnership"]);
  assert.equal(pendingTaxUnlockCost(unlockNs([])), 500e12);
  assert.equal(pendingTaxUnlockCost(unlockNs(["Shady Accounting"])), 2e15);
  assert.equal(pendingTaxUnlockCost(unlockNs(["Shady Accounting", "Government Partnership"])), 0);
  // An unreadable price must not become a savings floor.
  assert.equal(pendingTaxUnlockCost(unlockNs([], {})), 0);
});

test("a tax unlock is banked for only when reachable, and after every buildout lump", () => {
  const HORIZON = CO.savingHorizonSeconds;
  const tax = { kind: "tax", cost: 2e15 };
  // $1e12/s reaches $2q inside the horizon: bank for it.
  assert.equal(chooseObjective([tax], 1e14, 1e12, HORIZON)?.kind, "tax");
  // $1e9/s does not: keep growing instead of freezing every spender for weeks.
  assert.equal(chooseObjective([tax], 1e14, 1e9, HORIZON), null);
  // A pending city still comes first.
  const city = { kind: "productCity", cost: 9e9 };
  assert.equal(chooseObjective([city, tax], 1e14, 1e12, HORIZON)?.kind, "productCity");
});
