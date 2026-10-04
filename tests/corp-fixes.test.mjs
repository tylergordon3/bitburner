// tests/corp-fixes.test.mjs
//
// The pure decisions behind the corporation audit fixes. None of this can be
// validated in-game from a node without a corp, so each test pins the decision to
// the game mechanic it was derived from (bitburner-src Corporation/*.ts), and the
// product-pricing tests run the controller against a re-implementation of the
// game's own sale rule.
// Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../lib/config.js";
import { offerHoldActive, roundKnown, earlyRpGate, distributeJobs } from "../lib/corp-lib.js";
import { boostOrderTargets, boostSpendBudget, orderRate, researchListFor } from "../lib/corp-market.js";
import { chooseObjective, warehouseClimbFloor, optionalUnlockOrder, exportPlan } from "../lib/corp-expand.js";
import { advertCostToLevel } from "../lib/corp-office.js";
import { isSpendTick, nextProductPrice } from "../lib/corp-steady.js";
import { upkeepPass } from "../lib/corp-upkeep.js";
import { notePhaseSlot } from "../lib/corp-daemon.js";
import { pass as investPass } from "../lib/corp-invest.js";

const CO = CONFIG.corp;

const GLOBALS = [
  "gordCorpOffer", "gordCorpCheapestStep", "gordCorpExpandDone", "gordCorpSavingFor",
  "gordCorpOfferHold", "gordCorpOfferHoldAt", "gordCorpRound", "gordCorpUpkeep",
];
function reset() {
  for (const k of GLOBALS) globalThis[k] = undefined;
}

/** ns whose corp holds `funds` - all corpFunds()/affordable() need. */
function fundsNs(funds) {
  return { corporation: { getCorporation: () => ({ funds, divisions: [] }) } };
}

// ── The offer hold is corp-wide, and expires if nobody tends it ──────────────

test("a held offer is only honoured while corp-invest keeps stamping it", () => {
  reset();
  const now = 1_000_000_000;
  assert.equal(offerHoldActive(now), false, "no flag, no hold");

  globalThis.gordCorpOfferHold = true;
  assert.equal(offerHoldActive(now), false,
    "a flag with no stamp is one nobody is tending - it must not freeze the corp");

  globalThis.gordCorpOfferHoldAt = now - 60_000; // stamped one rotation ago
  assert.equal(offerHoldActive(now), true);

  globalThis.gordCorpOfferHoldAt = now - CO.offerHoldStaleMs - 1;
  assert.equal(offerHoldActive(now), false, "corp-invest stopped being placed: the hold lapses");

  globalThis.gordCorpOfferHoldAt = now;
  globalThis.gordCorpOfferHold = false;
  assert.equal(offerHoldActive(now), false);
  reset();
});

test("corp-invest's hold is one the spenders will actually honour, and it ends on accept", () => {
  reset();
  // A round-1 corp with everything built, staffed and earning: READY.
  globalThis.gordCorpExpandDone = true;
  globalThis.gordCorpOfficeDone = true;
  let offer = 100e9;
  const accepted = [];
  const division = { name: "Agriculture", industry: "Agriculture", researchPoints: 60, products: [] };
  const ns = {
    print: () => {},
    format: { number: n => String(n) },
    corporation: {
      getInvestmentOffer: () => ({ round: 1, funds: offer }),
      getCorporation: () => ({ funds: 5e9, divisions: [division.name], revenue: 5e6, expenses: 1e6, public: false }),
      getDivision: name => (name === division.name ? division : undefined),
      acceptInvestmentOffer: () => { accepted.push(offer); return true; },
    },
  };

  investPass(ns);
  assert.deepEqual(accepted, [], "ready is not the moment to sell");
  assert.equal(offerHoldActive(), true, "the flag must arrive stamped, or no spender stands down");

  // The offer climbs, then settles; the hold is refreshed each pass until then.
  for (const next of [300e9, 480e9, 481e9]) {
    offer = next;
    investPass(ns);
  }
  assert.deepEqual(accepted, [481e9], "sold once the offer stopped rising - not at 100b");
  assert.equal(offerHoldActive(), false, "spending resumes the moment the round is banked");
  reset();
  globalThis.gordCorpHoldState = undefined;
  globalThis.gordCorpOfficeDone = undefined;
});

