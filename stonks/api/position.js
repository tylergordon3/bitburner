/**
 * @param {NS} ns
 * @param {string} sym
 */
export function longShares(ns, sym) {
    return ns.stock.getPosition(sym)[0];
}

/**
 * @param {NS} ns
 * @param {string} sym
 */
export function shortShares(ns, sym) {
    return ns.stock.getPosition(sym)[2];
}

/**
 * @param {NS} ns
 * @param {string} sym
 */
export function freeShares(ns, sym) {
    const max = ns.stock.getMaxShares(sym);
    return max - longShares(ns, sym) - shortShares(ns, sym);
}
