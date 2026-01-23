/**
 * Whether stock is favourable for long
 */
export function isLongBullish(portfolio, sym, threshold = 0.525) {
    return portfolio[sym].forecast > threshold;
}

/**
 * Whether stock is favourable for short
 */
export function isShortBearish(portfolio, sym, threshold = 0.5) {
    return portfolio[sym].forecast < threshold;
}

/**
 * Score stock by forecast strength
 */
export function scoreForecast(portfolio, sym) {
    return Math.floor(1e6 * portfolio[sym].forecast);
}

/**
 * Sort symbols descending by forecast
 */
export function rankBullish(portfolio, symbols) {
    return [...symbols].sort(
        (a, b) => scoreForecast(portfolio, b) - scoreForecast(portfolio, a)
    );
}

/**
 * Sort symbols ascending by forecast
 */
export function rankBearish(portfolio, symbols) {
    return [...symbols].sort(
        (a, b) => scoreForecast(portfolio, a) - scoreForecast(portfolio, b)
    );
}
