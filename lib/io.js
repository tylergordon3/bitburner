import { is_empty_string } from  "../lib/util.js";

/**
 * Print a log to the terminal.
 *
 * @param {NS} ns The Netscript API.
 * @param {string} msg Print this message to the terminal.
 * @param {string} clr Use this colour to print the given message.  Must be a
 *     string representation of a Unicode escape sequence.  Default is empty
 *     string, which means we use the default colour theme of the terminal.
 */
export function log(ns, msg, clr = "") {
    const date = new Date(Date.now()).toISOString();
    const suffix = is_empty_string(clr) ? "" : "\u001b[0m";
    ns.tprintf(`[${date}] ${clr}${ns.getScriptName()}: ${msg}${suffix}`);
}