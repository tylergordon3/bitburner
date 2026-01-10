/** @param {NS} ns */
export class Server {
    /** @type {string} */
    #hostname;

    /** @type {NS} */
    #ns;

    /**
     * @param {NS} ns
     * @param {string} host
     */
    constructor(ns, host) {
        this.#ns = ns;
        this.#hostname = ns.getServer(host).hostname;
    }

    /**
     * @returns {number}
     */ 
    ram_max() {
        return this.#ns.getServer(this.hostname()).maxRam;
    }

    /**
     * @returns {number}
     */
    ram_used() {
        return this.#ns.getServer(this.hostname()).ramUsed;
    }
    
    /**
     * @returns {number}
     */
    ram_free() {
        return this.ram_max() - this.ram_used();
    }

    /**
     * @returns {boolean}
     */
    have_root() {
        return this.#ns.getServer(this.hostname()).hasAdminRights;
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
        return this.#ns.getServerNumPortsRequired(this.hostname())
    }

    /**
     * @return {boolean}
     */
    nuke() {
        if (this.have_root()) { return true }

        /** @type {[string, (host: string) => void][]} */
        const tools = [
            ["BruteSSH.exe", this.#ns.brutessh],
            ["FTPCrack.exe", this.#ns.ftpcrack],
            ["HTTPWorm.exe", this.#ns.httpworm],
            ["relaySMTP.exe", this.#ns.relaysmtp],
            ["SQLInject.exe", this.#ns.sqlinject],
        ];

        let opened = 0
        for (const [file, fun] of tools) {
            if (opened >= this.numPortRequired()) { break; }
            if (this.#ns.fileExists(file, "home")) {
                fun.call(this.#ns, this.hostname());
                opened++;
            }
        }

        if (opened >= this.numPortRequired()) {
            this.#ns.nuke(this.hostname());
            return true;
        }
        return false;
    }
}

/**
 * @param {NS} ns
 * @param {string} script
 * @param {string} host
 * @returns {number}
 */
export function thread_count(ns, script, host) {
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
export function can_run_script(ns, script, host) {
    return thread_count(ns, script, host) > 0
}
