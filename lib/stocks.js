// lib/stocks.js
//
// Standalone stock trader. Run alongside daemon.js:
//   run /bn4/stocks.js
//
// ── Access tiers ─────────────────────────────────────────────────────────────
//  Tier 0  No WSE account       → buy WSE when we can afford it
//  Tier 1  WSE + TIX API        → trade using momentum (price history)
//  Tier 2  + 4S Market Data TIX → trade using getForecast() (much better)
//
// ── Strategy ─────────────────────────────────────────────────────────────────
//  Tier 1 (momentum): track last N prices per symbol; go long when price is
//  trending up (EMA fast > EMA slow), exit when it reverses. No shorting
//  without 4S because we can't reliably detect downtrends early enough.
//
//  Tier 2 (forecast): buy long when forecast > BUY_THRESHOLD, sell long when
//  forecast < SELL_THRESHOLD. Short when forecast < SHORT_THRESHOLD (if shorts
//  are unlocked), cover when forecast > COVER_THRESHOLD.
//
// ── Safety rails ─────────────────────────────────────────────────────────────
//  • Never spend below RESERVE_RATIO of net worth on stocks
//  • Commission (100k) baked into every buy decision — never buy if profit
//    can't cover 2× commission
//  • Sell everything before an augmentation install (daemon sets gordState)
//  • Never hold more than MAX_POSITION_RATIO of portfolio in one symbol
// ─────────────────────────────────────────────────────────────────────────────

import { CONFIG, forNode } from "./config.js";

// All thresholds live in CONFIG.stocks; these aliases keep the trading logic
// below readable.
const S = CONFIG.stocks;

const COMMISSION      = S.commission;
const BUY_THRESHOLD   = S.buyThreshold;
const SELL_THRESHOLD  = S.sellThreshold;
const SHORT_THRESHOLD = S.shortThreshold;
const COVER_THRESHOLD = S.coverThreshold;

const MOMENTUM_BUY_RATIO  = S.momentumBuyRatio;
const MOMENTUM_SELL_RATIO = S.momentumSellRatio;
const MOMENTUM_FAST  = S.momentumFast;
const MOMENTUM_SLOW  = S.momentumSlow;

const RESERVE_RATIO      = S.reserveRatio;
const MAX_POSITION_RATIO = S.maxPositionRatio;
// Minimum purchase to make the commission worthwhile.
const MIN_BUY_VALUE      = COMMISSION * S.minBuyCommissionMult;
// Required expected profit before entering a position.
const MIN_PROFIT         = COMMISSION * S.minProfitCommissionMult;
// BitNode multiplier on the 4S prices; resolved in main() from the node arg.
let fourSigmaCostMult = 1;

const WSE_BUDGET_RATIO   = S.wseBudgetRatio;
const TIX_BUDGET_RATIO   = S.tixBudgetRatio;
const FOURD_BUDGET_RATIO = S.fourSBudgetRatio;

// ── Price history for momentum mode ──────────────────────────────────────────
/** @type {Map<string, { fast: number, slow: number, count: number }>} */
const emaState = new Map();

const _kFast = 2 / (MOMENTUM_FAST + 1);
const _kSlow = 2 / (MOMENTUM_SLOW + 1);

/** @param {string} sym @param {number} price */
function recordPrice(sym, price) {
  const state = emaState.get(sym);
  if (!state) {
    emaState.set(sym, { fast: price, slow: price, count: 1 });
  } else {
    state.fast = price * _kFast + state.fast * (1 - _kFast);
    state.slow = price * _kSlow + state.slow * (1 - _kSlow);
    state.count++;
  }
}

/** @param {string} sym @returns {{ fast: number, slow: number } | null} */
function getMomentum(sym) {
  const state = emaState.get(sym);
  if (!state || state.count < MOMENTUM_SLOW) return null;
  return { fast: state.fast, slow: state.slow };
}

