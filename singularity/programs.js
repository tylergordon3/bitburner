import { darkweb } from "../lib/constants/tor";
import { has_program } from "../lib/util";

/**
 * 
 * @param {NS} ns 
 */
export async function buyTOR(ns) {
    if (ns.singularity.purchaseTor()) {
        return true;
    }

    if (!ns.scriptRunning("stargate.js", "home")) {
        ns.run("stargate.js", 1);
        ns.tprint("Cannot buy TOR. Launched stargate.js");
    } else {
        ns.tprint("Cannot buy TOR. Stargate is already running.");
    }

    return false
}

/**
 * 
 * @param {NS} ns 
 */
export async function buyPrograms(ns) {
    Object.values(darkweb.program).forEach(value => {
        if (!has_program(ns, value.NAME)) {
            ns.singularity.purchaseProgram(value.NAME); 
    }})
}