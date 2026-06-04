/**
 * Determine how much money can be spent safely
 */
export function spendingPower(money, reserve, fraction = 0.025) {
    const excess = money - reserve;
    if (excess <= 0) return 0;
    return Math.floor(fraction * excess) - 100_000;
}

/**
 * Decide how much profit to keep as reserve
 */
export function reserveFromProfit(money, portfolio, profit) {
    let keepMult = 0.1;

    while (keepMult > 0) {
        const keep = Math.floor(keepMult * profit);
        const excess = money - (portfolio.reserve + keep);
        if (Math.floor(0.025 * excess) >= 5_000_000) {
            return Math.max(0, keep);
        }
        keepMult -= 0.01;
    }
    return 0;
}
