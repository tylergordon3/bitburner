/**
 * @param {NS} ns 
 * @return {boolean} 
 */
export function have4s(ns) {
    if (!ns.stock.purchase4SMarketData()) {
        return false;
    }

    if (!ns.stock.purchase4SMarketDataTixApi()) {
        return false;
    }
    return true;
}

/**
 * @param {NS} ns
 * @return {boolean}
 */
export function haveWSE(ns) {
     if (!ns.stock.purchaseWseAccount()) {
        return false;
    }

    if (!ns.stock.purchaseTixApi()) {
        return false;
    }
    return true;
}