test("the phases wait for a published round instead of assuming round 1", () => {
  reset();
  assert.equal(roundKnown(), false, "after a reload nothing has been published");
  globalThis.gordCorpRound = 3;
  assert.equal(roundKnown(), true);
  reset();
});

// ── Boost orders: capped by money past round 2, gated on RP before it ────────

const BOOSTS = { "Real Estate": 12000, Hardware: 0, Robots: 0, "AI Cores": 0 };
const allZero = t => Object.values(t).every(v => v === 0);

test("rounds 1-2 may spend anything on boosts - debt is the manual's plan there", () => {
  assert.equal(boostSpendBudget(-5e9, 0, 1), Infinity);
  assert.equal(boostSpendBudget(3e9, 70e9, 2), Infinity);
});

test("past round 2 a pass may only spend a share of the genuine surplus", () => {
  const round = CO.boostAfterBuildoutRound + 1;
  const surplus = 100e9 * (1 - CO.fundsReserveFraction);
  assert.equal(boostSpendBudget(100e9, 0, round), surplus * CO.boostBudgetFraction);
  // The objective corp-expand is banking for comes off the top...
  assert.equal(boostSpendBudget(100e9, 50e9, round), (surplus - 50e9) * CO.boostBudgetFraction);
  // ...and with nothing left above it, or in debt, the budget is zero - not negative.
  assert.equal(boostSpendBudget(100e9, 95e9, round), 0);
  assert.equal(boostSpendBudget(-17.281e9, 0, round), 0);
  assert.ok(CO.boostBudgetFraction > 0 && CO.boostBudgetFraction < 1);
});

test("REGRESSION: $3.4b of surplus cannot order a $20b boost pile on credit", () => {
  // The BN3 corp: $3.4b in hand, two warehouse levels had just enlarged the
  // boost target. The order was sized by the WAREHOUSE (250k Real Estate at
  // ~$80k = $20b), and took the corp to -$17.3b in one pass.
  const round = CO.boostAfterBuildoutRound + 1;
  const budget = boostSpendBudget(3.4e9, 0, round);
  const order = orderRate({
    target: 250_000, stored: 0, size: 0.005, room: 5000, seconds: 60,
    tolerance: CO.boostShortfallTolerance, budget, price: 80_000,
  });
  assert.ok(order.cost <= budget * 1.000001, "the order must fit the pot");
  assert.ok(order.cost < 3.4e9, "and can never exceed what the corp holds");
  assert.ok(order.units > 0, "but surplus IS spent - the pile fills over a few rotations");
  assert.equal(order.rate, order.units / 60);
});

test("a boost order with no money cap is exactly the old shortfall/window order", () => {
  const order = orderRate({
    target: 1000, stored: 400, size: 0.1, room: 500, seconds: 60,
    tolerance: 0.02, price: 15_000,
  });
  assert.equal(order.units, 600);
  assert.equal(order.rate, 10);
  assert.equal(order.cost, 600 * 15_000);
  // Capped by the warehouse room orders may claim.
  assert.equal(orderRate({ target: 1000, stored: 400, size: 0.1, room: 20, seconds: 60, tolerance: 0.02 }).units, 200);
});

test("orders clear when the target is met, zero, or the warehouse is crowded", () => {
  const base = { target: 1000, stored: 0, size: 0.1, room: 500, seconds: 60, tolerance: 0.02 };
  assert.equal(orderRate({ ...base, stored: 990 }).rate, 0, "inside the tolerance band");
  assert.equal(orderRate({ ...base, stored: 1500 }).rate, 0, "over target");
  assert.equal(orderRate({ ...base, target: 0 }).rate, 0);
  assert.equal(orderRate({ ...base, room: 0 }).rate, 0, "no room under the output headroom");
  assert.equal(orderRate({ ...base, room: -40, consumption: 50 }).rate, 0,
    "a crowded warehouse orders nothing - not even the flow (congestion, manual 12.2)");
  assert.equal(orderRate({ ...base, size: 0 }).rate, 0, "unknown footprint - don't guess");
  // A finite budget with an unreadable price buys nothing rather than everything.
  assert.equal(orderRate({ ...base, budget: 1e9, price: 0 }).rate, 0);
});

