import {
    initial_portfolio,
    update_history,
    can_short,
    transaction
} from "wse"

/**
 * 
 * @param {NS} ns 
 */
export async function main(ns) {
    const allow_short = can_short(ns);
    ns.print("INFO Trading on the Stock Market, pre-4S");
    let portfolio = await initial_portfolio(ns, false);
    for (;;) {
        await ns.sleep(3e6);
        portfolio = update_history(ns, portfolio);
        portfolio = await transaction(ns, portfolio, false, allow_short);
    }
}