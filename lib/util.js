/**
 * SOURCE: https://github.com/quacksouls/bitburner/blob/main/src/lib/util.js
 */

import { LocationName, UniversityLocationName } from "../NetscriptDefinitions";

/**
 * Execute a script on the home server and using 1 thread.
 *
 * @param {NS} ns The Netscript API.
 * @param {string} s The name of the script to run.
 * @returns {number} The PID of the running script.
 */
export function exec(ns, s) {
    const option = { preventDuplicates: true, threads: 1 };
    return ns.exec(s, "home", option);
}

/**
 * @param {any} cond Assert that condition is true
 * @throws {Error} Throw an assertion error if the given condition is false.
 */
export function assert(cond) {
    if (!cond) {
        throw new Error("Assertion failed");
    }
}

/**
 * Whether a string is empty.
 *
 * @param {LocationName | string} str Test this string.
 * @returns {boolean} True if the given string is empty; false otherwise.
 */
export function is_empty_string(str) {
    return typeof str === "string" && str === "" && str.length === 0;
}

/**
 * Whether we have a particular program.
 *
 * @param {NS} ns The Netscript API.
 * @param {string} prog Do we have this program?
 * @returns {boolean} True if we have the given program; false otherwise.
 */
export function has_program(ns, prog) {
    return ns.fileExists(prog, "home");
}