test("an INPUT order follows what the division consumes, not just the shortfall", () => {
  // Agriculture, level-4 warehouse: Water target 2286. Boosted production wants
  // ~56 Water/s; the old shortfall-only order could never deliver more than
  // target/window = 38/s, and a tenth of that under bonus time.
  const base = { target: 2286, size: 0.05, room: 400, tolerance: 0.02, consumption: 56 };
  const atTarget = orderRate({ ...base, stored: 2286, seconds: 60 });
  assert.equal(atTarget.rate, 56, "at target, the standing order is exactly the consumption");
  assert.equal(atTarget.units, 0, "...and claims no net warehouse room");

  const short = orderRate({ ...base, stored: 1000, seconds: 60 });
  assert.equal(short.rate, 56 + 1286 / 60, "short of target: consumption plus the refill");

  const bonus = orderRate({ ...base, stored: 2286, seconds: 600 });
  assert.equal(bonus.rate, 56, "the bonus-time window stretches the refill, never the flow");

  const over = orderRate({ ...base, stored: 2886, seconds: 60 });
  assert.equal(over.rate, 46, "over target: buy less than is consumed, so stock drains to it");
  assert.equal(orderRate({ ...base, stored: 9000, seconds: 60 }).rate, 0, "never negative");
});

test("an input an export route already delivers is not bought again on the market", () => {
  // Chemical's Plants arrive from Agriculture at high quality; market Plants are
  // quality 1 and dilute the loop the route exists for.
  const base = { target: 1000, stored: 1000, size: 0.05, room: 400, seconds: 60, tolerance: 0.02, consumption: 30 };
  assert.equal(orderRate({ ...base, imports: 30 }).rate, 0, "imports cover it: order nothing");
  assert.equal(orderRate({ ...base, imports: 45 }).rate, 0);
  assert.equal(orderRate({ ...base, imports: 12 }).rate, 18, "buy only what the route doesn't bring");
});

test("rounds 1-2: no boosts on credit until the division has banked its RP", () => {
  reset();
  globalThis.gordCorpExpandDone = true; // capacity built - boosts would otherwise flow
  const ns = fundsNs(5e9);
  for (const round of [1, 2]) {
    assert.ok(allZero(boostOrderTargets(ns, BOOSTS, round, false)),
      `round ${round}: everyone is on R&D, a production multiplier buys nothing`);
    assert.deepEqual(Object.keys(boostOrderTargets(ns, BOOSTS, round, false)).sort(), Object.keys(BOOSTS).sort(),
      "held materials must still be listed, or their standing orders go unreviewed");
    assert.deepEqual(boostOrderTargets(ns, BOOSTS, round, true), BOOSTS, "RP banked: order");
  }
  // The gate is a round-1/2 protocol; it never applies past them.
  assert.deepEqual(boostOrderTargets(fundsNs(50e9), BOOSTS, 3, false), BOOSTS);
  reset();
});

test("the RP gates are the manual's numbers, per round and industry", () => {
  assert.equal(earlyRpGate(1, "Agriculture"), CO.round1ResearchPoints);
  assert.equal(earlyRpGate(2, "Agriculture"), CO.round2ResearchPoints.Agriculture);
  assert.equal(earlyRpGate(2, "Chemical"), CO.round2ResearchPoints.Chemical);
  assert.equal(earlyRpGate(2, "Tobacco"), 0, "no gate for an industry the round doesn't name");
  assert.equal(earlyRpGate(3, "Agriculture"), 0);
});

test("a held offer pauses round-3+ boosts, but never the round-1/2 closing move", () => {
  reset();
  const ns = fundsNs(50e9);
  globalThis.gordCorpOfferHold = true;
  globalThis.gordCorpOfferHoldAt = Date.now();
  assert.ok(allZero(boostOrderTargets(ns, BOOSTS, 3)), "discretionary past round 2");
  // Rounds 1-2: the boosts are what the offer is waiting to price.
  globalThis.gordCorpExpandDone = true;
  assert.deepEqual(boostOrderTargets(ns, BOOSTS, 1), BOOSTS);
  assert.deepEqual(boostOrderTargets(ns, BOOSTS, 2), BOOSTS);
  reset();
});

// ── Research: support divisions are not stuck behind the Market-TA bundle ────

