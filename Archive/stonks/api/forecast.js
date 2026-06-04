/**
 * Update binary price history (pre-4S)
 * @param {NS} ns
 * @param {object} portfolio
 * @param {string[]} symbols
 */
export function updateHistory(ns, portfolio, symbols) {
    for (const sym of symbols) {
        const price = ns.stock.getPrice(sym);
        const ratio = price / portfolio[sym].prev;

        portfolio[sym].hist.unshift(ratio > 1 ? 1 : 0);
        if (portfolio[sym].hist.length > 14) {
            portfolio[sym].hist.pop();
        }
        portfolio[sym].prev = price;
    }
}

/**
 * Forecast using either 4S or history
 * @param {NS} ns
 * @param {object} portfolio
 * @param {string[]} symbols
 * @param {boolean} fourS
 */
export function updateForecast(ns, portfolio, symbols, fourS) {
    if (fourS) {
        for (const sym of symbols) {
            portfolio[sym].forecast = ns.stock.getForecast(sym);
        }
        return;
    }

    for (const sym of symbols) {
        const sum = portfolio[sym].hist.reduce((a, b) => a + b, 0);
        portfolio[sym].forecast = sum / 14;
    }
}
