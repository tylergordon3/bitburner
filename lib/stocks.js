// lib/stocks.js
//
// The stock trader. An off-home helper every daemon launches (lib/daemon-core.js,
// exec arg [0] = the BitNode number); in BN8 - where the market is the only
// income there is - it is the node's engine and bn8/daemon.js launches it first.
//
// This file is the Netscript I/O shell: read the market, execute orders, publish
// state. Every decision is the pure lib/stocks-logic.js (0GB, unit-tested against
// a transcription of the game's market - tests/stocks-logic.test.mjs). step() is
// exported so the tests run THIS code against that fake market too.
//
// RAM: 38.3GB - 1.6 base, getPlayer 0.5, getResetInfo 1 (once, in main: the 4S
// price in BN12 and the BitNode option that disables 4S), the four has* checks
// 0.2, five market reads at 2GB (getSymbols, getPrice, getAskPrice, getPosition,
// getMaxShares), and ten calls at 2.5GB (buy/sell, short/cover, getForecast,
// getVolatility, the four purchases). The bid is derived (2 x price - ask),
// which is what keeps getBidPrice's 2GB out. lib/stocks-logic.js,
// lib/capabilities.js (sourceFileLevel only) and lib/config.js add nothing.
//
// ── Access tiers ─────────────────────────────────────────────────────────────
//  Tier 0  No TIX API           → buy WSE, then TIX, when a share of cash covers it
//  Tier 1  WSE + TIX API        → trade on ESTIMATED forecasts (stocks-logic's
//                                 Bayes filter over the up/down history)
//  Tier 2  + 4S Market Data TIX → trade on getForecast() / getVolatility()
// Tier 2 is bought when it pays for itself (fourSPaybackTicks), not at a share
// of cash: in BN8 the price comes out of the capital that is compounding.
//
// ── What a tick does ─────────────────────────────────────────────────────────
//  1. Feed every price to the estimator (always - it also tracks where the
//     75-tick market cycle is, which the planner wants with or without 4S).
//  2. planTrades: exit what has turned, raise cash that has been asked for,
//     enter the best expected returns (forecast edge x volatility, net of the
//     spread and both commissions) up to the share cap and the per-stock ratio,
//     long - and short where the node allows it (BN8, or SF8.2).
//  3. Execute sells, then buys. Market orders only: see below.
//  4. Publish gordStockState (HUD, the install handshake, BN8's treasury) and
//     gordStockWishes (which servers the batcher should push up or down).
//
// ── Why no limit or stop orders ──────────────────────────────────────────────
// They are available in BN8 (or with SF8.3) and deliberately unused. An order
// fires inside the market tick when the PRICE crosses its level, and then
// executes as an ordinary market transaction at the current bid/ask
// (OrderProcessing.tsx executeOrder -> buyStock/sellStock) - a limit buy does
// not fill at its limit price. So an order buys nothing a script waking on
// nextUpdate() doesn't already get: prices only change on the tick, and we act
// on every one, at the same price the order would. What an order CAN'T see is
// the thing we trade on - the forecast; a price level is a poor proxy for it
// (prices of a 60% stock still fall 40% of the time), so a stop would mostly
// sell winners on noise and pay the spread to get back in. They would also cost
// placeOrder/cancelOrder/getOrders: +7.5GB.
//
// ── Safety rails ─────────────────────────────────────────────────────────────
//  • reserveRatio of net worth is never spent on stock (but never sold FOR).
//  • Cash that must be there IS raised by selling the worst positions: an invite
//    hoard (globalThis.gordMoneyFloor), the 4S price once it is worth it. The
//    rest of the book keeps trading; a hoard used to liquidate everything.
//  • Where a treasurer daemon publishes globalThis.gordStockCashWanted (BN8:
//    the trader's capital IS the player's money), its allowance and hoard are
//    held liquid the same way, and the trader fences off everything else by
//    publishing gordMoneyFloor = cash - allowance after every tick - so cash
//    sitting between two positions is not "spendable" to the rest of the bot.
//  • Before an aug install (globalThis.gordInstallRequested) everything is sold:
//    an install wipes the market and positions held through it are simply lost.
//  • No position above maxPositionRatio of net worth, nor above the share cap.
//  • An order must be big enough to earn its commissions back.

