/**
 * Initialize empty portfolio state
 * @param {string[]} symbols
 */
export function createPortfolio(symbols) {
    const portfolio = { reserve: 0 };

    for (const sym of symbols) {
        portfolio[sym] = {
            forecast: 0,
            prev: 0,
            hist: [],
            costLong: 0,
            costShort: 0,
            commissionLong: 0,
            commissionShort: 0,
        };
    }

    return portfolio;
}

/**
 * Reset long position accounting
 */
export function clearLong(portfolio, sym) {
    portfolio[sym].costLong = 0;
    portfolio[sym].commissionLong = 0;
}

/**
 * Reset short position accounting
 */
export function clearShort(portfolio, sym) {
    portfolio[sym].costShort = 0;
    portfolio[sym].commissionShort = 0;
}
