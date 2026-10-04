// tests/stocks-logic.test.mjs
// Unit tests for the stock trader: the pure logic (lib/stocks-logic.js) and the
// Netscript shell's step() (lib/stocks.js), both against tests/helpers/
// fake-market.mjs - a transcription of the game's market from bitburner-src.
// Run: npm test  (needs Node >=20).
//
// The last test is the end-to-end scenario: lib/stocks.js trading the fake
// market from BN8's $250m for a simulated day, with and without 4S data. It
// prints what it measured (node --test shows it as diagnostics); the README's
// BN8 section quotes the same figures over more seeds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeMarket, MARKET, STOCK_METADATA, CYCLE_FLIP_CHANCE } from "./helpers/fake-market.mjs";
import {
  TICKS_PER_CYCLE,
  STOCK_SERVERS,
  newEstimator,
  observe,
  estimateOf,
  cycleInfo,
  expectedReturn,
  positionValue,
  portfolioWorth,
  planTrades,
  tradingRate,
  fourSPaybackTicks,
  fourSWorthIt,
  fourSCostMults,
  influenceWishes,
  allowanceStep,
  liveTrader,
  treasuryStep,
} from "../lib/stocks-logic.js";
import { step, newTrader } from "../lib/stocks.js";
import { CONFIG, BITNODE, forNode } from "../lib/config.js";

const S = CONFIG.stocks;
const BN8 = forNode(8).stocks;
const COMMISSION = S.commission;

/** globalThis is the trader's bus; every test starts with a clean one. */
function resetGlobals() {
  for (const k of Object.keys(globalThis)) if (k.startsWith("gord")) delete globalThis[k];
}

/** A stock as planTrades sees it. Spread 0.5% each side unless told otherwise. */
function view(sym, o = {}) {
  const price = o.price ?? 1000;
  const spread = o.spread ?? 0.005;
  return {
    sym, price, ask: price * (1 + spread), bid: price * (1 - spread),
    maxShares: o.maxShares ?? 1e7,
    longShares: o.longShares ?? 0, longAvg: o.longAvg ?? price,
    shortShares: o.shortShares ?? 0, shortAvg: o.shortAvg ?? price,
    p: o.p ?? 0.5, up: o.up ?? (o.p > 0.5 ? 1 : o.p < 0.5 ? 0 : 0.5),
    move: o.move ?? 0.005, seen: o.seen ?? 1000,
  };
}
const account = (o = {}) => ({
  cash: 250e6, reserve: 0, hold: 0, canShort: true, exact: true, ticksToCycle: 40, liquidate: false, ...o,
});
const ordersFor = (plan, sym) => plan.orders.filter(o => o.sym === sym);

// ── 0GB ──────────────────────────────────────────────────────────────────────

