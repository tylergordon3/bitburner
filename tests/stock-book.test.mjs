// tests/stock-book.test.mjs
// The stock book as the run's savings, and the purchased-server budget. In
// BN14.1 the aug buyer counted cash alone while lib/stocks.js kept a tenth of
// net worth in cash: it saved for a $78b aug against $40b of cash and a $360b
// book, and bought nothing for the rest of the run. maybeBuyInfra froze the
// fleet at the same time ($3.85m of servers in 13 hours). Pinned here.
// Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextAugPurchase, infraBudget, buyAugs, maybeSetupGang } from "../lib/daemon-lib.js";
import { stockBook, hoardWithinReach } from "../lib/aug-targets.js";
import { augCashWanted } from "../lib/stocks-logic.js";
import { CONFIG, forNode } from "../lib/config.js";

const HOUR = 3_600_000;
const INFRA = CONFIG.infra;

// ── nextAugPurchase with a book ──────────────────────────────────────────────

test("nextAugPurchase: an aug that fits cash + book is raised for, not skipped", () => {
  const ready = [{ aug: "dear", price: 78e9 }, { aug: "mid", price: 47e9 }, { aug: "cheap", price: 16e9 }];
  // BN14.1 at 50h: $39b cash, $362b book, ~$44b/h income.
  const o = { spendable: 39e9, incomePerMs: 44e9 / HOUR, horizonMs: HOUR, book: 362e9 };
  const next = nextAugPurchase(ready, o);
  assert.equal(next.buy, null);
  assert.equal(next.savingFor.aug, "dear");
  assert.equal(next.raise, 78e9, "the cash to have the trader free up");
  // Without the book it was "saving" - with nothing to make the cash appear.
  const old = nextAugPurchase(ready, { ...o, book: 0 });
  assert.equal(old.savingFor.aug, "dear");
  assert.equal(old.raise, undefined);
});

test("nextAugPurchase: cash first, and never a raise for what even the book can't cover", () => {
  const ready = [{ aug: "dear", price: 100e9 }, { aug: "cheap", price: 1e9 }];
  // Fits cash: bought outright, no raise.
  assert.equal(nextAugPurchase(ready, { spendable: 200e9, incomePerMs: 0, horizonMs: HOUR, book: 50e9 }).buy.aug, "dear");
  // Out of reach even with the book, and income far off: the book stays
  // invested and the cheap one is bought.
  const far = nextAugPurchase(ready, { spendable: 2e9, incomePerMs: 1, horizonMs: HOUR, book: 10e9 });
  assert.equal(far.buy.aug, "cheap");
  assert.equal(far.raise, undefined);
  // Within income reach of cash + book: saved for, nothing raised yet.
  const near = nextAugPurchase(ready, { spendable: 2e9, incomePerMs: 90e9 / HOUR, horizonMs: HOUR, book: 10e9 });
  assert.equal(near.savingFor.aug, "dear");
  assert.equal(near.raise, undefined);
});

// ── stockBook ────────────────────────────────────────────────────────────────

test("stockBook: the live trader's positions, after commissions - nothing stale, foreign or treasured", () => {
  const now = 1_000_000;
  const o = { now, staleMs: 60_000, epoch: 500_000, treasurerTtlMs: 120_000 };
  const state = { tier: 1, totalValue: 300e9, cash: 40e9, netWorth: 339.9e9, updatedAt: now - 1_000 };
  assert.ok(Math.abs(stockBook(state, null, o) - 299.9e9) < 1);
  assert.equal(stockBook({ ...state, updatedAt: now - 120_000 }, null, o), 0, "stale: the trader died");
  assert.equal(stockBook({ ...state, updatedAt: 400_000 }, null, { ...o, now: 410_000 }), 0, "from before the install");
  // BN8: a treasurer runs the capital, and its allowance is the budget.
  assert.equal(stockBook(state, { amount: 5e9, updatedAt: now - 1_000 }, o), 0);
  assert.ok(stockBook(state, { amount: 5e9, updatedAt: now - 500_000 }, o) > 0, "a dead treasurer fences nothing");
  // The no-TIX shape (no netWorth): totalValue, which is 0 there.
  assert.equal(stockBook({ tier: 0, totalValue: 0, cash: 5e9, updatedAt: now }, null, o), 0);
  assert.equal(stockBook(null, null, o), 0);
});

// ── The trader's side of the ask ─────────────────────────────────────────────

