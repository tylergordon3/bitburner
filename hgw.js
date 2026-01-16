import { ACTIONS } from "lib/actions.js";
import { SERVERS } from "lib/server-names.js";
import { BotNet } from "./lib/botnet";
import { checkScript, Server, threadCount } from "./lib/server";

/**
 * @param {NS} ns 
 * @param {string} host 
 * Source:  Sourced: https://github.com/quacksouls/bitwalk/tree/main
 */
export function atMaxMoney(ns, host) {
    const { moneyAvailable, moneyMax } = ns.getServer(host);
    return moneyAvailable >= moneyMax;
}

/**
 * @param {NS} ns 
 * @param {string} host 
 * Sourced: https://github.com/quacksouls/bitwalk/tree/main
 */
export function atMinSecurity(ns, host) {
    const { hackDifficulty, minDifficulty } = ns.getServer(host);
    return hackDifficulty <= minDifficulty;
}

/**
 * @param {NS} ns 
 * @param {string} host 
 */
export function donePrep(ns, host) {
    return atMaxMoney(ns, host) && atMinSecurity(ns, host);
}

/**
 * 
 * @param {NS} ns 
 * @param {string} host 
 * @param {string} action 
 */
export function hgwTiming(ns, host, action) {
    switch (action) {
        case ACTIONS.grow:
            return ns.getGrowTime(host);
        case ACTIONS.hack:
            return ns.getHackTime(host);
        case ACTIONS.weaken:
            return ns.getWeakenTime(host);
        default:
            return 0;
    }
}

/**
 * @param {string} action 
 */
export function hgwScript(action) {
    const script = ACTIONS[action];
    if (!script) {
        throw new Error(`Unknown HGW action: ${action}`);
    }
    return script
}

/**
 * 
 * @param {NS} ns 
 * @param {BotNet} botnet
 * @param {string} host 
 */
export async function prepServer(ns, botnet, host) {
    ns.print(`INFO Running prepServer on botner for: ${host}`)
    const script = [ACTIONS.grow, ACTIONS.hack, ACTIONS.weaken];
    const scp = (serv) => ns.scp(script, serv.hostname(), SERVERS.home);
    for (;;) {
        botnet.rooted_servers.forEach(scp);
        if (!atMinSecurity(ns, host)) {
            await hgwAction(ns, host, botnet, "weaken");
        }
        if (!atMaxMoney(ns, host)) {
            await hgwAction(ns, host, botnet, "grow");
        }
        if (donePrep(ns, host)) {
            return;
        }
        await ns.sleep(0)
    }
}


/**
 * @param {NS} ns 
 * @param {number[]} pid 
 */
export async function is_action_done(ns, pid) {
    const is_done = (i) => !ns.isRunning(i);
    return pid.every(is_done);
}


/**
 * Source: https://github.com/quacksouls/bitwalk/blob/main/src/lib/hgw.js#L101
 * @param {NS} ns 
 * @param {string} host 
 * @param {BotNet} botnet 
 * @param {string} action 
 */
export async function hgwAction(ns, host, botnet, action) {
    ns.print(`INFO Running ${action} on ${host} with botnet.`)
    const time = hgwTiming(ns, host, action);
    const script = hgwScript(action);
    const hasRamForScript = (serv) => checkScript(ns, script, serv.hostname());
    const nthread = (serv) => threadCount(ns, script, serv.hostname());
    const runScript = (serv) => {
        const option = { preventDuplicates: true, threads: nthread(serv) };
        return ns.exec(script, serv.hostname(), option, host);
    }

    const pids = [];
    botnet.server_walk("home")
    for (const serv of botnet.rooted_servers.values()) {
        serv.refresh();
        
        if (!hasRamForScript(serv)) continue;
        
        const pid = runScript(serv);
        if (pid != 0) {
            pids.push(pid)
        }
    }

    while (!(await is_action_done(ns, pids))) {
        await ns.sleep(100);
    }
}