// ── Access upgrade helper ─────────────────────────────────────────────────────
/** @param {NS} ns */
function maybeUpgradeAccess(ns) {
  const st = ns.stock;
  // Never while the daemon is hoarding for a money-gated invite - these are the
  // biggest single purchases this script makes.
  if ((globalThis.gordMoneyFloor ?? 0) > 0) return;
  const money = ns.getPlayer().money;
  const consts = st.getConstants();

  if (!st.hasWseAccount()) {
    if (money * WSE_BUDGET_RATIO >= consts.WseAccountCost) {
      const ok = st.purchaseWseAccount();
      if (ok) ns.tprint("[stocks] Purchased WSE account");
    }
    return;
  }

  if (!st.hasTixApiAccess()) {
    if (money * TIX_BUDGET_RATIO >= consts.TixApiCost) {
      const ok = st.purchaseTixApi();
      if (ok) ns.tprint("[stocks] Purchased TIX API access");
    }
    return;
  }

  if (!st.has4SDataTixApi()) {
    // getConstants() reports the BASE prices; the game charges them times the
    // BitNode's FourSigmaMarketDataApiCost (2 in BN7), so without the multiplier
    // "30% of cash" was really 60%.
    const cost = consts.MarketDataTixApi4SCost * fourSigmaCostMult;
    if (money * FOURD_BUDGET_RATIO >= cost) {
      const ok = st.purchase4SMarketDataTixApi();
      if (ok) ns.tprint("[stocks] Purchased 4S Market Data TIX API");
    }
    // Also buy the UI data if we don't have it (cosmetic - same budget rule)
    if (!st.has4SData() && money * FOURD_BUDGET_RATIO >= consts.MarketData4SCost * fourSigmaCostMult) {
      st.purchase4SMarketData();
    }
  }
}

// ── Position sizing ───────────────────────────────────────────────────────────

/**
 * Total value of all long + short positions currently held.
 * @param {NS} ns
 * @param {string[]} symbols
 */
function portfolioValue(ns, symbols) {
  let total = 0;
  for (const sym of symbols) {
    const [sharesLong, avgLong, sharesShort, avgShort] = ns.stock.getPosition(sym);
    const price = ns.stock.getPrice(sym);
    if (sharesLong  > 0) total += sharesLong  * price;
    if (sharesShort > 0) total += sharesShort * price;
  }
  return total;
}

/**
 * How much cash we're willing to spend on a new position in `sym`.
 * Respects RESERVE_RATIO and MAX_POSITION_RATIO.
 * @param {NS} ns
 * @param {string} sym
 * @param {string[]} allSymbols
 */
function buyBudget(ns, sym, allSymbols) {
  const player = ns.getPlayer();
  const cash = player.money;
  const portVal = portfolioValue(ns, allSymbols);
  const netWorth = cash + portVal;

  const reserveFloor = netWorth * RESERVE_RATIO;
  const spendableCash = Math.max(0, cash - reserveFloor);

  // How much are we already in this symbol (long)?
  const [sharesLong, avgLong] = ns.stock.getPosition(sym);
  const currentExposure = sharesLong * ns.stock.getPrice(sym);
  const maxExposure = portVal > 0
    ? (portVal + spendableCash) * MAX_POSITION_RATIO
    : spendableCash * MAX_POSITION_RATIO;
  const roomForSymbol = Math.max(0, maxExposure - currentExposure);

  return Math.min(spendableCash, roomForSymbol);
}

// ── Core trade logic ──────────────────────────────────────────────────────────

/**
 * Tier 2: 4S forecast-based decisions.
 * Returns { action, sym, shares, forecast } or null.
 * @param {NS} ns
 * @param {string} sym
 * @param {string[]} allSymbols
 * @param {boolean} canShort
 */
