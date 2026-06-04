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
        this.init(start);
        this.scp_scripts();
    }

    /**
     * BFS
     * @param {string} start
     */
    init(start) {
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
                // serv.addEdge(neighbor);
                if (!this.discovered.has(neighbor)) {
                    this.discovered.add(neighbor);
                    queue.push(neighbor);
                }
            }
        }
        this.ns.print("SUCCESS Completed server walk.")
    }

    walk() {
        for (const [name, serv] of this.unrooted_servers) {
            if (!this.rooted_servers.has(name)) {
                serv.refresh();
                if (serv.nuke()) {
                    this.rooted_servers.set(name, serv);
                    this.unrooted_servers.delete(name);
                    this.ns.tprint(`We have successfully rooted: ${name}`);
                }
            }
        }
    }
    
    /**
     * 
     * @param {Array<string>} queue 
     * @param {Map} dist 
     * @returns {string}
     */
    mindist(queue, dist) {
        let node = queue[0];
        for (const v of queue) {
            if (dist.get(v) < dist.get(node)) {
                node = v;
            }
        }
        return node;
    }

    dijkstra() {
        const dist = new Map();
        const prev = new Map();
        let queue = [];

        for (const v of this.discovered) {
            dist.set(v, Infinity);
            prev.set(v, undefined);
            queue.push(v);
        }

        dist.set("home", 0);
        prev.set("home", undefined);
        queue.push("home");

        const weight = 1;
        while (queue.length > 0) {
            const u = this.mindist(queue, dist);
            queue = queue.filter((s) => s !== u);
            
            let neighbor = []
            for (const n of this.ns.scan(u)) {
                neighbor.push(n);
            }
            neighbor = neighbor.filter((s) => queue.includes(s));
            for (const v of neighbor) {
                const alt = dist.get(u) + weight;

                if (alt < dist.get(v)) {
                    dist.set(v, alt);
                    prev.set(v, u);
                }
            }
        }
        return [dist, prev];
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

