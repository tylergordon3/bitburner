import { ACTIONS } from "lib/actions.js";
import { SERVERS } from "lib/server-names.js";

/** 
 * @param {NS} ns 
 * @param {string} host
*/
export async function prep_server(ns, host) {
    const scripts = [ACTIONS.hack, ACTIONS.grow, ACTIONS.weaken, ACTIONS.share]
    const scp = (serv) => ns.scp(scripts, serv, SERVERS.home)
    for (;;) {
        // const botnet
    }
}