function decide4S(ns, sym, allSymbols, canShort) {
  const st = ns.stock;
  const forecast    = st.getForecast(sym);
  const volatility  = st.getVolatility(sym);
  const price       = st.getPrice(sym);
  const maxShares   = st.getMaxShares(sym);
  const [sharesLong, avgLong, sharesShort, avgShort] = st.getPosition(sym);

  const results = [];

  // ── Exit long position ───────────────────────────────────────────────────
  if (sharesLong > 0 && forecast < SELL_THRESHOLD) {
    results.push({ action: "sell", sym, shares: sharesLong, forecast });
  }

  // ── Cover short position ─────────────────────────────────────────────────
  if (sharesShort > 0 && forecast > COVER_THRESHOLD) {
    results.push({ action: "cover", sym, shares: sharesShort, forecast });
  }

  // ── Enter long position ──────────────────────────────────────────────────
  if (forecast > BUY_THRESHOLD && sharesLong === 0) {
    const budget = buyBudget(ns, sym, allSymbols);
    if (budget < MIN_BUY_VALUE) return results;

    // Account for commission: we need expected profit > 2 × COMMISSION.
    // Expected gain per share per tick ≈ volatility × (2×forecast − 1) × price
    const expectedGainPct = volatility * (2 * forecast - 1);
    const expectedGainPerShare = price * expectedGainPct;
    const shares = Math.min(
      Math.floor((budget - COMMISSION) / st.getAskPrice(sym)),
      maxShares - sharesLong,
    );
    if (shares <= 0) return results;

    const totalGain = expectedGainPerShare * shares;
    if (totalGain > MIN_PROFIT) {
      results.push({ action: "buy", sym, shares, forecast });
    }
  }

  // ── Enter short position ─────────────────────────────────────────────────
  if (canShort && forecast < SHORT_THRESHOLD && sharesShort === 0) {
    const budget = buyBudget(ns, sym, allSymbols);
    if (budget < MIN_BUY_VALUE) return results;

    const expectedGainPct = volatility * (1 - 2 * forecast);
    const expectedGainPerShare = price * expectedGainPct;
    const shares = Math.min(
      Math.floor((budget - COMMISSION) / st.getAskPrice(sym)),
      maxShares - sharesShort,
    );
    if (shares <= 0) return results;

    const totalGain = expectedGainPerShare * shares;
    if (totalGain > MIN_PROFIT) {
      results.push({ action: "short", sym, shares, forecast });
    }
  }

  return results;
}

/**
 * Tier 1: momentum-based decisions (no 4S).
 * Only longs — no reliable shorting without forecast data.
 * @param {NS} ns
 * @param {string} sym
 * @param {string[]} allSymbols
 */
function decideMomentum(ns, sym, allSymbols) {
  const st = ns.stock;
  const [sharesLong] = st.getPosition(sym);
  const mom = getMomentum(sym);
  if (!mom) return [];

  const { fast, slow } = mom;
  const results = [];

  // Exit long
  if (sharesLong > 0 && fast / slow < MOMENTUM_SELL_RATIO) {
    results.push({ action: "sell", sym, shares: sharesLong, forecast: null });
  }

  // Enter long
  if (sharesLong === 0 && fast / slow > MOMENTUM_BUY_RATIO) {
    const budget = buyBudget(ns, sym, allSymbols);
    if (budget < MIN_BUY_VALUE) return results;

    const shares = Math.min(
      Math.floor((budget - COMMISSION) / st.getAskPrice(sym)),
      st.getMaxShares(sym),
    );
    if (shares > 0) {
      results.push({ action: "buy", sym, shares, forecast: null });
    }
  }

  return results;
}

// ── Execute trades ────────────────────────────────────────────────────────────