test("lib/stocks-logic.js names no Netscript function, so importing it costs no RAM", () => {
  // Bitburner bills static RAM by identifier NAME: `row.sellShort` or `cfg.share`
  // in a pure module costs what ns.stock.sellShort / ns.share cost, in every
  // script that imports it (bn8/daemon.js imports this one). Both of those were
  // in the first draft. Every ns.stock function, and the everyday words that
  // are also Netscript functions.
  const billed = [
    "getSymbols", "getPrice", "getAskPrice", "getBidPrice", "getPosition", "getMaxShares", "getOrganization",
    "getPurchaseCost", "getSaleGain", "buyStock", "sellStock", "buyShort", "sellShort", "placeOrder", "cancelOrder",
    "getOrders", "getVolatility", "getForecast", "purchase4SMarketData", "purchase4SMarketDataTixApi",
    "purchaseWseAccount", "purchaseTixApi", "hasWseAccount", "hasTixApiAccess", "has4SData", "has4SDataTixApi",
    "hack", "grow", "weaken", "share", "exec", "run", "spawn", "kill", "killall", "scan", "nuke", "scp", "ls", "ps",
    "rm", "mv", "wget", "read", "write", "clear", "peek", "getPlayer", "getServer", "getResetInfo", "travel",
    "purchase", "connect", "research", "attempt", "probe", "cheat", "bribe", "heartbleed", "exploit", "bypass",
    "getStats", "getOpponent", "getTask", "getRank", "getCity", "getData", "getDescription", "getContract",
  ];
  const source = readFileSync(new URL("../lib/stocks-logic.js", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/`[^`$]*`/g, "``");
  const used = new Set(source.match(/[A-Za-z_$][\w$]*/g));
  assert.deepEqual(billed.filter(name => used.has(name)), []);
  assert.ok(!/\bns\s*\./.test(source), "no ns.* call at all");
});

// ── The fake market is the game's market ─────────────────────────────────────

test("fake market: metadata covers every stock, and every server mapping agrees with the trader's", () => {
  assert.equal(STOCK_METADATA.length, 33);
  for (const m of STOCK_METADATA) {
    assert.equal(STOCK_SERVERS[m.sym] ?? null, m.host, `${m.sym} -> ${m.host}`);
  }
  assert.equal(STOCK_SERVERS.WDS, undefined, "Watchdog Security has no server");
  assert.equal(TICKS_PER_CYCLE, MARKET.TicksPerCycle);
});

test("fake market: one volatility draw per tick is shared by every stock", () => {
  const m = makeMarket({ seed: 3 });
  for (let t = 0; t < 20; t++) {
    const before = m.stocks.map(s => s.price);
    m.tick();
    // |log return| / mv is the same v for all of them.
    const vs = m.stocks.map((s, i) => (Math.exp(Math.abs(Math.log(s.price / before[i]))) - 1) / (s.mv / 100));
    for (const v of vs) assert.ok(Math.abs(v - vs[0]) < 1e-9);
    assert.ok(vs[0] >= 0 && vs[0] < 1);
  }
});

test("fake market: cycles come every 75 ticks and mirror ~45% of forecasts", () => {
  let flips = 0, chances = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const m = makeMarket({ seed });
    const first = m.ticksUntilCycle;
    assert.ok(first >= 1 && first <= 75);
    for (let t = 0; t < 600; t++) {
      const before = m.stocks.map(s => ({ b: s.b, f: s.getAbsoluteForecast(), ff: s.otlkMagForecast }));
      const wasCycle = m.ticksUntilCycle === 1;
      m.tick();
      if (!wasCycle) continue;
      m.stocks.forEach((s, i) => {
        chances++;
        // A mirrored second-order forecast is the unambiguous trace of a flip
        // (the forecast itself also takes its ordinary step in the same tick).
        if (Math.abs(s.otlkMagForecast - (100 - before[i].ff)) < Math.abs(s.otlkMagForecast - before[i].ff)) flips++;
      });
    }
    assert.deepEqual(m.cycleTicks.slice(0, 3), [first, first + 75, first + 150]);
  }
  const rate = flips / chances;
  assert.ok(Math.abs(rate - CYCLE_FLIP_CHANCE) < 0.06, `flip rate ${rate.toFixed(3)}`);
});

test("fake market: transactions pay the spread and the commission, and respect maxShares", () => {
  const m = makeMarket({ seed: 5, money: 1e12 });
  const s = m.bySymbol.get("ECP");
  const ask = s.getAskPrice(), bid = s.getBidPrice();
  assert.ok(ask > s.price && bid < s.price);
  assert.ok(Math.abs((ask + bid) / 2 - s.price) < 1e-6, "the spread is symmetric: bid = 2 x price - ask");

  let before = m.player.money;
  assert.equal(m.ns.stock.buyStock("ECP", 1000), ask);
  assert.ok(Math.abs(before - m.player.money - (1000 * ask + COMMISSION)) < 1e-3);
  before = m.player.money;
  assert.equal(m.ns.stock.sellStock("ECP", 1000), bid);
  assert.ok(Math.abs(m.player.money - before - (1000 * bid - COMMISSION)) < 1e-3);

  // A short opens at the BID and closes at the ASK.
  before = m.player.money;
  assert.equal(m.ns.stock.buyShort("ECP", 1000), bid);
  assert.ok(Math.abs(before - m.player.money - (1000 * bid + COMMISSION)) < 1e-3);
  before = m.player.money;
  m.ns.stock.sellShort("ECP", 1000);
  assert.ok(Math.abs(m.player.money - before - (1000 * (2 * bid - ask) - COMMISSION)) < 1e-3);

  // Long and short share one cap.
  assert.ok(m.ns.stock.buyStock("ECP", s.maxShares - 10) > 0);
  assert.equal(m.ns.stock.buyShort("ECP", 11), 0);
  assert.ok(m.ns.stock.buyShort("ECP", 10) > 0);
});

test("fake market: trading erodes the forecast (never below otlkMag 5), not the price", () => {
  const m = makeMarket({ seed: 5, money: 1e13 });
  const s = m.bySymbol.get("ECP");
  const price = s.price, mag = s.otlkMag;
  m.buyLong("ECP", s.maxShares);
  assert.equal(s.price, price, "a transaction does not move the price");
  const expected = 0.006 * (1 + Math.ceil((s.maxShares - s.shareTxForMovement) / s.shareTxForMovement));
  assert.ok(Math.abs(mag - s.otlkMag - expected) < 0.02, `otlkMag fell ${mag - s.otlkMag}, expected ~${expected}`);
  for (let i = 0; i < 30; i++) { m.sellLong("ECP", s.maxShares); m.buyLong("ECP", s.maxShares); }
  assert.equal(s.otlkMag, 5);
});

test("fake market: hack/grow influence moves the second-order forecast by 0.1 per success", () => {
  const m = makeMarket({ seed: 7 });
  const s = m.byHost.get("joesguns");
  const before = s.otlkMagForecast;
  let hits = 0;
  for (let i = 0; i < 400; i++) if (m.influence("grow", "joesguns", 0.5)) hits++;
  assert.ok(hits > 150 && hits < 250, `${hits} of 400 at 50%`);
  assert.ok(Math.abs(s.otlkMagForecast - Math.min(100, before + hits * 0.1)) < 1e-9);
  assert.equal(m.influence("grow", "n00dles", 1), false, "a server without a stock is a no-op");
});

// ── Estimator ────────────────────────────────────────────────────────────────

/** Run the estimator over a market; collect accuracy against the true forecasts. */
function scoreEstimator(seed, ticks, warmup) {
  const m = makeMarket({ seed });
  const est = newEstimator(S.estimator);
  const history = new Map(m.stocks.map(s => [s.symbol, []]));
  const last = new Map();
  const r = { n: 0, err: 0, errBase: 0, signN: 0, signOk: 0, signOkBase: 0, sureN: 0, sureOk: 0, m, est };
  for (let t = 0; t < ticks; t++) {
    if (t > 0) m.tick();
    observe(est, m.stocks.map(s => [s.symbol, s.price]));
    for (const s of m.stocks) {
      const h = history.get(s.symbol);
      if (last.has(s.symbol)) h.push(s.price > last.get(s.symbol) ? 1 : 0);
      last.set(s.symbol, s.price);
      if (t < warmup) continue;
      const truth = s.getAbsoluteForecast() / 100;
      const e = estimateOf(est, s.symbol);
      // The usual pre-4S estimator, for comparison: the up-fraction of a 75-tick
      // window, mirrored when a 10-tick window sits clearly nearer the mirror.
      const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
      const long = mean(h.slice(-75)), short = mean(h.slice(-10));
      const base = Math.abs(long - 0.5) > 0.05 && Math.abs(short - (1 - long)) < Math.abs(short - long) - 0.1 ? 1 - long : long;
      r.n++;
      r.err += Math.abs(e.p - truth);
      r.errBase += Math.abs(base - truth);
      if (Math.abs(truth - 0.5) >= 0.05) {
        r.signN++;
        if ((e.p > 0.5) === (truth > 0.5)) r.signOk++;
        if ((base > 0.5) === (truth > 0.5)) r.signOkBase++;
      }
      if (e.up >= S.entryConfidence || e.up <= 1 - S.entryConfidence) {
        r.sureN++;
        if ((e.up > 0.5) === (truth > 0.5)) r.sureOk++;
      }
    }
  }
  return r;
}

test("estimator: tracks the true forecasts, and beats the windowed up-tick count", t => {
  let n = 0, err = 0, errBase = 0, signN = 0, signOk = 0, signOkBase = 0, sureN = 0, sureOk = 0;
  for (const seed of [1, 2, 3]) {
    const r = scoreEstimator(seed, 1200, 150);
    n += r.n; err += r.err; errBase += r.errBase;
    signN += r.signN; signOk += r.signOk; signOkBase += r.signOkBase;
    sureN += r.sureN; sureOk += r.sureOk;
  }
  const mae = err / n, maeBase = errBase / n;
  const sign = signOk / signN, signBase = signOkBase / signN, sure = sureOk / sureN;
  t.diagnostic(`forecast MAE ${mae.toFixed(4)} (windowed ${maeBase.toFixed(4)}); ` +
    `direction right ${(sign * 100).toFixed(1)}% (windowed ${(signBase * 100).toFixed(1)}%) where |edge| >= 5 points; ` +
    `${(sure * 100).toFixed(1)}% right when confident enough to trade (${(sureN / n * 100).toFixed(0)}% of the time)`);
  assert.ok(mae < 0.05, `MAE ${mae}`);
  assert.ok(mae < maeBase * 0.75, `MAE ${mae} vs windowed ${maeBase}`);
  assert.ok(sign > 0.8, `direction accuracy ${sign}`);
  assert.ok(sign > signBase + 0.05, `direction accuracy ${sign} vs windowed ${signBase}`);
  // The confidence it trades on has to mean what it says.
  assert.ok(sure > 0.93, `right ${sure} of the time at >= ${S.entryConfidence} confidence`);
});

test("estimator: finds the market cycle from prices alone", () => {
  let found = 0;
  for (const seed of [1, 2, 3, 4]) {
    const { m, est } = scoreEstimator(seed, 700, Infinity);
    const c = cycleInfo(est);
    if (c.confidence > 0.5 && Math.abs(c.ticksToCycle - m.ticksUntilCycle) < 1.5) found++;
  }
  assert.ok(found >= 3, `phase found in ${found} of 4 markets after 700 ticks`);
});

test("estimator: a fresh one knows nothing, and says so", () => {
  const est = newEstimator(S.estimator);
  assert.deepEqual(estimateOf(est, "ECP"), { p: 0.5, up: 0.5, absEdge: 0, posEdge: 0, move: 0, seen: 0 });
  observe(est, [["ECP", 100]]);
  const e = estimateOf(est, "ECP");
  assert.equal(e.seen, 0);
  assert.ok(Math.abs(e.p - 0.5) < 1e-9 && Math.abs(e.up - 0.5) < 1e-9);
  const c = cycleInfo(est);
  assert.ok(Math.abs(c.confidence - 1 / 75) < 1e-9);
  assert.ok(Math.abs(c.ticksToCycle - 38) < 1e-6, "uniform over 1..75");
});

test("estimator: a run of up-ticks moves the forecast up; a mirrored run brings it back down", () => {
  const est = newEstimator(S.estimator);
  let price = 100;
  const feed = (ups, of) => {
    for (let i = 0; i < of; i++) {
      price *= i % of < ups ? 1.01 : 1 / 1.01;
      observe(est, [["X", price]]);
    }
  };
  observe(est, [["X", price]]);
  for (let i = 0; i < 12; i++) feed(4, 5); // 80% up for 60 ticks
  const bull = estimateOf(est, "X");
  // Not certainty: with the cycle's place unknown, any recent tick could have
  // been a mirror, and the last one of each five here was a down-tick.
  assert.ok(bull.p > 0.68 && bull.up > 0.9, `p ${bull.p}, up ${bull.up}`);
  assert.ok(Math.abs(bull.move - Math.log(1.01)) < 1e-9, "move = mean |log return|");
  assert.ok(bull.absEdge >= Math.abs(2 * bull.p - 1) - 1e-9, "E|2p-1| >= |2E[p]-1|");
  for (let i = 0; i < 8; i++) feed(1, 5);  // 20% up for 40 ticks
  const bear = estimateOf(est, "X");
  assert.ok(bear.p < 0.4 && bear.up < 0.2, `p ${bear.p}, up ${bear.up}`);
});

// ── Returns and values ───────────────────────────────────────────────────────

test("expectedReturn / positionValue / portfolioWorth", () => {
  assert.ok(Math.abs(expectedReturn(0.6, 0.005) - 0.001) < 1e-12);
  assert.ok(Math.abs(expectedReturn(0.4, 0.005) + 0.001) < 1e-12);
  const s = { bid: 99, ask: 101, longShares: 10, shortShares: 20, shortAvg: 110 };
  assert.deepEqual(positionValue(s), { long: 990, short: 20 * (2 * 110 - 101) });
  assert.equal(portfolioWorth([s], 1000, 5), 1000 + 990 - 5 + 2380 - 5);
  assert.equal(portfolioWorth([{ ...s, longShares: 0, shortShares: 0 }], 1000, 5), 1000);
});

// ── Planner ──────────────────────────────────────────────────────────────────

test("planner: ranks by expected return (edge x volatility), not by forecast", () => {
  const plan = planTrades([
    view("CALM", { p: 0.70, move: 0.002 }),   // 0.4 x 0.002 = 0.0008 a tick
    view("WILD", { p: 0.60, move: 0.010 }),   // 0.2 x 0.010 = 0.0020 a tick
  ], account(), BN8);
  assert.equal(plan.orders.length, 1);
  assert.equal(plan.orders[0].sym, "WILD");
  assert.equal(plan.orders[0].action, "buy");
});

test("planner: sizes to the cash, the share cap and the per-stock ratio", () => {
  const stocks = [view("A", { p: 0.65, move: 0.01, maxShares: 1e5 }), view("B", { p: 0.62, move: 0.01 })];
  // Share cap: 1e5 shares of A, the rest goes to B.
  let plan = planTrades(stocks, account(), BN8);
  assert.equal(ordersFor(plan, "A")[0].shares, 1e5);
  const b = ordersFor(plan, "B")[0];
  const spent = 1e5 * stocks[0].ask + b.shares * stocks[1].ask + 2 * COMMISSION;
  assert.ok(spent <= 250e6 && spent > 250e6 - stocks[1].ask, "everything invested, nothing overdrawn");

  // The default 30% ratio: no stock gets more than 30% of net worth.
  plan = planTrades([view("A", { p: 0.65, move: 0.01 }), view("B", { p: 0.62, move: 0.01 })], account(), S);
  for (const o of plan.orders) assert.ok(o.shares * 1005 <= 0.30 * 250e6 + 1005);
  assert.equal(plan.orders.length, 2);

  // A reserve is not spent; held shares count against the cap, both sides.
  plan = planTrades([view("A", { p: 0.65, move: 0.01 })], account({ reserve: 200e6 }), BN8);
  assert.ok(plan.orders[0].shares * 1005 + COMMISSION <= 50e6);
  plan = planTrades([view("A", { p: 0.65, move: 0.01, maxShares: 1000, longShares: 400 })], account(), S);
  assert.equal(plan.orders.length, 0, "600 shares of room is under the minimum order");
});

test("planner: the spread and the commission are costs an entry has to earn back", () => {
  // 0.2 x 0.005 = 0.001/tick over 40 + 30 ticks = 7%: worth a 1% round trip...
  let plan = planTrades([view("A", { p: 0.6, spread: 0.005 })], account(), BN8);
  assert.equal(plan.orders.length, 1);
  // ...not a 4% one (entryCostMult x 4% > 7%).
  plan = planTrades([view("A", { p: 0.6, spread: 0.02 })], account(), BN8);
  assert.equal(plan.orders.length, 0);
  // ...and not with one tick left before the cycle and nothing held after it.
  plan = planTrades([view("A", { p: 0.6, spread: 0.005 })], account({ ticksToCycle: 1 }), { ...BN8, holdTicksAfterCycle: 0 });
  assert.equal(plan.orders.length, 0);
  // Too little cash for the commissions to be worth it.
  plan = planTrades([view("A", { p: 0.6 })], account({ cash: 1.5e6 }), BN8);
  assert.equal(plan.orders.length, 0);
});

test("planner: shorts where the node allows them, and only there", () => {
  const stocks = [view("DOWN", { p: 0.30, move: 0.01 })];
  let plan = planTrades(stocks, account(), BN8);
  assert.equal(plan.orders[0].action, "short");
  assert.ok(plan.summary.expectedIncome > 0, "a short on a falling stock expects to earn");
  plan = planTrades(stocks, account({ canShort: false }), BN8);
  assert.equal(plan.orders.length, 0);
  // A short held where shorting has gone away is closed.
  plan = planTrades([view("DOWN", { p: 0.30, shortShares: 1000 })], account({ canShort: false }), BN8);
  assert.equal(plan.orders[0].action, "cover");
});

test("planner: without 4S, direction must be likely enough - more so for a short", () => {
  const est = o => view("X", { move: 0.01, ...o });
  const a = account({ exact: false });
  // Long: needs up >= entryConfidence and minObservations.
  assert.equal(planTrades([est({ p: 0.62, up: 0.80 })], a, BN8).orders.length, 0);
  assert.equal(planTrades([est({ p: 0.62, up: 0.92 })], a, BN8).orders[0].action, "buy");
  assert.equal(planTrades([est({ p: 0.62, up: 0.92, seen: 5 })], a, BN8).orders.length, 0);
  // Short: 92% sure it is falling is enough for a long's bar, not a short's.
  assert.ok(BN8.entryConfidenceShort > BN8.entryConfidence);
  assert.equal(planTrades([est({ p: 0.38, up: 0.08 })], a, BN8).orders.length, 0);
  assert.equal(planTrades([est({ p: 0.38, up: 0.03 })], a, BN8).orders[0].action, "short");
});

test("planner: exits on a turned forecast - at once with 4S, on likelihood without", () => {
  const held = o => view("X", { longShares: 1000, ...o });
  // 4S: below 50% is a fact.
  let plan = planTrades([held({ p: 0.49 })], account(), BN8);
  assert.deepEqual(plan.orders.map(o => o.action), ["sell"]);
  assert.equal(plan.orders[0].shares, 1000);
  assert.equal(planTrades([held({ p: 0.51 })], account(), BN8).orders.length, 0);
  // Estimate: the mean dipping under 50% is not enough; the direction being
  // more likely wrong than exitConfidence allows is.
  const a = account({ exact: false });
  assert.equal(planTrades([held({ p: 0.49, up: 0.45 })], a, BN8).orders.length, 0);
  plan = planTrades([held({ p: 0.47, up: 0.30 })], a, BN8);
  assert.deepEqual(plan.orders.map(o => o.action), ["sell"]);
  // A short is covered the same way, mirrored.
  plan = planTrades([view("X", { shortShares: 1000, p: 0.53, up: 0.70 })], a, BN8);
  assert.deepEqual(plan.orders.map(o => o.action), ["cover"]);
  // With 4S a clear reversal is traded as one: out of the long, into the short.
  plan = planTrades([held({ p: 0.30, move: 0.01 })], account(), BN8);
  assert.deepEqual(plan.orders.map(o => o.action), ["sell", "short"]);
});

test("planner: a holding is replaced only by something better by a margin", () => {
  const cash = 1e6;
  const holding = view("OLD", { p: 0.60, move: 0.005, longShares: 200_000 }); // 0.001/tick
  // A little better is not worth the swap...
  let plan = planTrades([holding, view("NEW", { p: 0.62, move: 0.005 })], account({ cash }), BN8);
  assert.equal(plan.orders.length, 0);
  // ...twice as good is.
  plan = planTrades([holding, view("NEW", { p: 0.70, move: 0.005 })], account({ cash }), BN8);
  assert.deepEqual(plan.orders.map(o => `${o.action} ${o.sym}`), ["sell OLD", "buy NEW"]);
  assert.match(plan.orders[0].why, /replaced by NEW/);
  // Estimates need a wider margin than facts.
  assert.ok(BN8.replaceMargin > BN8.replaceMarginExact);
});

test("planner: cash that must be there is raised from the WORST position; a reserve is not", () => {
  const stocks = [
    view("GOOD", { p: 0.70, longShares: 100_000, maxShares: 100_000 }),
    view("POOR", { p: 0.52, longShares: 100_000, maxShares: 100_000 }),
  ];
  // hold: sell enough of POOR to have $30m.
  let plan = planTrades(stocks, account({ cash: 1e6, hold: 30e6 }), BN8);
  assert.equal(plan.orders.length, 1);
  assert.equal(plan.orders[0].sym, "POOR");
  assert.equal(plan.orders[0].why, "raise cash");
  const raised = plan.orders[0].shares * stocks[1].bid - COMMISSION;
  assert.ok(raised >= 29e6 && raised < 29e6 + stocks[1].bid + 1, "just enough");
  // A stub too small to be worth its own commission later is sold with it.
  plan = planTrades(stocks, account({ cash: 1e6, hold: 99e6 }), BN8);
  assert.equal(plan.orders[0].shares, 100_000);
  // More than POOR is worth: GOOD is next.
  plan = planTrades(stocks, account({ cash: 1e6, hold: 150e6 }), BN8);
  assert.deepEqual(plan.orders.map(o => o.sym), ["POOR", "GOOD"]);
  // reserve: the same $30m as a RATIO is never sold for.
  plan = planTrades(stocks, account({ cash: 1e6, reserve: 30e6 }), BN8);
  assert.equal(plan.orders.length, 0);

  // What was just sold for cash is not bought back in the same tick, and a
  // position sold in two steps (cash, then a replacement) is ONE order - one
  // commission.
  const roomy = [view("GOOD", { p: 0.70, longShares: 100_000 }), view("POOR", { p: 0.52, longShares: 100_000 })];
  plan = planTrades(roomy, account({ cash: 1e6, hold: 30e6 }), BN8);
  assert.equal(ordersFor(plan, "POOR").length, 1);
  assert.equal(ordersFor(plan, "POOR")[0].shares, 100_000, "the rest of POOR went to more of GOOD");
  assert.deepEqual(plan.orders.map(o => `${o.action} ${o.sym}`), ["sell POOR", "buy GOOD"]);
});

test("planner: liquidate sells everything and buys nothing", () => {
  const plan = planTrades([
    view("A", { p: 0.7, longShares: 500 }),
    view("B", { p: 0.3, shortShares: 300 }),
    view("C", { p: 0.7 }),
  ], account({ liquidate: true }), BN8);
  assert.deepEqual(plan.orders.map(o => `${o.action} ${o.sym} ${o.shares}`).sort(), ["cover B 300", "sell A 500"]);
});

// ── 4S ───────────────────────────────────────────────────────────────────────

test("4S: tradingRate fills the best stocks first, up to their caps", () => {
  const items = [{ edge: 0.002, cap: 100 }, { edge: 0.001, cap: 100 }, { edge: -1, cap: 1e9 }];
  assert.ok(Math.abs(tradingRate(50, items) - 0.002) < 1e-12);
  assert.ok(Math.abs(tradingRate(200, items) - 0.0015) < 1e-12);
  assert.ok(Math.abs(tradingRate(400, items) - 0.3 / 400) < 1e-12, "the rest sits idle");
  assert.equal(tradingRate(0, items), 0);
});

test("4S: the payback, and the point where buying starts to beat waiting", () => {
  const cost = 25e9, without = 0.0015, withData = 0.0019;
  // (W - C)(1 + r1)^T = W (1 + r0)^T
  const T = fourSPaybackTicks(100e9, cost, without, withData);
  assert.ok(Math.abs(75e9 * (1 + withData) ** T - 100e9 * (1 + without) ** T) < 1);
  assert.equal(fourSPaybackTicks(20e9, cost, without, withData), Infinity, "can't afford it");
  assert.equal(fourSPaybackTicks(100e9, cost, withData, without), Infinity, "the data adds nothing");

  // Worth it from W* = C x r1 / (r1 - r0) on: what is left earns more per tick
  // than the whole did.
  const wStar = cost * withData / (withData - without); // ~$119b
  assert.equal(fourSWorthIt(wStar * 0.98, cost, without, withData), false);
  assert.equal(fourSWorthIt(wStar * 1.02, cost, without, withData), true);
  assert.equal(fourSWorthIt(1e15, cost, withData, without), false);
  // At W* the payback is about one e-folding time of the capital.
  const atStar = fourSPaybackTicks(wStar, cost, without, withData);
  assert.ok(atStar > 0.8 / withData && atStar < 1.2 / without, `${atStar} ticks`);
  // And W* is where the long-run outcome peaks: buying there beats both sooner and later.
  const outcome = buyAt => {
    let w = 30e9, bought = false;
    for (let t = 0; t < 6000; t++) {
      if (!bought && w >= buyAt) { w -= cost; bought = true; }
      w *= 1 + (bought ? withData : without);
    }
    return w;
  };
  assert.ok(outcome(wStar) > outcome(wStar * 0.5));
  assert.ok(outcome(wStar) > outcome(wStar * 2));
});

// ── Manipulation wishes ──────────────────────────────────────────────────────

test("wishes: grows for what we are long, hacks for what we are short, most valuable first", () => {
  const stocks = [
    { sym: "JGN", longValue: 5e9, shortValue: 0, p: 0.8, up: 1, move: 0.014 },
    { sym: "FNS", longValue: 9e9, shortValue: 0, p: 0.7, up: 1, move: 0.004 },
    { sym: "SGC", longValue: 0, shortValue: 2e9, p: 0.2, up: 0, move: 0.01 },
    { sym: "WDS", longValue: 1e9, shortValue: 0, p: 0.7, up: 1, move: 0.012 }, // no server
    { sym: "ECP", longValue: 0, shortValue: 0, p: 0.69, up: 1, move: 0.002 },  // not held
  ];
  const w = influenceWishes(stocks, { canShort: true }, S.manipulation);
  assert.deepEqual(w.up, ["joesguns", "foodnstuff"]);   // 5e9 x 0.014 > 9e9 x 0.004
  assert.deepEqual(w.down, ["sigma-cosmetics"]);
  assert.deepEqual(influenceWishes(stocks, { canShort: true }, { ...S.manipulation, enabled: false }), { up: [], down: [] });
});

test("wishes: with pump on, unheld stocks are listed too - held ones first", () => {
  assert.equal(S.manipulation.pump, false);
  assert.equal(BN8.manipulation.pump, true);
  const stocks = [
    { sym: "JGN", longValue: 0, shortValue: 0, p: 0.5, up: 0.5, move: 0.014 },
    { sym: "FNS", longValue: 1e6, shortValue: 0, p: 0.6, up: 0.9, move: 0.004 },
    { sym: "SGC", longValue: 0, shortValue: 0, p: 0.3, up: 0.05, move: 0.01 },
    { sym: "NTLK", longValue: 0, shortValue: 0, p: 0.3, up: 0.05, move: 0.015 },
  ];
  let w = influenceWishes(stocks, { canShort: true }, BN8.manipulation);
  assert.deepEqual(w.up, ["foodnstuff", "joesguns"]);
  assert.deepEqual(w.down, ["netlink", "sigma-cosmetics"], "clearly falling and shortable: push it further");
  // No shorting: everything not held is pushed up.
  w = influenceWishes(stocks, { canShort: false }, BN8.manipulation);
  assert.deepEqual(w.down, []);
  assert.equal(w.up.length, 4);
});

// ── Treasury ─────────────────────────────────────────────────────────────────

test("treasury: a dividend of new highs, debited by what is spent", () => {
  const cfg = { ...S.treasury, startFraction: 0.05, payout: 0.25, payoutPre4S: 0.10, capFraction: 0.10 };
  const o = (netWorth, outflow, extra = {}) => ({ netWorth, outflow, has4S: false, idleCash: 0, ...extra });
  let p = allowanceStep(null, o(250e6, 0), cfg);
  assert.equal(p.wanted, 12.5e6, "the opening grant");
  // $100m of profit before 4S: 10% of it.
  p = allowanceStep(p, o(350e6, 0), cfg);
  assert.ok(Math.abs(p.bucket - 22.5e6) < 1);
  // A drawdown pays nothing, and neither does climbing back to the old high.
  p = allowanceStep(p, o(300e6, 0), cfg);
  p = allowanceStep(p, o(350e6, 0), cfg);
  assert.ok(Math.abs(p.bucket - 22.5e6) < 1);
  // Spending $20m: the bucket is debited, and net worth falling by the same
  // $20m is not a loss (gross wealth is unchanged).
  p = allowanceStep(p, o(330e6, 20e6), cfg);
  assert.ok(Math.abs(p.bucket - 2.5e6) < 1);
  p = allowanceStep(p, o(340e6, 20e6), cfg);
  assert.ok(Math.abs(p.bucket - 3.5e6) < 1, "10% of the $10m above the old gross high");
  // With 4S the payout is the larger one; the bucket is capped at 10% of net worth.
  p = allowanceStep(p, o(1340e6, 20e6, { has4S: true }), cfg);
  assert.ok(Math.abs(p.bucket - 134e6) < 1, "capped: 25% of $1b would have been $250m");
  // Overspending (someone ignored the fence) is paid back before any more is granted.
  p = allowanceStep(p, o(1140e6, 220e6), cfg);
  assert.ok(p.bucket < 0);
  assert.equal(p.wanted, 0);
  // Cash the trader cannot place is free to spend.
  p = allowanceStep(p, o(1140e6, 220e6, { idleCash: 400e6 }), cfg);
  assert.equal(p.wanted, 400e6);
});

test("treasury: a trader's state from before the last install is not a live trader", () => {
  const state = { tier: 2, netWorth: 50e9, updatedAt: 1_000_000 };
  const o = { now: 1_010_000, staleMs: 60_000, epoch: 900_000 };
  assert.equal(liveTrader(state, o), state);
  assert.equal(liveTrader(state, { ...o, now: 1_100_000 }), null, "stale");
  // Ten seconds old, but an install happened five seconds ago: those were the
  // trader's last words, about money that is gone.
  assert.equal(liveTrader(state, { ...o, epoch: 1_005_000 }), null);
  assert.equal(liveTrader({ ...state, tier: 0 }, o), null, "no TIX access");
  assert.equal(liveTrader({ tier: 1, updatedAt: 1_000_000 }, o), null, "no net worth published (the no-TIX stub)");
  assert.equal(liveTrader(undefined, o), null);
});

test("treasury: the books start over with every install, and count outflow across trader restarts", () => {
  const cfg = S.treasury;
  const trader = (netWorth, outflow, startedAt, extra = {}) => ({ tier: 1, netWorth, outflow, startedAt, ...extra });

  // Cold start, no trader yet: the opening grant, and a drop in cash is spending.
  let b = treasuryStep(null, { epoch: 1, cash: 250e6, trader: null }, cfg);
  assert.equal(b.purse.wanted, cfg.startFraction * 250e6);
  b = treasuryStep(b, { epoch: 1, cash: 245e6, trader: null }, cfg);
  assert.ok(Math.abs(b.purse.bucket - (cfg.startFraction * 250e6 - 5e6)) < 1, "the $5m spent came out of the grant");

  // The trader comes up and reports its own count; a restart (new startedAt,
  // counting from zero again - even past where the old one stopped) adds on.
  b = treasuryStep(b, { epoch: 1, cash: 10e6, trader: trader(245e6, 2e6, 100) }, cfg);
  assert.equal(b.outflowBase + b.traderOutflow, 7e6);
  b = treasuryStep(b, { epoch: 1, cash: 10e6, trader: trader(243e6, 3e6, 200) }, cfg);
  assert.equal(b.outflowBase + b.traderOutflow, 10e6, "the first trader's $2m is kept, not overwritten");
  b = treasuryStep(b, { epoch: 1, cash: 10e6, trader: trader(243e6, 3e6, 200) }, cfg);
  assert.equal(b.outflowBase + b.traderOutflow, 10e6, "the same process is not counted twice");
  // A trader that publishes no startedAt is still caught by a total that went backwards.
  let old = treasuryStep(null, { epoch: 1, cash: 0, trader: trader(1e9, 5e6, undefined) }, cfg);
  old = treasuryStep(old, { epoch: 1, cash: 0, trader: trader(1e9, 1e6, undefined) }, cfg);
  assert.equal(old.outflowBase + old.traderOutflow, 6e6);

  // The run compounds to $50b...
  b = treasuryStep(b, { epoch: 1, cash: 1e9, trader: trader(50e9, 3e6, 200, { tier: 2 }) }, cfg);
  assert.ok(b.purse.highWater > 50e9);
  // ...and an install takes it back to $250m. Carried over, the book would
  // owe nothing until net worth had passed $50b again, and the grant for the
  // TOR router and port openers the install just took would never come.
  const carried = treasuryStep(b, { epoch: 1, cash: 250e6, trader: null }, cfg);
  assert.ok(carried.purse.highWater > 50e9, "what the old module-scope state did");
  const fresh = treasuryStep(b, { epoch: 2, cash: 250e6, trader: null }, cfg);
  assert.equal(fresh.epoch, 2);
  assert.equal(fresh.purse.wanted, cfg.startFraction * 250e6);
  assert.equal(fresh.purse.highWater, 250e6);
  assert.equal(fresh.outflowBase + fresh.traderOutflow, 0);
  assert.equal(b.epoch, 1, "pure: the previous book is not touched");
});

// ── The shell: lib/stocks.js step() against the fake market ──────────────────

/** Run the trader for `ticks` market ticks. */
function run(m, T, ticks, each = null) {
  let now = 1e12;
  for (let t = 1; t <= ticks; t++) {
    step(m.ns, T, now);
    each?.(t, now);
    m.tick();
    now += MARKET.msPerStockUpdate;
  }
  return now;
}

test("config: BN8 is an override, and the trader resolves it through forNode", () => {
  assert.equal(BITNODE[8].name, "Ghost of Wall Street");
  assert.equal(BITNODE[8].paths.daemon, "/bn8/daemon.js");
  assert.equal(BN8.reserveRatio, 0);
  assert.equal(BN8.maxPositionRatio, 1);
  assert.equal(BN8.fourSBudgetRatio, 1);
  assert.equal(BN8.fourSigmaCostMult, 1, "FourSigmaMarketDataApiCost is not raised in BN8");
  // Everything else is the default every other node runs on.
  assert.deepEqual(forNode(4).stocks, CONFIG.stocks);
  assert.equal(forNode(7).stocks.fourSigmaCostMult, 2);
  assert.equal(forNode(7).stocks.maxPositionRatio, S.maxPositionRatio);
});

test("shell: no TIX API - buys access when a share of cash covers it, trades nothing", () => {
  resetGlobals();
  const m = makeMarket({ seed: 1, money: 1e9, wse: false, tix: false });
  const T = newTrader(S);
  assert.equal(step(m.ns, T), "no-tix");
  assert.equal(globalThis.gordStockState.tier, 0);
  // $1b x 10% < $200m: not yet.
  assert.equal(m.player.hasWseAccount, false);
  m.player.money = 30e9;
  step(m.ns, T);   // WSE ($200m <= 10% of $30b)
  assert.equal(m.player.hasWseAccount, true);
  assert.equal(step(m.ns, T), "trading"); // TIX ($5b <= 20%), then straight into the first tick
  assert.equal(m.player.hasTixApiAccess, true);
  assert.equal(globalThis.gordStockState.tier, 1);
  // A hoard blocks the purchases.
  resetGlobals();
  globalThis.gordMoneyFloor = 1e9;
  const m2 = makeMarket({ seed: 1, money: 30e9, wse: false, tix: false });
  step(m2.ns, newTrader(S));
  assert.equal(m2.player.hasWseAccount, false);
});

test("shell: shorting is probed, not assumed", () => {
  resetGlobals();
  for (const canShort of [true, false]) {
    const m = makeMarket({ seed: 2, canShort });
    const T = newTrader(BN8);
    step(m.ns, T);
    assert.equal(T.canShort, canShort);
    assert.equal(globalThis.gordStockState.canShort, canShort);
  }
});

test("shell: liquidates for an install request, and says when the book is empty", () => {
  resetGlobals();
  const m = makeMarket({ seed: 3, has4S: true });
  const T = newTrader(BN8);
  let now = run(m, T, 30);
  assert.ok(globalThis.gordStockState.totalValue > 0, "holding something after 30 ticks with 4S");
  assert.ok(globalThis.gordStockState.netWorth > 0);

  globalThis.gordInstallRequested = now;
  assert.equal(step(m.ns, T, now), "liquidating");
  assert.equal(globalThis.gordStockState.totalValue, 0);
  assert.equal(globalThis.gordStockState.positions.length, 0);
  assert.ok(Math.abs(m.player.money - m.netWorth()) < 1e-6, "all cash");
  // It stays out while the request is live, and returns when it lapses.
  m.tick();
  step(m.ns, T, now + 6000);
  assert.equal(globalThis.gordStockState.totalValue, 0);
  m.tick();
  assert.equal(step(m.ns, T, now + BN8.installRequestTtlMs + 1), "trading");
  assert.ok(globalThis.gordStockState.totalValue > 0);
});

test("shell: an invite hoard is held in cash while the rest keeps trading", () => {
  resetGlobals();
  const m = makeMarket({ seed: 3, has4S: true, money: 1e9 });
  const T = newTrader(S);
  let now = run(m, T, 30);
  const invested = globalThis.gordStockState.totalValue;
  assert.ok(invested > 300e6);

  globalThis.gordMoneyFloor = 600e6;
  step(m.ns, T, now);
  assert.ok(m.player.money >= 600e6, `cash $${m.player.money} covers the floor`);
  assert.ok(globalThis.gordStockState.totalValue > 0, "and the rest is still in the market");
  assert.ok(globalThis.gordStockState.totalValue < invested);
});

test("shell: a treasurer's request sets the allowance, the hoard and the fence", () => {
  resetGlobals();
  const m = makeMarket({ seed: 3, has4S: true });
  const T = newTrader(BN8);
  let now = 1e12;
  const ask = (amount, extra = {}) => { globalThis.gordStockCashWanted = { amount, updatedAt: now, ...extra }; };
  const tick = () => { step(m.ns, T, now); m.tick(); now += 6000; };

  ask(10e6);
  for (let i = 0; i < 30; i++) { ask(10e6); tick(); }
  // Fully invested but for the allowance, and the floor fences off the rest.
  assert.ok(m.player.money >= 10e6);
  assert.equal(globalThis.gordMoneyFloor, Math.max(0, m.player.money - 10e6));
  assert.ok(globalThis.gordStockState.totalValue > 150e6);

  // Someone spends $4m of it: counted as outflow, not as a trading loss.
  m.player.money -= 4e6;
  ask(10e6); tick();
  assert.ok(Math.abs(globalThis.gordStockState.outflow - 4e6) < 1);

  // A bigger allowance and an invite hoard are raised by selling.
  ask(40e6, { hoard: 60e6 }); tick();
  assert.ok(m.player.money >= 100e6 - 1, `cash $${m.player.money}`);
  assert.ok(globalThis.gordMoneyFloor >= 60e6 - 1, "the hoard is inside the fence; only the allowance is spendable");
  assert.ok(m.player.money - globalThis.gordMoneyFloor <= 40e6 + 1);

  // An install is due: the fence comes down (maybeInstall never installs over a floor).
  ask(40e6, { release: true }); tick();
  assert.equal(globalThis.gordMoneyFloor, 0);

  // A stale request is ignored: back to the daemon's own floor semantics.
  globalThis.gordMoneyFloor = 0;
  now += BN8.cashWantedTtlMs + 1;
  tick();
  assert.equal(globalThis.gordMoneyFloor, 0, "no fence without a live treasurer");
});

test("shell: requests left on globalThis by the run before the last install are not obeyed", () => {
  // globalThis outlives an aug install. The last run's final words were "an
  // install is due: fence down, hold $2b, sell everything" - seconds old when
  // the new run's trader takes its first step with a fresh $250m.
  resetGlobals();
  const m = makeMarket({ seed: 3, has4S: true });
  const now = 1e12;
  globalThis.gordStockCashWanted = { amount: 2e9, release: true, updatedAt: now - 5_000 };
  globalThis.gordInstallRequested = now - 5_000;
  const T = newTrader(BN8, { epoch: now - 1_000 });   // the install was a second ago
  assert.equal(step(m.ns, T, now), "trading", "not liquidating for an install that already happened");
  assert.equal(globalThis.gordMoneyFloor, undefined, "and no fence published on a dead treasurer's say-so");
  assert.equal(globalThis.gordStockState.hold, 0);
  // The same globals stamped after the install are this run's, and count.
  globalThis.gordInstallRequested = now + 1;
  assert.equal(step(m.ns, T, now + 6_000), "liquidating");
  globalThis.gordInstallRequested = 0;
  globalThis.gordStockCashWanted = { amount: 5e6, updatedAt: now + 12_000 };
  m.tick();
  step(m.ns, T, now + 12_000);
  assert.equal(globalThis.gordMoneyFloor, Math.max(0, m.player.money - 5e6));
});

test("shell: publishes the wish list for the batcher", () => {
  resetGlobals();
  const m = makeMarket({ seed: 4, has4S: true, money: 50e9 });
  const T = newTrader(BN8);
  run(m, T, 20);
  const w = globalThis.gordStockWishes;
  const state = globalThis.gordStockState;
  assert.ok(w.updatedAt > 0);
  for (const p of state.positions) {
    const host = STOCK_SERVERS[p.sym];
    if (!host) continue;
    assert.ok((p.sharesLong > 0 ? w.up : w.down).includes(host), `${p.sym} -> ${host}`);
    assert.ok(!(p.sharesLong > 0 ? w.down : w.up).includes(host));
  }
  // pump: every stock with a server is on one list or the other.
  assert.equal(w.up.length + w.down.length, 32);
  // Held positions lead their list.
  const longs = state.positions.filter(p => p.sharesLong > 0 && STOCK_SERVERS[p.sym]).map(p => STOCK_SERVERS[p.sym]);
  assert.deepEqual([...w.up.slice(0, longs.length)].sort(), [...longs].sort());
});

test("shell: buys 4S when what is left would out-earn the whole - and not before", () => {
  // Too poor: $250m never raises $25b.
  resetGlobals();
  let m = makeMarket({ seed: 1 });
  let T = newTrader(BN8);
  run(m, T, 300);
  assert.equal(m.player.has4SDataTixApi, false);
  assert.equal(T.want4S, false);

  // Rich enough that $25b is small change next to the edge it buys.
  resetGlobals();
  m = makeMarket({ seed: 1, money: 2e12 });
  T = newTrader(BN8);
  run(m, T, 400);
  assert.equal(m.player.has4SDataTixApi, true);
  assert.equal(globalThis.gordStockState.tier, 2);
  assert.equal(m.player.has4SData, true, "the UI data follows once it is small change");

  // The default config keeps its ceiling: the price may be 30% of net worth at most.
  resetGlobals();
  m = makeMarket({ seed: 1, money: 60e9 });
  T = newTrader({ ...S, fourSGainRealized: 50 }); // make the payback test trivially true
  run(m, T, 400);
  assert.equal(m.player.has4SDataTixApi, false, "$25b > 30% of ~$60b");

  // A purchase the game keeps refusing with the money in hand is given up on -
  // after three attempts, each at double the price assumed before.
  resetGlobals();
  m = makeMarket({ seed: 1, money: 2e12 });
  let attempts = 0;
  m.ns.stock.purchase4SMarketDataTixApi = () => { attempts++; return false; };
  T = newTrader(BN8);
  run(m, T, 400);
  assert.equal(T.fourSBlocked, true);
  assert.equal(attempts, 3);
  assert.equal(T.costMult.api, 8);
  assert.ok(globalThis.gordStockState.totalValue > 1e12, "and the money went back to work");
});

test("4S prices: per BitNode, the UI data priced apart from the API, BN12 by Source-File level", () => {
  // bitburner-src BitNode.tsx: FourSigmaMarketDataApiCost / FourSigmaMarketDataCost.
  assert.deepEqual(fourSCostMults(8, 0, forNode(8).stocks), { api: 1, data: 1 });
  assert.deepEqual(fourSCostMults(7, 0, forNode(7).stocks), { api: 2, data: 2 });
  assert.deepEqual(fourSCostMults(13, 0, forNode(13).stocks), { api: 10, data: 10 });
  // BN9 charges x4 for the API and x5 for the data.
  assert.deepEqual(fourSCostMults(9, 0, { fourSigmaCostMult: 4 }), { api: 4, data: 5 });
  assert.deepEqual(fourSCostMults(9, 0, { fourSigmaCostMult: 4, fourSigmaDataCostMult: 6 }), { api: 4, data: 6 }, "config wins");
  // BN12: 1.02^(active SF12 level + 1), whatever config says - it cannot know the level.
  assert.deepEqual(fourSCostMults(12, 0, { fourSigmaCostMult: 1 }), { api: 1.02, data: 1.02 });
  const lvl50 = fourSCostMults(12, 50, forNode(12).stocks);
  assert.ok(Math.abs(lvl50.api - Math.pow(1.02, 51)) < 1e-12 && lvl50.api === lvl50.data);
  // A trader made without them (the tests' newTrader(cfg)) falls back to config.
  assert.deepEqual(newTrader(forNode(7).stocks).costMult, { api: 2, data: 2 });
});

test("shell: a 4S refusal over a wrong price is retried at a higher one, not latched for the run", () => {
  // The node charges x4 ($100b) and the trader was told x1: the first two
  // attempts ($25b, $50b in hand) are refused, the third ($100b) goes through.
  resetGlobals();
  let m = makeMarket({ seed: 1, money: 2e12, fourSCostMult: 4 });
  let T = newTrader(BN8);
  run(m, T, 400);
  assert.equal(m.player.has4SDataTixApi, true);
  assert.equal(T.fourSBlocked, false);
  assert.equal(T.refusals.api, 2);
  assert.equal(T.costMult.api, 4);
  assert.ok(m.player.money >= 0);
  // The UI data is priced by its own multiplier and learns the same way.
  assert.equal(m.player.has4SData, true);
  assert.equal(T.dataBlocked, false);

  // Told the right price, it is bought on the first attempt.
  resetGlobals();
  m = makeMarket({ seed: 1, money: 2e12, fourSCostMult: 4 });
  T = newTrader(BN8, { costMult: { api: 4, data: 4 } });
  run(m, T, 400);
  assert.equal(m.player.has4SDataTixApi, true);
  assert.equal(T.refusals.api, 0);

  // Where the BitNode option switches 4S off, it is never asked for: no cash
  // is raised for it and nothing is attempted.
  resetGlobals();
  m = makeMarket({ seed: 1, money: 2e12 });
  let asked = 0;
  m.ns.stock.purchase4SMarketDataTixApi = () => { asked++; return false; };
  T = newTrader(BN8, { fourSDisabled: true });
  run(m, T, 400, () => assert.equal(T.want4S, false));
  assert.equal(asked, 0);
  assert.equal(T.fourSBlocked, true);
  assert.equal(T.dataBlocked, true);
});

test("shell: 4S is not wanted while the allowance leaves too little to pay for it", () => {
  // $26b, of which a treasurer wants everything above $24b liquid: selling the
  // whole book raises $24b of spendable cash, never the $25b. Wanting the data
  // anyway held its price in cash every tick - everything sold, nothing bought,
  // for ever (cash does not grow, so the condition never cleared itself).
  resetGlobals();
  const m = makeMarket({ seed: 1, money: 26e9 });
  const T = newTrader({ ...BN8, fourSGainRealized: 1000 }); // the payback test is trivially true
  let invested = 0;
  const ask = now => { globalThis.gordStockCashWanted = { amount: Math.max(0, m.netWorth() - 24e9), updatedAt: now }; };
  ask(1e12);
  run(m, T, 400, (t, now) => {
    ask(now + MARKET.msPerStockUpdate);
    if (t > 300 && globalThis.gordStockState.totalValue > 0) invested++;
  });
  assert.equal(m.player.has4SDataTixApi, false);
  assert.equal(T.want4S, false);
  assert.ok(invested > 50, `still trading on estimates (${invested} of the last 100 ticks invested)`);

  // The same book with the allowance out of the way buys it.
  resetGlobals();
  const m2 = makeMarket({ seed: 1, money: 26e9 });
  const T2 = newTrader({ ...BN8, fourSGainRealized: 1000 });
  run(m2, T2, 400);
  assert.equal(m2.player.has4SDataTixApi, true);
});

// ── End to end ───────────────────────────────────────────────────────────────

const money = n => n >= 1e12 ? `$${(n / 1e12).toFixed(2)}t` : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}b` : `$${(n / 1e6).toFixed(0)}m`;

/** One simulated day of BN8 trading from $250m. Returns net worth at each mark. */
function simulateDay(seed, o = {}) {
  resetGlobals();
  const m = makeMarket({ seed, has4S: !!o.has4S });
  const T = newTrader({ ...BN8, ...(o.cfg ?? {}) });
  const marks = [600, 2400, 4800, 7200, 14400];
  const out = { worth: [], bought4S: 0, trades: 0 };
  run(m, T, 14400, t => {
    if (!out.bought4S && !o.has4S && m.player.has4SDataTixApi) out.bought4S = t;
    if (o.manipulate) {
      // A batcher cycling each wished server through half its money once a
      // second: 6 flagged grows (or hacks) a tick at 50% - ~0.3 of second-order
      // forecast per tick. Only the three servers hackable at level 10.
      const w = globalThis.gordStockWishes;
      for (const host of o.manipulate) {
        const kind = w.up.includes(host) ? "grow" : w.down.includes(host) ? "hack" : null;
        if (kind) for (let i = 0; i < 6; i++) m.influence(kind, host, 0.5);
      }
    }
    if (marks.includes(t)) out.worth.push(m.netWorth());
  });
  out.trades = m.stats.buys + m.stats.sells;
  return out;
}

test("end to end: a simulated day of BN8 from $250m, with and without 4S data", { timeout: 600_000 }, t => {
  const seed = 2;
  const estimates = simulateDay(seed, { cfg: { fourSMaxPaybackMs: 0 } });   // never buys 4S
  const rule = simulateDay(seed);                                          // buys it when it pays
  const data = simulateDay(seed, { has4S: true });                         // owned from the start
  const pushed = simulateDay(seed, { manipulate: ["joesguns", "sigma-cosmetics", "foodnstuff"] });

  const row = (name, r) => `${name.padEnd(34)} ${r.worth.map(w => money(w).padStart(9)).join(" ")}  (${r.trades} trades${r.bought4S ? `, 4S at tick ${r.bought4S}` : ""})`;
  t.diagnostic(`net worth after                      ${["1h", "4h", "8h", "12h", "24h"].map(h => h.padStart(9)).join(" ")}   [seed ${seed}; 6s ticks]`);
  t.diagnostic(row("estimates only (4S never bought)", estimates));
  t.diagnostic(row("4S bought when it pays", rule));
  t.diagnostic(row("4S owned from the start", data));
  t.diagnostic(row("...when it pays + 3 servers pushed", pushed));

  const final = r => r.worth[r.worth.length - 1];
  // Loose bounds - one seed of a random market - on things that must hold on any.
  for (const r of [estimates, rule, data, pushed]) {
    assert.ok(r.worth[1] > 250e6, "ahead after 4 hours");
    assert.ok(final(r) > 50e9, `at least 200x in a day (${money(final(r))})`);
  }
  assert.ok(rule.bought4S > 0, "the payback rule bought 4S within the day");
  assert.ok(estimates.worth[0] === rule.worth[0], "identical until 4S is bought");
  assert.ok(data.worth[1] > estimates.worth[1], "exact forecasts beat estimated ones over the first 4 hours");
  // How far ahead varies a lot by seed (8x here, 300x on others) - it depends on
  // how soon a pushed stock happens to be worth holding.
  assert.ok(pushed.worth[1] > 3 * rule.worth[1], "a batcher pushing three small stocks is worth more than the 4S data");
});