test("support divisions shop from a list without the Market-TA bundle", () => {
  const support = researchListFor(false);
  const product = researchListFor(true);
  assert.equal(support[0], "Hi-Tech R&D Laboratory", "the lab is the prerequisite for everything");
  assert.equal(product[0], "Hi-Tech R&D Laboratory");
  for (const r of ["Market-TA.I", "Market-TA.II", "uPgrade: Fulcrum"]) {
    assert.ok(!support.includes(r), `${r} must not gate a material division's stat research`);
  }
  assert.ok(product.includes("Market-TA.II"), "the product division keeps TA.II as its pricing fallback");
  // Same relative order as the product list, so prerequisites still come first.
  const shared = product.filter(r => support.includes(r));
  assert.deepEqual(support, shared);
  assert.ok(support.indexOf("Overclock") < support.indexOf("Sti.mu"));
  assert.ok(support.indexOf("Automatic Drug Administration") < support.indexOf("Go-Juice"));
  assert.ok(support.indexOf("Drones") < support.indexOf("Drones - Assembly"));
});

// ── distributeJobs: no weighted role is left at zero ─────────────────────────

const sum = o => Object.values(o).reduce((a, b) => a + b, 0);
const normalise = w => Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v / sum(w)]));

test("REGRESSION: the round-2 split on a 4-seat office keeps its Engineer", () => {
  // O3/E1/B2/M2 floors to O1/E0/B1/M1 on 4 seats, and the spare seat used to go
  // to the largest weight: O2/E0/B1/M1 - no Engineer in the quality round.
  const jobs = distributeJobs(4, normalise(CO.earlyJobs[2].Agriculture));
  assert.deepEqual(jobs, { Operations: 1, Engineer: 1, Business: 1, Management: 1 });
  // At full size it is still the manual's exact split.
  assert.deepEqual(distributeJobs(8, normalise(CO.earlyJobs[2].Agriculture)),
    { Operations: 3, Engineer: 1, Business: 2, Management: 2 });
});

test("the head-counts always sum to the office, and zero-weight roles stay empty", () => {
  for (const ratios of [CO.jobsMaterialProd, CO.jobsProductMain, CO.jobsProductSupport]) {
    for (const total of [0, 1, 2, 3, 4, 9, 30, 60, 300]) {
      const jobs = distributeJobs(total, ratios);
      assert.equal(sum(jobs), total, `${total} seats`);
      for (const [role, n] of Object.entries(jobs)) {
        assert.ok(n >= 0);
        if (!(ratios[role] > 0)) assert.equal(n, 0, `${role} has no weight`);
      }
    }
  }
  assert.equal(distributeJobs(60, CO.jobsMaterialProd).Business, 0, "Business is useless in a support office");
});

test("the design office always has someone selling", () => {
  // jobsProductMain gives Business ~1%: zero heads at any size under ~90, and
  // Business is a factor of the sales volume in the city every product is made in.
  for (const total of [9, 30, 60]) {
    const jobs = distributeJobs(total, CO.jobsProductMain);
    assert.ok(jobs.Business >= 1, `${total} seats`);
    assert.ok(jobs.Engineer > jobs.Operations, "still the Engineer-heavy progress split");
  }
});

// ── corp-steady: one spend decision per cycle ────────────────────────────────

test("spending happens once a cycle, on START - not on all five states", () => {
  const states = ["START", "PURCHASE", "PRODUCTION", "EXPORT", "SALE"];
  assert.deepEqual(states.filter(isSpendTick), ["START"]);
  assert.equal(isSpendTick(null), false, "a (re)start waits for a real cycle boundary");
});

// ── Product pricing without Market-TA.II ─────────────────────────────────────
//
// The game's sale rule (Division.processSaleState + helpers.calculateMarkupMultiplier):
//   MaxSales/s = Potential * mult,  mult = (L / (P - MP))^2 above MP + L,
//                                          1 between MP and MP + L, MP / P below MP.
// The controller never sees Potential or L - only what getProduct returns.

const P = CO.productPricing;