import { forNode } from "./config.js";
import { sourceFileLevel } from "./capabilities.js";
import * as L from "./stocks-logic.js";

/**
 * A trader's state between ticks.
 * @param {any} cfg - the node's CONFIG.stocks (forNode(node).stocks)
 * @param {{canShort?: boolean, costMult?: {api: number, data: number}, fourSDisabled?: boolean, epoch?: number}} [o]
 *   costMult - the BitNode's price multipliers for the two 4S purchases
 *   (lib/stocks-logic.js fourSCostMults); fourSDisabled - the BitNode option
 *   that switches 4S data off (getResetInfo().bitNodeOptions.disable4SData).
 *   main() fills both in from getResetInfo; the defaults are the config's.
 */
export function newTrader(cfg, o = {}) {
  return {
    cfg,
    // What the game will charge for the 4S API and the 4S UI data, as multiples
    // of getConstants()' base prices. Mutable: a refusal doubles the one that
    // was refused (see refused4S).
    costMult: { ...(o.costMult ?? L.fourSCostMults(0, 0, cfg)) },
    // Tells one trader process from the next: `outflow` below counts from zero
    // in each, and whoever totals it across restarts (the BN8 treasury) has to
    // know when it started over.
    startedAt: Date.now(),
    // getResetInfo().lastAugReset. Requests on globalThis stamped before it are
    // the LAST run's - globalThis outlives an install - and are not obeyed.
    epoch: o.epoch ?? 0,
    // undefined = not probed yet (the probe needs TIX access).
    canShort: /** @type {boolean | undefined} */ (o.canShort),
    est: L.newEstimator(cfg.estimator),
    symbols: /** @type {string[] | null} */ (null),
    maxShares: new Map(),
    constants: /** @type {any} */ (null),
    // Cash we had when our last step ended: the difference at the next step is
    // what everyone ELSE spent (outflow) or earned (inflow) in between.
    lastCash: /** @type {number | null} */ (null),
    outflow: 0,
    inflow: 0,
    idleTicks: 0,
    // 4S payback: smoothed return on capital without / with the data.
    rateWithout: 0,
    rateWith: 0,
    rateSamples: 0,
    paybackTicks: Infinity,
    want4S: false,
    // "Stop asking": the BitNode has 4S switched off, or the game kept
    // refusing with the money in hand (refused4S).
    fourSBlocked: !!o.fourSDisabled,
    dataBlocked: !!o.fourSDisabled,
    refusals: { api: 0, data: 0 },
  };
}

// A purchase refused with its price in hand, in a node where 4S is not
// switched off, means the price was wrong: the BitNode charges more than
// config says (stocks.fourSigmaCostMult). Double what we take it to be and let
// the payback rule decide afresh at that price - so the next attempt comes
// with more cash, later - and only give up once it has been refused this many
// times, i.e. with up to four times the expected price in hand. (It used to
// give up at the first refusal, for the rest of the run.)
const MAX_4S_REFUSALS = 3;

/**
 * Note a refused 4S purchase. Returns true when that was the last attempt.
 * @param {any} T @param {"api" | "data"} which
 */
function refused4S(T, which) {
  T.costMult[which] *= 2;
  return ++T.refusals[which] >= MAX_4S_REFUSALS;
}

/**
 * Can this run open short positions (BN8, or SF8.2)? Asked of the game rather
 * than derived: buyShort checks the access before it looks at the share count,
 * so a zero-share short throws without it and is a no-op with it.
 * @param {NS} ns @param {string} sym
 */
