import { freeShares, longShares, shortShares } from "./position.js";

/**
 * Detect shorting capability
 * @param {NS} ns
 */
export function canShort(ns) {
    try {
        ns.stock.buyShort("FSIG", 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * Buy shares (long or short)
 * @param {NS} ns
 * @param {string} sym
 * @param {number} funds
 * @param {"Long"|"Short"} side
 */
export function buy(ns, sym, funds, side) {
    const max = freeShares(ns, sym);
    if (max <= 0) return 0;

    let price = ns.stock.getAskPrice(sym);
    if (side === "Short") price = ns.stock.getBidPrice(sym);

    const shares = Math.min(Math.floor(funds / price), max);
    if (shares < 1) return 0;

    return side === "Long"
        ? ns.stock.buyStock(sym, shares)
        : ns.stock.buyShort(sym, shares);
}

/**
 * Sell all shares
 * @param {NS} ns
 * @param {string} sym
 * @param {"Long"|"Short"} side
 */
export function sellAll(ns, sym, side) {
    if (side === "Long") {
        const n = longShares(ns, sym);
        if (n > 0) ns.stock.sellStock(sym, n);
    } else {
        const n = shortShares(ns, sym);
        if (n > 0) ns.stock.sellShort(sym, n);
    }
}
