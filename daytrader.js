import { have4s, haveWSE } from "./stonks/validate_wse.js";

/**
 * 
 * @param {NS} ns 
 */
export async function main(ns) {
    while (!haveWSE(ns)) {
        await ns.sleep(6e3);
    }
    const option = {preventDuplicates : true, threads: 1};
    const pid = ns.exec('stonks/pre4s.js', "home", option);

    while (!have4s(ns)) {
        await ns.sleep(3e6);
    }
    ns.kill(pid);
}