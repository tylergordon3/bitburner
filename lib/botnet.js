import { Server } from "lib/server.js";
import { weight } from "../weight";

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
        // this.discover(start);
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

}