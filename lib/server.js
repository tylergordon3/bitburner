import { SERVERS } from "./server-names.js";

/** @param {NS} ns */
export class Server {
    /** @type {string} */
    #hostname;

    /** @type {NS} */
    #ns;

    #server;

    /**
     * @param {NS} ns
     * @param {string} host
     */
    constructor(ns, host) {
        this.#ns = ns;
        this.#hostname = ns.getServer(host).hostname;
        this.refresh();
    }

    refresh() {
        this.#server = this.#ns.getServer(this.#hostname);
    }

    /**
     * @returns {number}
     */ 
    maxRam() {
        return this.#server.maxRam;
    }

    /**
     * @returns {number}
     */
    usedRam() {
        return this.#server.ramUsed;
    }
    
    /**
     * @returns {number}
     */
    freeRam() {
        return this.#server.maxRam - this.#server.ramUsed;
    }

    /**
     * @returns {boolean}
     */
    hasRoot() {
        return this.#server.hasAdminRights;
    }

    /** 
     * @returns {string}
    */
    hostname() {
        return this.#hostname;
    }

    /**
     * @returns {number}
     */
    numPortRequired() {
        return this.#server.numOpenPortsRequired ?? 0;
    }

    /**
     * @return {boolean}
     */
    nuke() {
        const ns = this.#ns;
        const host = this.#hostname;

        this.refresh()
        const s = ns.getServer(host);

        if (this.#server.hasAdminRights) return true;

        const required = this.#server.numOpenPortsRequired ?? 0;
        let opened = 0

        /** @type {[string, (host: string) => void][]} */
        const tools = [
            ["BruteSSH.exe", (host) => ns.brutessh(host)],
            ["FTPCrack.exe", (host) => ns.ftpcrack(host)],
            ["HTTPWorm.exe", (host) => ns.httpworm(host)],
            ["relaySMTP.exe", (host) => ns.relaysmtp(host)],
            ["SQLInject.exe", (host) => ns.sqlinject(host)],
        ];

        for (const [file, fn] of tools) {
            if (opened >= required) { break; }
            if (ns.fileExists(file, "home")) {
                fn(host);
                opened++;
            }
        }

        if (opened >= required) {
            ns.nuke(host);
            this.refresh()
            return true;
        }
        return false;
    }

    /**
     * @return {number}
     */
    score() {
        this.refresh();

        const server = this.#ns.getServer(this.#hostname)
        const threshold = Math.floor(this.#ns.getHackingLevel() / 2);

        if (
            server.hostname === SERVERS.home
            || server.purchasedByPlayer
            || !server.hasAdminRights
            || server.requiredHackingSkill > threshold
        ) {
            return 0;
        }
        return server.moneyMax / server.minDifficulty;
        }
    }

/**
 * @param {NS} ns
 * @param {string} script
 * @param {string} host
 * @returns {number}
 */
export function threadCount(ns, script, host) {
    const script_ram = ns.getScriptRam(script, "home");
    const { maxRam, ramUsed } = ns.getServer(host);
    const avail_ram = maxRam - ramUsed;
    if (avail_ram < script_ram) {
        return 0;
    }
    return Math.floor(avail_ram/script_ram);
}

/**
 * @param {NS} ns
 * @param {string} script
 * @param {string} host
 * @returns {boolean}
 */
export function checkScript(ns, script, host) {
    return threadCount(ns, script, host) > 0
}