test("augCashWanted: held while fresh and from this run; never under a treasurer", () => {
  const ask = { amount: 78e9, updatedAt: 1_000 };
  const o = { now: 2_000, epoch: 500, ttlMs: 120_000, treasury: false };
  assert.equal(augCashWanted(ask, o), 78e9);
  assert.equal(augCashWanted(ask, { ...o, treasury: true }), 0);
  assert.equal(augCashWanted(ask, { ...o, now: 1_000 + 120_000 }), 0, "expired");
  assert.equal(augCashWanted(ask, { ...o, epoch: 1_500 }), 0, "from before this trader's epoch");
  assert.equal(augCashWanted(null, o), 0);
  assert.equal(augCashWanted({ amount: -5, updatedAt: 1_000 }, o), 0);
});

test("REGRESSION: lib/stocks.js holds the aug's cash, and not as 4S money", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../lib/stocks.js", import.meta.url), "utf8");
  assert.match(src, /const hold = floor \+ wanted \+ augAsk/);
  assert.match(src, /money - floor - wanted - augAsk >= cost4S/);
});

// ── buyAugs end to end: the ask is published, then the cash is spent ────────

function fakeGame(world) {
  const log = { bought: [] };
  const priceOf = a => world.augs[a].price * Math.pow(1.9, log.bought.length);
  const ns = {
    getPlayer: () => ({ money: world.money, factions: Object.keys(world.factions), mults: { faction_rep: 1 } }),
    getFavorToDonate: () => 150,
    getResetInfo: () => ({ lastAugReset: 0, lastNodeReset: 0 }),
    fileExists: () => false,
    gang: { inGang: () => false },
    format: { number: n => String(Math.round(n)) },
    singularity: {
      getOwnedAugmentations: () => [...world.owned],
      getFactionRep: f => world.factions[f].rep,
      getFactionFavor: () => 0,
      getAugmentationsFromFaction: f => world.factions[f].augs,
      getAugmentationRepReq: a => world.augs[a].repReq,
      getAugmentationPrereq: () => [],
      getAugmentationPrice: priceOf,
      purchaseAugmentation: (f, a) => {
        const price = priceOf(a);
        if (world.money < price) return false;
        world.money -= price;
        world.owned.push(a);
        log.bought.push(a);
        return true;
      },
      donateToFaction: () => false,
    },
  };
  return { ns, log };
}

test("buyAugs: asks the trader for an aug the book covers, then buys it once the cash is there", () => {
  globalThis.gordMoneyFloor = 0;
  globalThis._incomeRatePerMs = 0;
  globalThis._repSnaps = {};
  globalThis.gordStockCashWanted = null;
  const world = {
    money: 40e9, owned: [],
    factions: { Bladeburners: { rep: 1e6, augs: ["Omnibeam", "IPU"] } },
    augs: { Omnibeam: { price: 78e9, repReq: 1 }, IPU: { price: 3e9, repReq: 1 } },
  };
  const { ns, log } = fakeGame(world);
  globalThis.gordStockState = { tier: 1, totalValue: 360e9, cash: 40e9, netWorth: 400e9, updatedAt: Date.now() };

  assert.deepEqual(buyAugs(ns), []);
  assert.deepEqual(log.bought, [], "nothing cheaper while the dear one is being raised for");
  assert.equal(globalThis.gordAugCashWanted.amount, 78e9);
  assert.equal(globalThis.gordAugCashWanted.aug, "Omnibeam");

  // The trader sold: the cash is there now. Bought dearest-first, ask cleared.
  // (IPU is $5.7b after it: one purchase later, x1.9.)
  world.money = 90e9;
  globalThis.gordStockState = { ...globalThis.gordStockState, totalValue: 310e9, cash: 90e9, updatedAt: Date.now() };
  buyAugs(ns);
  assert.deepEqual(log.bought, ["Omnibeam", "IPU"]);
  assert.equal(globalThis.gordAugCashWanted, null);
});

test("buyAugs: no ask under a treasurer, nor for NeuroFlux alone", () => {
  globalThis.gordMoneyFloor = 0;
  globalThis._incomeRatePerMs = 0;
  const world = {
    money: 1e9, owned: [],
    factions: { Bladeburners: { rep: 1e6, augs: ["Omnibeam"] } },
    augs: { Omnibeam: { price: 78e9, repReq: 1 } },
  };
  const { ns, log } = fakeGame(world);
  globalThis.gordStockState = { tier: 1, totalValue: 360e9, cash: 1e9, netWorth: 361e9, updatedAt: Date.now() };
  globalThis.gordStockCashWanted = { amount: 1e9, updatedAt: Date.now() };
  buyAugs(ns);
  assert.deepEqual(log.bought, []);
  assert.equal(globalThis.gordAugCashWanted, null, "BN8: the allowance is the budget");

  globalThis.gordStockCashWanted = null;
  const nfg = CONFIG.augs.neuroFlux;
  const only = fakeGame({
    money: 1e9, owned: [],
    factions: { CyberSec: { rep: 1e9, augs: [nfg] } },
    augs: { [nfg]: { price: 50e9, repReq: 1 } },
  });
  buyAugs(only.ns);
  assert.equal(globalThis.gordAugCashWanted, null, "the install's NeuroFlux dump sells the book anyway");
  globalThis.gordStockState = null;
});

