// ===== API =====
import { getSymbols } from "./api/symbols.js";
import { updateHistory, updateForecast } from "./api/forecast.js";
import { buy, sellAll, canShort } from "./api/trading.js";
import { longShares, shortShares, freeShares } from "./api/position.js";

// ===== LOGIC =====
import { createPortfolio, clearLong, clearShort } from "./logic/portfolio.js";
import {
  rankBullish,
  rankBearish,
  isLongBullish,
  isShortBearish
} from "./logic/scoring.js";
import {
  spendingPower,
  reserveFromProfit
} from "./logic/allocation.js";

/**
 * @param {NS} ns
 */
export async function main(ns) {
  ns.disableLog("ALL");

  const fourS = ns.stock.has4SData();
  const allowShort = canShort(ns);
  const symbols = getSymbols(ns);

  // ---- Init portfolio ----
  const portfolio = createPortfolio(symbols);

  // Seed prices for pre-4S history
  for (const sym of symbols) {
    portfolio[sym].prev = ns.stock.getPrice(sym);
  }

  // Build history (pre-4S only)
  if (!fourS) {
    for (let i = 0; i < 14; i++) {
      await ns.sleep(6_000);
      updateHistory(ns, portfolio, symbols);
    }
  }

  ns.print(`Stock trader started (${fourS ? "4S" : "pre-4S"})`);

  const TICK = 6_000;
  // =========================
  // ===== MAIN LOOP =====
  // =========================
  while (true) {
    const start = Date.now();

    // ---- Update data ----
    if (!fourS) {
      updateHistory(ns, portfolio, symbols);
    }
    updateForecast(ns, portfolio, symbols, fourS);

    const money = ns.getServerMoneyAvailable("home");

    // =====================
    // ===== SELL LOGIC =====
    // =====================

    for (const sym of symbols) {
      // Sell long if no longer bullish
      if (longShares(ns, sym) > 0 && !isLongBullish(portfolio, sym)) {
        const revenue = longShares(ns, sym) * ns.stock.getBidPrice(sym);
        sellAll(ns, sym, "Long");

        const profit = revenue - portfolio[sym].costLong - 100_000;
        portfolio.reserve += reserveFromProfit(
          money,
          portfolio,
          profit
        );
        clearLong(portfolio, sym);
      }

      // Sell short if no longer bearish
      if (
        allowShort &&
        shortShares(ns, sym) > 0 &&
        !isShortBearish(portfolio, sym)
      ) {
        const revenue = shortShares(ns, sym) * ns.stock.getAskPrice(sym);
        sellAll(ns, sym, "Short");

        const profit = revenue - portfolio[sym].costShort - 100_000;
        portfolio.reserve += reserveFromProfit(
          money,
          portfolio,
          profit
        );
        clearShort(portfolio, sym);
      }
    }

    // ====================
    // ===== BUY LOGIC =====
    // ====================

    const funds = spendingPower(money, portfolio.reserve);
    if (funds >= 5_000_000) {
      // ---- Buy longs ----
      const bullish = rankBullish(portfolio, symbols)
        .filter((s) => isLongBullish(portfolio, s))
        .slice(0, 3);

      for (const sym of bullish) {
        if (freeShares(ns, sym) <= 0) continue;

        const cost = buy(ns, sym, funds, "Long");
        if (cost > 0) {
          portfolio[sym].costLong += cost;
          portfolio[sym].commissionLong += 100_000;
        }
      }

      // ---- Buy shorts ----
      if (allowShort) {
        const bearish = rankBearish(portfolio, symbols)
          .filter((s) => isShortBearish(portfolio, s))
          .slice(0, 3);

        for (const sym of bearish) {
          if (freeShares(ns, sym) <= 0) continue;

          const cost = buy(ns, sym, funds, "Short");
          if (cost > 0) {
            portfolio[sym].costShort += cost;
            portfolio[sym].commissionShort += 100_000;
          }
        }
      }
    }

    const elapsed = Date.now() - start;
    await ns.sleep(Math.max(0, TICK - elapsed));
  }
}
