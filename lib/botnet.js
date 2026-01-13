import { Server } from "lib/server.js";
import { ACTIONS } from "lib/actions.js";

/** @param {NS} ns */
export class BotNet {
    /** @type {NS} */
    ns;

    /** @type {Map<string, Server>} */
    rooted_servers = new Map();

    /** @type {Map<string, Server>} */
    unrooted_servers = new Map();

    /** @type {Set<string>} */
    discovered = new Set();

    /**
     * @param {NS} ns
     * @param {string} [start="home"]
     */
    constructor(ns, start = "home") {
        this.ns = ns;
        this.server_walk(start);
        this.scp_scripts();
    }

    /**
     * BFS
     * @param {string} start
     */
    server_walk(start) {
        const queue = [start];
        this.discovered.add(start);

        while (queue.length > 0) {
            const host = queue.shift()
            
            if (!this.rooted_servers.has(host)) {
                const serv = new Server(this.ns, host);
                serv.refresh()
                if (serv.nuke()) {this.rooted_servers.set(host, serv)}
                else {this.unrooted_servers.set(host, serv)}
            }

            for (const neighbor of this.ns.scan(host)) {
                if (!this.discovered.has(neighbor)) {
                    this.discovered.add(neighbor);
                    queue.push(neighbor);
                }
            }
        }
    }

    scp_scripts(opts = {}) {
        const {
        includeHome = false,
        includePurchased = true,
        force = false,
        } = opts;

        const scripts = [
            ACTIONS.grow,
            ACTIONS.hack,
            ACTIONS.weaken,
        ];
       
        for (const serv of this.rooted_servers.values()) {
            serv.refresh();
            const host = serv.hostname();
            
            if (!includeHome && host === "home") continue;
            if (!includePurchased && this.ns.getPurchasedServers().includes(host)) continue;

            const toCopy = force
            ? scripts
            : scripts.filter(f => !this.ns.fileExists(f, host));

            if (toCopy.length === 0) continue;

            this.ns.scp(toCopy, host, "home");
         }
    }
}

/**
 * @param {BotNet} botnet
 */
export function rankedTargets(botnet) {
    /** @type {[Server, number][]} */
    const scored = [];

    for (const s of botnet.rooted_servers.values()) {
        s.refresh();
        scored.push([s, s.score()]);
    }

    return scored
        .sort((a, b) => b[1] - a[1])
        .map(([s]) => s);
}