// ── Hoards ───────────────────────────────────────────────────────────────────

test("hoardWithinReach: the book closes the gap at once; income the rest", () => {
  const daedalus = { faction: "Daedalus", money: 100e9, moneyMissing: 60e9 };
  assert.equal(hoardWithinReach(daedalus, 0, 8 * HOUR), false, "no income, no book");
  assert.equal(hoardWithinReach(daedalus, 0, 8 * HOUR, 60e9), true, "the book covers it");
  assert.equal(hoardWithinReach(daedalus, 1e9 / HOUR, 8 * HOUR, 53e9), true, "book $53b + 8h of $1b/h");
  assert.equal(hoardWithinReach(daedalus, 1e9 / HOUR, 8 * HOUR, 40e9), false);
});

test("BN14 never hoards for the Daedalus faction (it ends on Operation Daedalus)", () => {
  assert.deepEqual(forNode(14).factions.hoardSkip, ["Daedalus"]);
  assert.ok(!(forNode(7).factions.hoardSkip ?? []).includes("Daedalus"));
});

// ── infraBudget ──────────────────────────────────────────────────────────────

const base = { money: 60e9, floor: 0, incomePerMs: 10_000, incomePerGbMs: 0, gbCost: 0 };

test("infraBudget: a hoard holds everything; no target spends the free slice", () => {
  assert.deepEqual(infraBudget(null, { ...base, floor: 1 }), { hold: "invite" });
  const free = infraBudget(null, base);
  assert.equal(free.spendFraction, INFRA.noTarget.spendFraction);
  assert.equal(free.hardCap, undefined);
});

test("REGRESSION: an affordable target no longer freezes the fleet - but its price is kept", () => {
  const plan = infraBudget({ aug: "GOLEM", price: 47e9, moneyMissing: 0, repMissing: 0 }, base);
  assert.ok(!("hold" in plan));
  assert.equal(plan.spendFraction, INFRA.noTarget.spendFraction);
  assert.equal(plan.hardCap, 13e9, "never into the aug's price");
});

test("REGRESSION: money-short buys RAM that pays back fast, and only that", () => {
  const short = { aug: "Omnibeam", price: 78e9, moneyMissing: 18e9, repMissing: 0 };
  // $1m a GB, earning $1m/GB per 80s: pays back in 80s.
  const fast = infraBudget(short, { ...base, gbCost: 1e6, incomePerGbMs: 1e6 / 80_000 });
  assert.ok(!("hold" in fast), "it used to reserve the whole price - more than the cash, by definition");
  assert.equal(fast.spendFraction, INFRA.savingSpendFraction);
  // Payback past savingPaybackMs: wait for the aug.
  const slow = infraBudget(short, { ...base, gbCost: 1e6, incomePerGbMs: 1e6 / (2 * INFRA.savingPaybackMs) });
  assert.equal(slow.hold, "saving");
  // Unknown income per GB: wait too.
  assert.equal(infraBudget(short, base).hold, "saving");
});

test("infraBudget: blocked on rep keeps the old surplus rule", () => {
  const plan = infraBudget({ aug: "X", price: 10e9, moneyMissing: 0, repMissing: 5 }, base);
  assert.equal(plan.spendFraction, INFRA.repPending.spendFraction);
  assert.equal(plan.hardCap, 50e9);
});

// ── The shared gang snap-up ──────────────────────────────────────────────────

test("maybeSetupGang: founds with the first criminal faction joined, past the karma gate", () => {
  const gangCfg = { karma: -54_000, criminalFactions: ["Slum Snakes", "Tetrads"] };
  let created = null;
  const ns = player => ({
    getPlayer: () => player,
    gang: { inGang: () => false, createGang: f => { created = f; return true; } },
    tprint: () => {},
  });
  assert.equal(maybeSetupGang(ns({ karma: -1000, factions: ["Tetrads"] }), gangCfg), null);
  assert.equal(maybeSetupGang(ns({ karma: -60_000, factions: [] }), gangCfg).action, "Gang (karma ready)");
  assert.equal(maybeSetupGang(ns({ karma: -60_000, factions: ["Tetrads"] }), gangCfg).action, "Gang Created");
  assert.equal(created, "Tetrads");
  // No SF2: createGang throws, and that is not an error.
  const noSf2 = { getPlayer: () => ({ karma: -60_000, factions: ["Tetrads"] }), gang: { inGang: () => false, createGang: () => { throw new Error("no"); } }, tprint: () => {} };
  assert.equal(maybeSetupGang(noSf2, gangCfg), null);
});