/** One city of one product, simulated cycle by cycle against the game's rule. */
function market({ mp, potential, limit, production }) {
  const m = { mp, potential, limit, production, stored: 0, price: NaN, step: undefined, sold: 0, revenue: 0 };
  m.cycle = () => {
    // PRODUCTION, then SALE at the price set after the previous cycle.
    m.stored += m.production * 10;
    const price = Number.isFinite(m.price) ? m.price : m.mp; // "MP"
    const mult = price > m.mp + m.limit ? (m.limit / (price - m.mp)) ** 2 : price > m.mp ? 1 : m.mp / price;
    const units = Math.min(m.stored, m.potential * mult * 10);
    m.stored -= units;
    m.sold = units / 10;
    m.revenue = units * price;
    // ...then our once-a-cycle re-price, from exactly the fields getProduct has.
    const next = nextProductPrice(
      { price: m.price, marketPrice: m.mp, stored: m.stored, sold: m.sold, produced: m.production },
      m.step, P,
    );
    m.price = next.price === null ? NaN : next.price;
    m.step = next.step;
  };
  /** The revenue-maximising price for selling `volume`/s: MP + L*sqrt(Potential/volume). */
  m.optimal = volume => m.mp + m.limit * Math.sqrt(m.potential / volume);
  return m;
}

test("from a bare MP it finds the price Market-TA.II would - without seeing the markup", () => {
  // A decent product: can shift 200x what the city makes, markup limit 40x MP.
  const m = market({ mp: 15_000, potential: 2000, limit: 600_000, production: 10 });
  for (let i = 0; i < 25; i++) m.cycle();

  const optimal = m.optimal(m.production);
  assert.ok(optimal > 500 * m.mp, "sanity: the right price is hundreds of times MP");
  assert.ok(Math.abs(m.price - optimal) / optimal < 0.02,
    `settled at ${m.price.toExponential(3)}, optimum ${optimal.toExponential(3)}`);
  // It sells essentially everything it makes, at that price.
  assert.ok(m.sold > m.production * 0.97 && m.sold < m.production * 1.03, `selling ${m.sold}/s of 10/s`);
  assert.ok(m.revenue > 500 * (m.production * 10 * m.mp), "vs. the same units at MP");
  // And the shelf holds only the deliberate sliver, not a growing pile.
  assert.ok(m.stored < m.production * 10 * 0.05, `leftover ${m.stored}`);
});

test("it converges in a handful of cycles and then stays put", () => {
  const m = market({ mp: 15_000, potential: 2000, limit: 600_000, production: 10 });
  let settledAt = -1;
  const optimal = m.optimal(m.production);
  for (let i = 0; i < 40; i++) {
    m.cycle();
    const close = Math.abs(m.price - optimal) / optimal < 0.02;
    if (close && settledAt < 0) settledAt = i;
    if (settledAt >= 0 && i > settledAt + 1) assert.ok(close, `drifted at cycle ${i}: ${m.price}`);
  }
  assert.ok(settledAt >= 0 && settledAt <= 15, `took ${settledAt} cycles`);
});

test("it tracks the potential as Advert and offices raise it", () => {
  const m = market({ mp: 15_000, potential: 2000, limit: 600_000, production: 10 });
  for (let i = 0; i < 25; i++) m.cycle();
  const before = m.price;
  m.potential *= 9; // a few Wilson/Advert levels: the right markup triples
  for (let i = 0; i < 25; i++) m.cycle();
  const optimal = m.optimal(m.production);
  assert.ok(m.price > before * 2.5);
  assert.ok(Math.abs(m.price - optimal) / optimal < 0.02);
  // ...and back down if the market sours (competition rises).
  m.potential /= 20;
  for (let i = 0; i < 25; i++) m.cycle();
  const lower = m.optimal(m.production);
  assert.ok(Math.abs(m.price - lower) / lower < 0.02);
  assert.ok(m.stored < m.production * 10 * 0.5, "the glut from the overpriced cycles was cleared");
});

test("a product nobody wants enough is left at MP, never priced below it", () => {
  // Potential under production: it can't sell everything even with no penalty.
  const m = market({ mp: 15_000, potential: 4, limit: 3000, production: 10 });
  for (let i = 0; i < 30; i++) {
    m.cycle();
    assert.ok(!Number.isFinite(m.price) || m.price >= m.mp, "never a price under MP");
  }
  assert.ok(!Number.isFinite(m.price) || m.price <= m.mp * (1 + P.minMarkup) * 1.5,
    "no markup survives where the market can't clear the shelf");
});