/** @param {NS} ns @param {{ action: string, sym: string, shares: number, forecast: number|null }[]} trades */
function executeTrades(ns, trades) {
  const st = ns.stock;
  const log = [];

  for (const { action, sym, shares, forecast } of trades) {
    const fStr = forecast !== null ? ` (f=${(forecast * 100).toFixed(1)}%)` : "";

    if (action === "buy") {
      const price = st.buyStock(sym, shares);
      if (price > 0) {
        const cost = price * shares + COMMISSION;
        log.push(`BUY  ${sym} x${shares} @ $${ns.format.number(price)}${fStr} [$${ns.format.number(cost)}]`);
      }
    } else if (action === "sell") {
      const price = st.sellStock(sym, shares);
      if (price > 0) {
        const [, avgLong] = st.getPosition(sym);
        const profit = (price - avgLong) * shares - COMMISSION;
        log.push(`SELL ${sym} x${shares} @ $${ns.format.number(price)}${fStr} [P/L $${ns.format.number(profit)}]`);
      }
    } else if (action === "short") {
      const price = st.buyShort(sym, shares);
      if (price > 0) {
        log.push(`SHORT ${sym} x${shares} @ $${ns.format.number(price)}${fStr}`);
      }
    } else if (action === "cover") {
      const [, , , avgShort] = st.getPosition(sym);
      const price = st.sellShort(sym, shares);
      if (price > 0) {
        const profit = (avgShort - price) * shares - COMMISSION;
        log.push(`COVER ${sym} x${shares} @ $${ns.format.number(price)}${fStr} [P/L $${ns.format.number(profit)}]`);
      }
    }
  }

  // Expose trade log to dashboard
  if (log.length > 0) {
    globalThis.gordStockLog = [
      ...(globalThis.gordStockLog ?? []).slice(-S.logLength),
      ...log,
    ];
  }

  return log;
}

/**
 * Liquidate the entire portfolio immediately.
 * Called when daemon signals an aug install is imminent.
 * @param {NS} ns
 * @param {string[]} symbols
 */
function liquidateAll(ns, symbols) {
  const st = ns.stock;
  let totalProfit = 0;

  for (const sym of symbols) {
    const [sharesLong, avgLong, sharesShort, avgShort] = st.getPosition(sym);

    if (sharesLong > 0) {
      const price = st.sellStock(sym, sharesLong);
      if (price > 0) {
        totalProfit += (price - avgLong) * sharesLong - COMMISSION;
      }
    }

    if (sharesShort > 0) {
      const price = st.sellShort(sym, sharesShort);
      if (price > 0) {
        totalProfit += (avgShort - price) * sharesShort - COMMISSION;
      }
    }
  }

  if (totalProfit !== 0) {
    ns.tprint(`[stocks] Liquidated portfolio before install. Net P/L: $${ns.format.number(totalProfit)}`);
  }
}

// ── State export for dashboard ────────────────────────────────────────────────

/** @param {NS} ns @param {string[]} symbols */
function exportState(ns, symbols) {
  const st = ns.stock;
  const positions = [];
  let totalValue = 0;

  for (const sym of symbols) {
    const [sharesLong, avgLong, sharesShort, avgShort] = st.getPosition(sym);
    if (sharesLong === 0 && sharesShort === 0) continue;

    const price = st.getPrice(sym);
    const longValue  = sharesLong  * price;
    const shortValue = sharesShort * price;
    const longPL  = sharesLong  > 0 ? (price - avgLong)  * sharesLong  - COMMISSION : 0;
    const shortPL = sharesShort > 0 ? (avgShort - price) * sharesShort - COMMISSION : 0;

    totalValue += longValue + shortValue;

    positions.push({
      sym,
      sharesLong,  avgLong,  longValue,  longPL,
      sharesShort, avgShort, shortValue, shortPL,
      price,
      forecast: st.has4SDataTixApi() ? st.getForecast(sym) : null,
    });
  }

  positions.sort((a, b) => (b.longValue + b.shortValue) - (a.longValue + a.shortValue));

  globalThis.gordStockState = {
    tier: st.has4SDataTixApi() ? 2 : st.hasTixApiAccess() ? 1 : 0,
    totalValue,
    positions,
    cash: ns.getPlayer().money,
    updatedAt: Date.now(),
  };
}