function probeShorting(ns, sym) {
  try {
    ns.stock.buyShort(sym, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * WSE account and TIX API: bought when a share of cash covers them. (In BN8
 * both are free from the start.) Never while the daemon is hoarding for a
 * money-gated invite - these are big single purchases.
 * @param {NS} ns @param {any} T
 */
function maybeBuyAccess(ns, T) {
  const st = ns.stock;
  if (st.hasWseAccount() && st.hasTixApiAccess()) return;
  // (Where a treasurer fences the capital - BN8 - both are owned from the start,
  // so its permanent floor never gets as far as this check.)
  if ((globalThis.gordMoneyFloor ?? 0) > 0) return;
  const money = ns.getPlayer().money;
  const consts = (T.constants ??= st.getConstants());

  if (!st.hasWseAccount()) {
    if (money * T.cfg.wseBudgetRatio >= consts.WseAccountCost && st.purchaseWseAccount()) {
      ns.tprint("[stocks] Purchased WSE account");
    }
    return;
  }
  if (money * T.cfg.tixBudgetRatio >= consts.TixApiCost && st.purchaseTixApi()) {
    ns.tprint("[stocks] Purchased TIX API access");
  }
}

/**
 * Is the 4S Market Data TIX API worth its price yet? Updates the smoothed
 * with/without returns and the payback they imply; sets T.want4S when the
 * payback is short enough (the caller then holds the price in cash and buys).
 *
 * The two returns come from the estimator: the edge we trade on today (the
 * posterior mean, and only where the planner's confidence gate would let us in)
 * against the edge we would have knowing p exactly (E|2p - 1| - see
 * stocks-logic). Both through tradingRate, which fills the best stocks first up
 * to their caps, so the comparison holds for a small book and a saturated one.
 *
 * `spoken` is cash that has to stay liquid whatever happens (a treasurer's
 * allowance). The price must fit in what is left of the book once THAT is set
 * aside: wanting the data holds its price in cash, and a price the book cannot
 * raise is a book sold off every tick for a purchase that never happens - and,
 * being all cash, one that never grows out of it either.
 * @param {any} T @param {any[]} views @param {number} netWorth @param {number} cost
 * @param {number} [spoken]
 */
function assess4S(T, views, netWorth, cost, spoken = 0) {
  const cfg = T.cfg;
  // Decided afresh every tick: a "yes" from an earlier one must not outlive
  // the conditions it was given under (the early returns below included).
  T.want4S = false;
  if (T.est.ticks < cfg.fourSMinTicks || !(netWorth - spoken > cost)) return;

  const cap = (v, wealth) => Math.min(v.maxShares * v.price, cfg.maxPositionRatio * wealth);
  const without = [], withData = [];
  for (const v of views) {
    const e = v.est;
    const long = e.up >= cfg.entryConfidence;
    const short = T.canShort && cfg.shortWithoutData && 1 - e.up >= cfg.entryConfidenceShort;
    const traded = e.seen >= cfg.minObservations && (long || short) ? Math.abs(2 * e.p - 1) : 0;
    without.push({ edge: traded * e.move, cap: cap(v, netWorth) });
    withData.push({ edge: (T.canShort ? e.absEdge : e.posEdge) * e.move, cap: cap(v, netWorth - cost) });
  }
  const r0 = L.tradingRate(netWorth, without);
  const r1 = L.tradingRate(netWorth - cost, withData);

  // Smoothed over a couple of market cycles: right after a cycle tick the data
  // is worth a lot for a dozen ticks (nobody knows what flipped) and that is
  // not the moment to judge it by.
  const alpha = T.rateSamples === 0 ? 1 : cfg.fourSRateAlpha;
  T.rateWithout += alpha * (r0 - T.rateWithout);
  T.rateWith += alpha * (r1 - T.rateWith);
  T.rateSamples++;

  // Both rates are ideals - no spread, no commission, no tick of lag after a
  // cycle - and the gap between two ideals overstates the gap between the two
  // real books; fourSGainRealized is the measured share of it that shows up.
  const rateWith = T.rateWithout + cfg.fourSGainRealized * (T.rateWith - T.rateWithout);
  T.paybackTicks = L.fourSPaybackTicks(netWorth, cost, T.rateWithout, rateWith);
  const maxTicks = cfg.fourSMaxPaybackMs / (T.constants?.msPerStockUpdate ?? 6000);
  T.want4S = T.rateSamples >= cfg.fourSMinSamples &&
    L.fourSWorthIt(netWorth, cost, T.rateWithout, rateWith) &&
    T.paybackTicks <= maxTicks &&
    netWorth * cfg.fourSBudgetRatio >= cost;
}

/**
 * Execute the plan, sells first. Returns the log lines (also appended to
 * globalThis.gordStockLog for the HUD).
 * @param {NS} ns @param {any} T @param {any[]} orders @param {Map<string, any>} bySym
 */
function executeOrders(ns, T, orders, bySym) {
  const st = ns.stock;
  const commission = T.cfg.commission;
  const num = n => ns.format.number(n);
  const log = [];

  for (const o of orders) {
    const v = bySym.get(o.sym);
    const f = ` (f=${(v.p * 100).toFixed(1)}%)`;
    if (o.action === "buy") {
      const price = st.buyStock(o.sym, o.shares);
      if (price > 0) log.push(`BUY  ${o.sym} x${num(o.shares)} @ $${num(price)}${f} [$${num(price * o.shares + commission)}]`);
    } else if (o.action === "sell") {
      const price = st.sellStock(o.sym, o.shares);
      if (price > 0) {
        const profit = (price - v.longAvg) * o.shares - commission;
        log.push(`SELL ${o.sym} x${num(o.shares)} @ $${num(price)}${f} [P/L $${num(profit)}] ${o.why}`);
      }
    } else if (o.action === "short") {
      const price = st.buyShort(o.sym, o.shares);
      if (price > 0) log.push(`SHORT ${o.sym} x${num(o.shares)} @ $${num(price)}${f}`);
    } else if (o.action === "cover") {
      const price = st.sellShort(o.sym, o.shares);
      if (price > 0) {
        const profit = (v.shortAvg - price) * o.shares - commission;
        log.push(`COVER ${o.sym} x${num(o.shares)} @ $${num(price)}${f} [P/L $${num(profit)}] ${o.why}`);
      }
    }
  }

  if (log.length > 0) {
    globalThis.gordStockLog = [...(globalThis.gordStockLog ?? []).slice(-T.cfg.logLength), ...log];
  }
  return log;
}

/**
 * Publish gordStockState. The first five fields are what the HUD's stocks card
 * and lib/daemon-lib.js's install handshake have always read (totalValue > 0 =
 * "still holding something"); the rest is for bn8/daemon.js's treasury and the
 * status line.
 * @param {NS} ns @param {any} T @param {any[]} symbols @param {any} extra
 */
function publish(ns, T, symbols, extra) {
  const st = ns.stock;
  const commission = T.cfg.commission;
  const use4S = st.has4SDataTixApi();
  const positions = [];
  let totalValue = 0;

  for (const sym of symbols) {
    const [sharesLong, avgLong, sharesShort, avgShort] = st.getPosition(sym);
    if (sharesLong === 0 && sharesShort === 0) continue;
    const price = st.getPrice(sym);
    const ask = st.getAskPrice(sym);
    const value = L.positionValue({ bid: 2 * price - ask, ask, longShares: sharesLong, shortShares: sharesShort, shortAvg: avgShort });
    totalValue += value.long + value.short;
    positions.push({
      sym, price,
      sharesLong, avgLong, longValue: value.long,
      longPL: sharesLong > 0 ? value.long - avgLong * sharesLong - commission : 0,
      sharesShort, avgShort, shortValue: value.short,
      shortPL: sharesShort > 0 ? value.short - avgShort * sharesShort - commission : 0,
      // The 4S forecast, or our estimate of it.
      forecast: use4S ? st.getForecast(sym) : L.estimateOf(T.est, sym).p,
    });
  }
  positions.sort((a, b) => (b.longValue + b.shortValue) - (a.longValue + a.shortValue));

  const cash = ns.getPlayer().money;
  globalThis.gordStockState = {
    tier: use4S ? 2 : st.hasTixApiAccess() ? 1 : 0,
    totalValue,
    positions,
    cash,
    updatedAt: Date.now(),
    // Everything if sold now, commissions paid.
    netWorth: cash + totalValue - commission * positions.reduce((n, p) => n + (p.sharesLong > 0 ? 1 : 0) + (p.sharesShort > 0 ? 1 : 0), 0),
    canShort: !!T.canShort,
    // What everything but this script has spent / earned since it started.
    startedAt: T.startedAt,
    outflow: T.outflow,
    inflow: T.inflow,
    paybackTicks: T.paybackTicks,
    ...extra,
  };
}

/**
 * One market tick. Synchronous - no awaits - so nothing else can spend between
 * the cash we read and the orders we place.
 * @param {NS} ns @param {any} T - newTrader()
 * @param {number} [now]
 * @returns {"no-tix" | "liquidating" | "trading"}
 */
export function step(ns, T, now = Date.now()) {
  const st = ns.stock;
  const cfg = T.cfg;

  maybeBuyAccess(ns, T);
  if (!st.hasTixApiAccess()) {
    globalThis.gordStockState = { tier: 0, totalValue: 0, positions: [], cash: ns.getPlayer().money, updatedAt: Date.now() };
    return "no-tix";
  }

  const symbols = (T.symbols ??= st.getSymbols());
  const consts = (T.constants ??= st.getConstants());
  if (T.canShort === undefined) T.canShort = probeShorting(ns, symbols[0]);
  const use4S = st.has4SDataTixApi();

  // What everyone else did with the money since our last step.
  const cash = ns.getPlayer().money;
  if (T.lastCash !== null) {
    if (cash < T.lastCash) T.outflow += T.lastCash - cash;
    else T.inflow += cash - T.lastCash;
  }

  // ── Read the market ───────────────────────────────────────────────────────
  const views = symbols.map(sym => {
    const price = st.getPrice(sym);
    const ask = st.getAskPrice(sym);
    const [longShares, longAvg, shortShares, shortAvg] = st.getPosition(sym);
    let maxShares = T.maxShares.get(sym);
    if (maxShares === undefined) T.maxShares.set(sym, (maxShares = st.getMaxShares(sym)));
    // The spread is symmetric about the price, so the bid needs no call of its own.
    return { sym, price, ask, bid: 2 * price - ask, maxShares, longShares, longAvg, shortShares, shortAvg,
             p: 0.5, up: 0.5, move: 0, seen: 0, est: /** @type {any} */ (null) };
  });
  const bySym = new Map(views.map(v => [v.sym, v]));

  // The estimator sees every tick, 4S or not: it is also what knows where the
  // market cycle is, and it must not have a gap in it if 4S is bought later.
  L.observe(T.est, views.map(v => [v.sym, v.price]));
  const cycle = L.cycleInfo(T.est);
  for (const v of views) {
    v.est = L.estimateOf(T.est, v.sym);
    if (use4S) {
      v.p = st.getForecast(v.sym);
      v.up = v.p > 0.5 ? 1 : v.p < 0.5 ? 0 : 0.5;
      v.move = st.getVolatility(v.sym) / 2; // a move is uniform on 0..volatility
      v.seen = Infinity;
    } else {
      v.p = v.est.p; v.up = v.est.up; v.move = v.est.move; v.seen = v.est.seen;
    }
  }
  const netWorth = L.portfolioWorth(views, cash, cfg.commission);

  // ── What must stay liquid ─────────────────────────────────────────────────
  // An install wipes the market, so lib/daemon-lib.js maybeInstall stamps
  // gordInstallRequested once it has decided to reset and holds the reset until
  // we report an empty book (or a timeout). The stamp expires by itself in case
  // the daemon changed its mind or died.
  const requested = globalThis.gordInstallRequested ?? 0;
  const installPending = requested >= T.epoch && requested > 0 && now - requested < cfg.installRequestTtlMs;
  // A treasurer daemon (bn8/daemon.js) publishes gordStockCashWanted:
  //   amount  - the spending allowance: cash the other spenders may use
  //   hoard   - cash a money-gated invite needs to SEE (held, not spent)
  //   release - an install is due: stop fencing, everything is about to be spent
  // Ignored once stale - a dead daemon must not keep capital out of the market.
  const request = globalThis.gordStockCashWanted;
  const treasury = !!request && (request.updatedAt ?? 0) >= T.epoch && now - (request.updatedAt ?? 0) < cfg.cashWantedTtlMs;
  const wanted = treasury ? Math.max(0, request.amount ?? 0) : 0;
  // A money-gated faction invite checks LIQUID money, so that much has to be
  // there in cash - but only that much: the rest of the book keeps earning.
  // Without a treasurer it is the daemon's gordMoneyFloor. With one, the floor
  // is OURS to publish (below), so the hoard arrives in the request instead.
  const floor = treasury ? Math.max(0, request.hoard ?? 0) : globalThis.gordMoneyFloor ?? 0;

  // 4S: worth buying yet? (Not while a hoard or an install wants the cash.)
  const cost4S = consts.MarketDataTixApi4SCost * T.costMult.api;
  if (!use4S && !T.fourSBlocked && floor <= 0 && !installPending) assess4S(T, views, netWorth, cost4S, wanted);
  else T.want4S = false;

  // The 4S data for the in-game UI is cosmetic to this script (it reads the
  // API), so it waits until it is small change next to the book. Priced by
  // its own multiplier: BN9 charges x5 for this and x4 for the API.
  const costData = consts.MarketData4SCost * T.costMult.data;
  const wantData = use4S && !T.dataBlocked && floor <= 0 && !installPending &&
    !st.has4SData() && costData <= cfg.fourSDataMaxFraction * netWorth &&
    netWorth - wanted > costData;

  const hold = floor + wanted + (T.want4S ? cost4S : 0) + (wantData ? costData : 0);
  const plan = L.planTrades(views, {
    cash,
    reserve: cfg.reserveRatio * netWorth,
    hold,
    canShort: !!T.canShort && (use4S || cfg.shortWithoutData),
    exact: use4S,
    ticksToCycle: cycle.ticksToCycle,
    liquidate: installPending,
  }, cfg);

  const log = executeOrders(ns, T, plan.orders, bySym);
  for (const line of log) ns.print(line);

  // ── Buy 4S once the cash for it has been raised ──────────────────────────
  if (T.want4S && ns.getPlayer().money - floor - wanted >= cost4S) {
    if (st.purchase4SMarketDataTixApi()) {
      ns.tprint(`[stocks] Purchased 4S Market Data TIX API ($${ns.format.number(cost4S)}; payback ~${Math.round(T.paybackTicks)} ticks)`);
    } else if (refused4S(T, "api")) {
      // Refused again and again with the money in hand. Stop asking, or we
      // would hold its price idle for ever.
      T.fourSBlocked = true;
      ns.tprint("[stocks] 4S Market Data TIX API purchase refused - carrying on with estimated forecasts.");
    } else {
      // Refused, and the node has not switched 4S off (that is known up front,
      // and never gets this far): this BitNode charges more than config says.
      ns.tprint(`[stocks] 4S Market Data TIX API refused at $${ns.format.number(cost4S)} - this BitNode must charge more ` +
        `(stocks.fourSigmaCostMult); trying again once $${ns.format.number(cost4S * 2)} pays for itself.`);
    }
    T.want4S = false;
  }
  // Same for the UI data.
  if (wantData && ns.getPlayer().money - floor - wanted >= costData && !st.purchase4SMarketData()) {
    if (refused4S(T, "data")) T.dataBlocked = true;
  }

  // Idle cash that has been idle for a while is cash with nowhere to go (every
  // worthwhile stock is at its cap) rather than cash between two trades.
  T.idleTicks = plan.summary.idleCash > cfg.idleCashFraction * netWorth ? T.idleTicks + 1 : 0;

  // ── The fence (treasurer nodes only) ──────────────────────────────────────
  // Our capital is the player's money, and between two positions it sits in
  // cash where every other spender in the repo can see it - augs, servers,
  // sleeve augs and grafts all budget against "cash above gordMoneyFloor". So
  // while a treasurer is in charge we publish that floor ourselves, every tick,
  // right after trading: everything except the allowance is fenced off. Done
  // here rather than in the daemon because we are the one who just turned a
  // position into cash - the daemon's next tick may be 15 seconds away.
  // Dropped for an install: lib/daemon-lib.js never installs over a floor, and
  // by then every dollar is meant to be spent.
  if (treasury) {
    globalThis.gordMoneyFloor = request.release || installPending
      ? 0
      : Math.max(0, ns.getPlayer().money - wanted);
  }

  // ── Publish ───────────────────────────────────────────────────────────────
  if (cfg.manipulation.enabled) {
    const wishes = L.influenceWishes(
      views.map(v => {
        const value = L.positionValue(v);
        // Positions as they stand AFTER this tick's orders decide the wish.
        const o = plan.orders.filter(x => x.sym === v.sym);
        const closing = o.some(x => x.action === "sell" || x.action === "cover");
        const opening = o.find(x => x.action === "buy" || x.action === "short");
        return {
          sym: v.sym, p: v.p, up: v.up, move: v.move,
          longValue: closing ? 0 : opening?.action === "buy" ? value.long + opening.shares * v.ask : value.long,
          shortValue: closing ? 0 : opening?.action === "short" ? value.short + opening.shares * v.bid : value.short,
        };
      }),
      { canShort: !!T.canShort },
      cfg.manipulation,
    );
    // `prefer`: the batcher should WORK these servers ahead of its income
    // ranking, not just flag the legs it happens to send their way - set where
    // unheld stocks are listed too (BN8, where a hack earns nothing anyway).
    globalThis.gordStockWishes = { ...wishes, prefer: !!cfg.manipulation.pump, updatedAt: Date.now() };
  }

  T.lastCash = ns.getPlayer().money;
  publish(ns, T, symbols, {
    expectedIncome: plan.summary.expectedIncome,               // $ per market tick
    incomePerMs: plan.summary.expectedIncome / consts.msPerStockUpdate,
    idleCash: plan.summary.idleCash,
    idleTicks: T.idleTicks,
    hold,
    ticksToCycle: cycle.ticksToCycle,
    cycleConfidence: cycle.confidence,
    want4S: T.want4S,
  });
  return installPending ? "liquidating" : "trading";
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  // Arg [0]: the current BitNode (the daemon passes it). Every setting is read
  // through forNode, so a BITNODE entry's `stocks` overrides apply - BN8's whole
  // personality is such an entry, there is no `if (node === 8)` in here.
  // getResetInfo (1GB) for the two things about 4S that no argument carries:
  // BN12's price multiplier grows with the Source-File level, and a BitNode
  // option can switch 4S data off altogether.
  const reset = ns.getResetInfo();
  const fromArg = Number(ns.args[0]);
  const node = Number.isFinite(fromArg) && fromArg > 0 ? fromArg : reset.currentNode;
  const cfg = forNode(node).stocks;
  const T = newTrader(cfg, {
    costMult: L.fourSCostMults(node, sourceFileLevel(reset, 12), cfg),
    fourSDisabled: !!reset.bitNodeOptions?.disable4SData,
    epoch: reset.lastAugReset,
  });
  ns.tprint(`[stocks] Starting (BitNode ${node}).`);

  let announced = false;
  while (true) {
    const mode = step(ns, T);
    if (mode === "no-tix") {
      // Poll until TIX is affordable.
      await ns.sleep(T.cfg.noTixSleepMs);
      continue;
    }
    if (!announced) {
      announced = true;
      ns.tprint(`[stocks] Trading. Short positions: ${T.canShort ? "enabled" : "disabled"}.`);
    }
    // Resolves exactly when prices update; step() must run once per update.
    await ns.stock.nextUpdate();
  }
}