test("the single steps: seed, escalate, measure, restart", () => {
  const mp = 1000;
  // Never priced (NaN), and it sold out: seed a markup.
  assert.deepEqual(
    nextProductPrice({ price: NaN, marketPrice: mp, stored: 0, sold: 10, produced: 10 }, undefined, P),
    { price: mp * (1 + P.seedMarkup), step: P.probeStep },
  );
  // Sold out again at a markup: step up, and step HARDER next time.
  const up = nextProductPrice({ price: 3000, marketPrice: mp, stored: 0, sold: 10, produced: 10 }, P.probeStep, P);
  assert.equal(up.price, mp + 2000 * P.probeStep);
  assert.equal(up.step, P.probeStep ** 2);
  assert.equal(nextProductPrice({ price: 3000, marketPrice: mp, stored: 0, sold: 10, produced: 10 }, 1e9, P).step,
    P.probeStepMax, "the escalation is capped");
  // Stock left over: an exact measurement. Sold 2.5/s at a 2000 markup; to sell
  // the 0.98 * (75/10 + 10) wanted, scale the markup by sqrt(sold / target).
  const fit = nextProductPrice({ price: 3000, marketPrice: mp, stored: 75, sold: 2.5, produced: 10 }, 7, P);
  const target = (75 / 10 + 10) * (1 - P.leftoverTarget);
  assert.ok(Math.abs(fit.price - (mp + 2000 * Math.sqrt(2.5 / target))) < 1e-9);
  assert.equal(fit.step, P.probeStep, "a measurement resets the escalation");
  // Priced clean out of the market (nothing sold): restart from MP.
  assert.equal(nextProductPrice({ price: 1e12, marketPrice: mp, stored: 100, sold: 0, produced: 10 }, 5, P).price, null);
  // No MP yet (the city has never run a SALE for this product): sell at MP.
  assert.equal(nextProductPrice({ price: NaN, marketPrice: 0, stored: 0, sold: 0, produced: 0 }, undefined, P).price, null);
  // Nothing on the shelf and nothing sold: no information - leave the price alone.
  assert.equal(nextProductPrice({ price: 3000, marketPrice: mp, stored: 0, sold: 0, produced: 0 }, undefined, P).price, 3000);
});

test("the pricing knobs are sane", () => {
  assert.ok(P.leftoverTarget > 0 && P.leftoverTarget < 0.2);
  assert.ok(P.probeStep > 1 && P.probeStepMax > P.probeStep);
  assert.ok(P.soldOutFraction > 0 && P.soldOutFraction < P.leftoverTarget,
    "the deliberate leftover must not read as sold out");
  assert.ok(P.seedMarkup > P.minMarkup);
});

// ── corp-expand: objective, office-first floor, unlock order, export order ───

test("the objective is the first candidate the corp can actually reach", () => {
  const HORIZON = CO.savingHorizonSeconds;
  const c = [
    { kind: "founding", cost: 70e9 },
    { kind: "productCity", cost: 0 },   // nothing pending
    { kind: "city", cost: 9e9 },
  ];
  assert.equal(chooseObjective(c, 100e9, 0, HORIZON).kind, "founding", "affordable now, first in priority");
  assert.equal(chooseObjective(c, 5e9, 1e6, HORIZON).kind, "city", "the founding is days out; the city is an hour");
  assert.equal(chooseObjective(c, 5e9, 1e3, HORIZON), null, "nothing reachable: bank for nothing, grow instead");
  assert.equal(chooseObjective([], 1e12, 1e9, HORIZON), null);
});

test("REGRESSION: an objective that was just bought leaves no floor behind", () => {
  // The pass that buys the last city used to leave its $9b floor published for
  // a whole rotation. Re-choosing from the post-purchase state clears it.
  const HORIZON = CO.savingHorizonSeconds;
  const before = [{ kind: "city", cost: 9e9 }];
  assert.equal(chooseObjective(before, 10e9, 1e6, HORIZON)?.cost, 9e9);
  const after = [{ kind: "city", cost: 0 }]; // pendingCityCost is 0 once all six are held
  assert.equal(chooseObjective(after, 1e9, 1e6, HORIZON), null);
});

