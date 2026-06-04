/**
 * Cached symbol list to avoid repeated API cost
 * @param {NS} ns
 * @returns {string[]}
 */
export function getSymbols(ns) {
    return ns.stock.getSymbols();
}
