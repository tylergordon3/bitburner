
/**
 * @param {NS} ns 
 * @param {string} sym 
 */
export function num_in_long(ns, sym) {
    return ns.stock.getPosition(sym)[0];
}

/**
 * @param {NS} ns 
 * @param {string} sym 
 * @returns 
 */
export function num_in_short(ns, sym) {
    return ns.stock.getPosition(sym)[2];
}

/**
 * @param {NS} ns 
 * @param {string} sym 
 */
function free_shares(ns, sym) {
    const max_shares = ns.stock.getMaxShares(sym);
    return max_shares - num_in_long(ns, sym) - num_in_short(ns, sym);
}

/**
 * @param {NS} ns 
 */
export function can_short(ns) {
    try {
        ns.stock.buyShort("FSIG", 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * 
 * @param {NS} ns 
 * @param {object} portfolio 
 * @returns 
 */
function has_money_reserve(ns, portfolio) {
    return ns.getServerMoneyAvailable("home") > portfolio.reserve;
}

function expenditure(ns, portfolio) {
    const excess_money = ns.getServerMoneyAvailable("home") - portfolio.reserve;
    const fraction = 0.025;
    return Math.floor(fraction * excess_money) - 100e3;
}
/**
 * 
 * @param {NS} ns 
 * @param {string} sym 
 * @param {object} portfolio 
 * @param {string} position 
 */
function num_shares(ns, sym, portfolio, position) {
    if (!has_money_reserve(ns, portfolio)) {
        return 0;
    }
    const funds = expenditure(ns, portfolio);
    if (funds < 5e6) {
        return 0;
    }

    const max_share = free_shares(ns, sym);
    if (max_share < 1) {
        return 0;
    }

    let nshare = Math.floor(funds / ns.stock.getAskPrice(sym));
    if (position === "Short") {
        nshare = Math.floor(funds / ns.stock.getBidPrice(sym));
    }
    return Math.min(nshare, max_share);
}
/**
 * 
 * @param {string} sym 
 * @param {object} portfolio 
 * @param {string} position 
 * @returns 
 */
function total_fees(sym, portfolio, position) {
    if (position === "Long") {
        return 100e3 + portfolio[sym].commission_long;
    }
    return 100e3 + portfolio[sym].comission_short;
}

function total_cost(sym, portfolio, position) {
    if (position === "Long") {
        return portfolio[sym].const_long;
    }
    return portfolio[sym].const_short;
}
/**
 * @param {NS} portfolio 
 * @param {string} sym 
 * @returns 
 */
function is_favourable_long(portfolio, sym) {
    return portfolio[sym].forecast > 0.5;
}

/**
 * 
 * @param {NS} ns 
 * @param {string} sym 
 * @param {string} position 
 * @returns 
 */
function sell_revenue(ns, sym, position) {
    if (position === "Long") {
        return num_in_long(ns, sym) * ns.stock.getBidPrice(sym);
    }
    return num_in_short(ns, sym) * ns.stock.getAskPrice(sym);
}

/**
 * 
 * @param {NS} ns 
 * @param {string} sym 
 * @param {object} portfolio 
 * @param {string} position 
 */
function sell_profit(ns, sym, portfolio, position) {
    return (
        sell_revenue(ns, sym, position)
        - total_fees(sym, portfolio, position)
        - total_cost(sym, portfolio, position)
    );
}
/**
 * 
 * @param {NS} ns 
 * @param {object} portfolio 
 * @param {string} position 
 */
function sell_candidate(ns, portfolio, position) {
    let has_shares = null;
    let fovourable = null;
    if (position === "Long") {
        has_shares = (sym) => num_in_long(ns, sym) > 0;
        fovourable = (sym) => !is_favourable_long(portfolio, sym);
    } else {
        has_shares = (sym) => num_in_short(ns, sym) > 0;
        fovourable = (sym) => is_favourable_long(portfolio, sym);
    }

    const stock = ns.stock.getSymbols().filter(has_shares).filter(fovourable);
    const profit = (sym) => sell_profit(ns, sym, portfolio, position);
    const can_profit = (sym) => profit(sym) > 0;
    const descending = (syma, symb) => profit(syma) - profit(symb);
    const candidate = stock.filter(can_profit);
    candidate.sort(descending);
    return candidate.length == 0 ? "" : candidate[0];
}

/**
 * 
 * @param {NS} ns 
 * @param {object} portfolio 
 * @param {number} profit 
 */
async function profit_to_keep(ns, portfolio, profit) {
    const new_money = ns.getServerMoneyAvailable("home");

    const has_funds = (keep_amount) => {
        const new_reserve = portfolio.reserve + keep_amount;
        const excess_money = new_money - new_reserve;
        const funds = Math.floor(.025 * excess_money);
        return funds >= 5e6;
    };

    let keep_mult = 0.1;
    let keep = Math.floor(keep_mult * profit);
    while (!has_funds(keep)) {
        keep_mult -= 0.01;
        if (keep_mult <= 0) {
            keep = 0;
            break;
        }
        keep = Math.floor(keep_mult * profit);
        await ns.sleep(1);
    }
    return keep < 0 ? 0 : keep;
}

/**
 * 
 * @param {NS} ns 
 * @param {object} portfolio 
 * @param {string} position 
 * @returns 
 */
function buy_stock(ns, portfolio, position) {
    let stock = most_favourable(ns, portfolio);
    if (position === "Short") {
        stock = least_favourable(ns, portfolio);
    }

    if (stock.length == 0) {
        return portfolio;
    }

    const new_portfolio = { ...portfolio };
    for (const sym of stock) {
        const nshare = num_shares(ns, sym, new_portfolio, position);
        if (nshare < 1) {
            continue;
        }

        let cost_per_share = 0;
        if (position === "Long") {
            cost_per_share  = ns.stock.buyStock(sym, nshare);
        } else {
            cost_per_share = ns.stock.buyShort(sym, nshare);
        }
        if (cost_per_share === 0) {
            continue;
        }

        if (position === "Long") {
            new_portfolio[sym].const_long += nshare * cost_per_share;
            new_portfolio[sym].comission_long += 100e3;
        } else {
            new_portfolio[sym].cost_short += nshare * cost_per_share;
            new_portfolio[sym].commission_short += 100e3;
        }
    }
    return new_portfolio;
}

/**
 * 
 * @param {NS} ns 
 * @param {object} portfolio 
 */
async function sell_stock_short(ns, portfolio) {
    const new_portfolio = { ...portfolio };
    const sym = sell_candidate(ns, new_portfolio, "Short");
    if (sym.length == 0) {
        return portfolio;
    }

    const profit = sell_profit(ns, sym, new_portfolio, "Short");
    const nshare = num_in_short(ns, sym);
    const result = ns.stock.sellShort(sym, nshare);
    const keep = await profit_to_keep(ns, new_portfolio, profit);
    new_portfolio.reserve += keep;
    new_portfolio[sym].cost_short = 0;
    new_portfolio[sym].commission_short = 0;
    return new_portfolio;
}

/**
 * 
 * @param {NS} ns 
 * @param {object} portfolio 
 */
async function sell_stock_long(ns, portfolio) {
    const new_portfolio = { ...portfolio };
    const sym = sell_candidate(ns, new_portfolio, "Long");
    if (sym.length == 0) {
        return portfolio;
    }

    const profit = sell_profit(ns, sym, new_portfolio, "Long");
    const nshare = num_in_long(ns, sym);
    const result = ns.stock.sellStock(sym, nshare);
    if (result != 0) {
        throw new Error('Assertion failed.');
    }
    const keep = await profit_to_keep(ns, new_portfolio, profit);
    new_portfolio.reserve += keep;
    new_portfolio[sym].const_long = 0;
    new_portfolio[sym].comission_long = 0;
    return new_portfolio;
}

/**
 * 
 * @param {NS} ns 
 * @param {object} portfolio 
 * @param {boolean} allow_short 
 */
async function sell_stock(ns, portfolio, allow_short) {
    let new_portfolio = await sell_stock_long(ns, portfolio);
    if (allow_short) {
        new_portfolio = await sell_stock_short(ns, new_portfolio);
    }
    return new_portfolio;
}
/**
 * 
 * @param {NS} ns 
 * @param {object} portfolio 
 * @param {boolean} fourS 
 */
function get_forecast(ns, portfolio, fourS) {
    const new_portfolio = { ...portfolio };
    if (fourS) {
        ns.stock.getSymbols().forEach((sym) => {
            new_portfolio[sym].forecast = ns.stock.getForecast(sym);
        });
    } else {
        const sum = (sym) => new_portfolio[sym].history.reduce(
            (accumulator, currVal) => accumulator + currVal,
            0
        );
        const stock_forecast = (sym) => sum(sym) / 14;
        ns.stock.getSymbols().forEach((sym) => {
            new_portfolio[sym].forecast = stock_forecast(sym);
        });
    }
    return new_portfolio;
}

/**
 * 
 * @param {NS} ns 
 * @param {object} portfolio 
 * @param {boolean} fourS 
 * @param {boolean} allow_short 
 */
export async function transaction(ns, portfolio, fourS, allow_short) {
    let new_portfolio = get_forecast(ns, portfolio, fourS);
    new_portfolio = await sell_stock(ns, new_portfolio, allow_short);
    new_portfolio = buy_stock(ns, new_portfolio, "Long");
    if (allow_short) {
        new_portfolio = buy_stock(ns, new_portfolio, "Short");
    }
    return new_portfolio;
}

/**
 * @param {NS} ns 
 * @param {object} portfolio 
 */
function most_favourable(ns, portfolio) {
    const is_favourable = (sym) => portfolio[sym].forecast > 0.525;
    const to_int = (n) => Math.floor(1e6 * n);
    const projection = (sym) => to_int(portfolio[sym].forecast);
    const descending = (syma, symb) => projection(symb) - projection(syma);
    let stock = ns.stock.getSymbols().filter(is_favourable);
    stock.sort(descending);

    const can_buy = (sym) => free_shares(ns, sym) > 0;
    stock = stock.filter(can_buy);
    return stock.length == 0 ? [] : stock.slice(0, 3);
}

/**
 * @param {NS} ns 
 * @param {object} portfolio 
 */
function least_favourable(ns, portfolio) {
    const not_favourable = (sym) => portfolio[sym].forecast < 0.5;
    const to_int = (n) => Math.floor(1e6 * n);
    const projection = (sym) => to_int(portfolio[sym].forecast);
    const ascending = (syma, symb) => projection(syma) - projection(symb);
    let stock = ns.stock.getSymbols().filter(not_favourable);
    stock.sort(ascending);

    const can_buy = (sym) => free_shares(ns, sym) > 0;
    stock = stock.filter(can_buy);
    return stock.length == 0 ? [] : stock.slice(0, 3);
}

/**
 * 
 * @param {NS} ns 
 * @param {object} portfolio 
 */
export function update_history(ns, portfolio) {
    const new_portfolio = { ...portfolio };
    const to_binary = (ratio) => (ratio > 1 ? 1 : 0);
    const update_price = (sym) => {
        const current_price = ns.stock.getPrice(sym);
        const ratio = current_price / new_portfolio[sym].prev_price;

        new_portfolio[sym].history.unshift(to_binary(ratio));
        if (new_portfolio[sym].history.length > 14) {
            new_portfolio[sym].history.pop();
        }
        new_portfolio[sym].prev_price = current_price;
    };
    ns.stock.getSymbols().forEach(update_price);
    return new_portfolio;
}

/**
 * @param {NS} ns 
 * @param {object} portfolio 
 */
async function populate_history(ns, portfolio) {
    let new_portfolio = { ...portfolio };
    const set_init_price = (sym) => {
        new_portfolio[sym].prev_price = ns.stock.getPrice(sym);
    };
    ns.stock.getSymbols().forEach(set_init_price);

    for (let i = 0; i < 14; i++) {
        await ns.sleep(6e3);
        new_portfolio = update_history(ns, new_portfolio);
    }
    return new_portfolio;
}

/**
 * @param {NS} ns 
 * @param {boolean} fourS 
 */
export async function initial_portfolio(ns, fourS) {
    const portfolio = {
        reserve: 0,
    };
    const add_stock = (sym) => {
        portfolio[sym] = {
            const_long: 0,
            const_short: 0,
            comission_long: 0,
            comission_short: 0,
            forecast: 0,
            history: [],
            prev_price: 0,
        };
    };
    ns.stock.getSymbols().forEach(add_stock);
    return fourS ? portfolio : populate_history(ns, portfolio);
}