test("rounds 1-2: the warehouse climb leaves the offices' money alone", () => {
  const now = 5_000_000;
  const need = { round: 2, cost: 44e9, at: now - 30_000 };
  assert.equal(warehouseClimbFloor(need, 2, now, CO), 44e9);
  assert.equal(warehouseClimbFloor({ ...need, cost: 0 }, 2, now, CO), 0, "offices at target: climb freely");
  // The pass right after a round lands: corp-office hasn't spoken for it yet.
  assert.equal(warehouseClimbFloor({ ...need, round: 1 }, 2, now, CO), Infinity,
    "don't spend the new round on warehouses before the offices can ask for any of it");
  assert.equal(warehouseClimbFloor(undefined, 1, now, CO), Infinity);
  // From round 3 the support divisions are a side budget; no floor.
  assert.equal(warehouseClimbFloor(need, CO.officeBeforeWarehouseRound + 1, now, CO), 0);
  assert.equal(warehouseClimbFloor(undefined, 3, now, CO), 0);
});

test("a floor from a phase that has stopped running cannot freeze the climb", () => {
  const now = 5_000_000_000;
  const stale = { round: 2, cost: 44e9, at: now - CO.officeNeedStaleMs - 1 };
  assert.equal(warehouseClimbFloor(stale, 2, now, CO), 0);
  assert.equal(warehouseClimbFloor({ ...stale, round: 1 }, 2, now, CO), 0, "stale beats wrong-round");
});

test("Advert's cost to a target level is the geometric sum from the next price", () => {
  const mult = CO.advertCostMult;
  assert.equal(advertCostToLevel(1e9, 0, 0, mult), 0);
  assert.equal(advertCostToLevel(1e9, 2, 2, mult), 0, "already there");
  assert.equal(advertCostToLevel(1e9, 0, 1, mult), 1e9);
  const toEight = advertCostToLevel(1e9 * mult ** 2, 2, 8, mult); // round 2: level 2 -> 8
  const expected = [2, 3, 4, 5, 6, 7].reduce((s, l) => s + 1e9 * mult ** l, 0);
  assert.ok(Math.abs(toEight - expected) < 1, `${toEight} vs ${expected}`);
  assert.equal(advertCostToLevel(0, 2, 8, mult), 0, "an unreadable price is not a floor");
  assert.equal(advertCostToLevel(Infinity, 2, 8, mult), 0);
});

test("round 2 opens with Export, not Smart Supply", () => {
  assert.deepEqual(optionalUnlockOrder(1), CO.optionalUnlocks);
  assert.equal(optionalUnlockOrder(2)[0], "Export");
  assert.equal(optionalUnlockOrder(4)[0], "Export", "later rounds inherit the latest override");
  assert.deepEqual([...optionalUnlockOrder(2)].sort(), [...CO.optionalUnlocks].sort(), "same set, new order");
});

const AMOUNT = CO.exportAmount;
const route = (division, amount = AMOUNT) => ({ division, city: "Aevum", amount });
const want = division => ({ division, city: "Aevum" });

test("REGRESSION: Tobacco founded after Chemical still gets Agriculture's Plants first", () => {
  // Round 2 created Agriculture -> Chemical. Round 3 founds Tobacco; appending
  // its route leaves Chemical first in a FIFO queue, the reverse of the config.
  const plan = exportPlan([route("Chemical")], [want("Tobacco"), want("Chemical")], AMOUNT);
  assert.deepEqual(plan.cancel, [want("Chemical")]);
  assert.deepEqual(plan.add, [want("Tobacco"), want("Chemical")], "re-created in priority order");
});

test("routes already right are left alone, and a missing tail is just appended", () => {
  const wanted = [want("Tobacco"), want("Chemical")];
  assert.deepEqual(exportPlan([route("Tobacco"), route("Chemical")], wanted, AMOUNT), { cancel: [], add: [] });
  assert.deepEqual(exportPlan([], wanted, AMOUNT), { cancel: [], add: wanted });
  assert.deepEqual(exportPlan([route("Tobacco")], wanted, AMOUNT), { cancel: [], add: [want("Chemical")] });
  // Round 2, before Tobacco exists: only Chemical is wanted, and it is there.
  assert.deepEqual(exportPlan([route("Chemical")], [want("Chemical")], AMOUNT), { cancel: [], add: [] });
});