// ── Main loop ─────────────────────────────────────────────────────────────────

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  // Arg [0]: the current BitNode (the daemon passes it), for the one stocks
  // setting that is per-node - what 4S really costs there.
  fourSigmaCostMult = forNode(Number(ns.args[0] ?? 0)).stocks.fourSigmaCostMult;

  const st = ns.stock;

  // Determine if we can short (requires SF 8 or BN 8)
  // We probe by checking if shortStock exists and calling it with 0 shares — it
  // will error or return 0 without actually transacting. Safer: just try and catch.
  let canShort = false;
  try {
    // If we have no WSE yet this will throw; that's fine.
    if (st.hasTixApiAccess()) {
      // Attempt a 0-share short — returns 0 (can't short) or throws (no access)
      const testSym = st.getSymbols()[0];
      st.buyShort(testSym, 0);
      canShort = true;
    }
  } catch {
    canShort = false;
  }

  ns.tprint(`[stocks] Starting. Short positions: ${canShort ? "enabled" : "disabled"}`);

  while (true) {
    // ── Upgrade access if affordable ──────────────────────────────────────
    maybeUpgradeAccess(ns);

    // ── Bail out early if we have no TIX API ─────────────────────────────
    if (!st.hasTixApiAccess()) {
      globalThis.gordStockState = { tier: 0, totalValue: 0, positions: [], cash: ns.getPlayer().money, updatedAt: Date.now() };
      // Sleep until we might be able to afford TIX, then recheck
      await ns.sleep(S.noTixSleepMs);
      continue;
    }

    const symbols = st.getSymbols();
    const use4S   = st.has4SDataTixApi();

    // ── Record prices for momentum mode ──────────────────────────────────
    if (!use4S) {
      for (const sym of symbols) recordPrice(sym, st.getPrice(sym));
    }

    // ── Liquidate when the daemon is about to install ─────────────────────
    // An install wipes the stock market: positions held through it are simply
    // lost. So lib/daemon-lib.js maybeInstall stamps gordInstallRequested once
    // it has decided to reset, and holds the reset until this script reports
    // an empty portfolio (or a timeout). The stamp expires by itself in case
    // the daemon changed its mind or died.
    const requested = globalThis.gordInstallRequested ?? 0;
    const installPending = requested > 0 && Date.now() - requested < S.installRequestTtlMs;

    // Hoarding for a money-gated faction invite (globalThis.gordMoneyFloor, set by
    // the daemon): the invite checks LIQUID money, not net worth, so positions must
    // be cashed out and left cashed until the invite fires - otherwise the held
    // capital keeps us under the threshold forever.
    const hoarding = (globalThis.gordMoneyFloor ?? 0) > 0;

    if (hoarding || installPending) {
      // Exit positions so cash is liquid (imminent install, or holding for an invite)
      liquidateAll(ns, symbols);
      exportState(ns, symbols);
      await ns.stock.nextUpdate();
      continue;
    }

    // ── Decide and execute trades ─────────────────────────────────────────
    const allTrades = [];

    for (const sym of symbols) {
      const trades = use4S
        ? decide4S(ns, sym, symbols, canShort)
        : decideMomentum(ns, sym, symbols);

      allTrades.push(...trades);
    }

    // Execute sells before buys so proceeds are available
    const sells = allTrades.filter(t => t.action === "sell" || t.action === "cover");
    const buys  = allTrades.filter(t => t.action === "buy"  || t.action === "short");

    executeTrades(ns, [...sells, ...buys]);

    exportState(ns, symbols);

    // ── Sleep until next market tick ──────────────────────────────────────
    // nextUpdate() resolves exactly when prices update — no busy-polling needed.
    await st.nextUpdate();
  }
}