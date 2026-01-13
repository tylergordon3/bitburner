import { BotNet, rankedTargets } from "lib/botnet.js";
import { hgwAction, prepServer } from "hgw.js";
import { ACTIONS } from "lib/actions.js";


/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("sleep");
    const botnet = new BotNet(ns, "home");
    let target = rankedTargets(botnet)[0];
    while (true) {
        await prepServer(ns, botnet, target.hostname());
        await hgwAction(ns, target.hostname(), botnet, "hack")
        target = rankedTargets(botnet)[0];
        await ns.sleep(1);
    }
}