test("a stale amount is rebuilt, and hand-made routes are never touched", () => {
  const wanted = [want("Tobacco"), want("Chemical")];
  const stale = exportPlan([route("Tobacco", "MAX"), route("Chemical")], wanted, AMOUNT);
  assert.deepEqual(stale.cancel, wanted);
  assert.deepEqual(stale.add, wanted);
  // A route to some other division (or another city) isn't ours to manage.
  const mine = [route("Restaurant"), { division: "Tobacco", city: "Ishima", amount: AMOUNT }, route("Tobacco"), route("Chemical")];
  assert.deepEqual(exportPlan(mine, wanted, AMOUNT), { cancel: [], add: [] });
});

// ── corp-daemon: a starved build phase says so ───────────────────────────────

test("a build phase that can't be placed is reported, then periodically", () => {
  let misses = {};
  const warned = [];
  for (let slot = 1; slot <= 7; slot++) {
    const r = notePhaseSlot(misses, "corpExpand", false, 3);
    misses = r.misses;
    if (r.warn) warned.push(slot);
  }
  assert.deepEqual(warned, [3, 6], "on the 3rd miss and every 3rd after - not every tick");
  assert.equal(misses.corpExpand, 7);

  const ok = notePhaseSlot(misses, "corpExpand", true, 3);
  assert.equal(ok.warn, false);
  assert.equal(ok.misses.corpExpand, 0, "one successful placement clears the streak");

  // Phases are tracked independently.
  const other = notePhaseSlot({ corpExpand: 2 }, "corpOffice", false, 3);
  assert.deepEqual(other.misses, { corpExpand: 2, corpOffice: 1 });
  assert.equal(other.warn, false);
  assert.ok(CO.phaseMissWarnRotations >= 2, "one missed slot is routine, not a warning");
});

// ── corp-upkeep: a refused top-up is not a top-up ────────────────────────────

/** A corp with one tired 4-seat office; the game refuses purchases when broke. */
function upkeepNs({ funds }) {
  const calls = { tea: 0, party: 0 };
  const office = { numEmployees: 4, avgEnergy: 70, avgMorale: 70, maxEnergy: 100, maxMorale: 100, employeeJobs: {} };
  const ns = {
    print: () => {},
    format: { number: n => String(n) },
    corporation: {
      getCorporation: () => ({ funds, divisions: ["Agriculture"] }),
      getOffice: (_d, city) => {
        if (city !== "Sector-12") throw new Error("not expanded");
        return office;
      },
      // Actions.ts: both RETURN (false / 0) when corp.funds < cost - no throw.
      buyTea: () => { calls.tea++; return funds >= 500e3 * office.numEmployees; },
      throwParty: (_d, _c, cost) => { calls.party++; return funds >= cost * office.numEmployees ? 1 + cost / 10e6 : 0; },
    },
  };
  return { ns, calls };
}

test("REGRESSION: a corp in debt does not report tea and parties it never got", () => {
  reset();
  const { ns, calls } = upkeepNs({ funds: -31e9 }); // round-1 boost debt
  upkeepPass(ns);
  const s = globalThis.gordCorpUpkeep;
  assert.deepEqual([calls.tea, calls.party], [1, 1], "it does try");
  assert.equal(s.teasThisCycle, 0, "buyTea returned false - that is not a tea");
  assert.equal(s.partiesThisCycle, 0);
  assert.equal(s.spendThisCycle, 0);
  assert.equal(s.blockedThisCycle, 2);
  assert.equal(s.allTopped, false, "'nothing bought' must not read as 'nothing needed'");
  reset();
});

test("a solvent corp's top-ups are counted as before", () => {
  reset();
  const { ns } = upkeepNs({ funds: 50e9 });
  upkeepPass(ns);
  const s = globalThis.gordCorpUpkeep;
  assert.equal(s.teasThisCycle, 1);
  assert.equal(s.partiesThisCycle, 1);
  assert.ok(s.spendThisCycle > 0);
  assert.equal(s.blockedThisCycle, 0);
  reset();
});

// ── Config ───────────────────────────────────────────────────────────────────

test("material sizes are the game's (MaterialInfo.ts)", () => {
  const game = {
    Water: 0.05, Ore: 0.01, Minerals: 0.04, Food: 0.03, Plants: 0.05, Metal: 0.1,
    Hardware: 0.06, Chemicals: 0.05, Drugs: 0.02, Robots: 0.5, "AI Cores": 0.1, "Real Estate": 0.005,
  };
  assert.deepEqual(CO.materialSize, game);
});
