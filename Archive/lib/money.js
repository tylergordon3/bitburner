/**
 * A class to hold information about money.
 */

/**
 * The amount of money the player has.
 *
 * @param {NS} ns The Netscript API.
 * @returns {number} Our current amount of money.
 */
export function money(ns) {
    return ns.getServerMoneyAvailable("home");
}