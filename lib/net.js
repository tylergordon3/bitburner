// lib/net.js
//
// Network primitives shared across the codebase: a breadth-first walk of every
// reachable host (allServers), a home->target path finder (pathTo, used by
// lib/backdoor.js to route ns.connect), and the port-opener + nuke rooting routine
// (root). Depends only on lib/config.js (for the port-opener list and the home
// name), so importing it is cheap - the only Netscript it contributes is the
// scan/nuke/port calls its callers were going to make anyway.

import { CONFIG } from "./config.js";

const HOME = CONFIG.paths.home;

/**
 * Is a process from ns.ps() running `script`? Compared with leading slashes
 * dropped, because the game stores script names WITHOUT one (bitburner-src
 * Paths/FilePath.ts: "must not contain a leading /") and ns.ps reports them that
 * way - "hacking/share.js" - while CONFIG.paths spells them "/hacking/share.js".
 * A plain === between the two is never true in the game: the batcher counted its
 * own share threads as zero (and so started more every tick and never stopped
 * any), and the driver's worker clean-up killed nothing. The functions that take
 * a script NAME (scriptRunning, scriptKill, exec, getScriptRam) resolve the
 * slash themselves; only names read back from ps need this.
 * @param {string} filename - a ProcessInfo.filename @param {string} script
 */
export function sameScript(filename, script) {
  const bare = p => String(p).replace(/^\/+/, "");
  return bare(filename) === bare(script);
}

/** @param {NS} ns */
export function allServers(ns, start = HOME) {
  const seen = new Set([start]);
  const queue = [start];

  for (let i = 0; i < queue.length; i++) {
    for (const s of ns.scan(queue[i])) {
      if (!seen.has(s)) {
        seen.add(s);
        queue.push(s);
      }
    }
  }
  return [...seen];
}

/** @param {NS} ns */
export function pathTo(ns, target) {
  const parent = { [HOME]: null };
  const queue = [HOME];

  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    if (cur === target) break;

    for (const next of ns.scan(cur)) {
      if (!(next in parent)) {
        parent[next] = cur;
        queue.push(next);
      }
    }
  }

  if (!(target in parent)) return [];

  const path = [];
  for (let cur = target; cur; cur = parent[cur]) path.unshift(cur);
  return path;
}

/** @param {NS} ns */
export function root(ns, server) {
  if (ns.hasRootAccess(server)) return true;

  // Positionally paired with CONFIG.programs.portOpeners - if you reorder one,
  // reorder the other.
  const openers = /** @type {(() => void)[]} */ ([
    () => ns.brutessh(server),
    () => ns.ftpcrack(server),
    () => ns.relaysmtp(server),
    () => ns.httpworm(server),
    () => ns.sqlinject(server),
  ]);

  let ports = 0;
  CONFIG.programs.portOpeners.forEach((file, i) => {
    if (ns.fileExists(file, HOME)) {
      openers[i]();
      ports++;
    }
  });

  // Ports are NUKE's whole requirement (bitburner-src NetscriptFunctions.ts nuke):
  // the hacking level gates hack/grow/weaken ON a server, not root, and not
  // running scripts on it. Waiting for the level too kept every big server's RAM
  // out of the fleet for hours in the nodes that cut hacking levels (BN13 x0.25).
  if (ports >= ns.getServerNumPortsRequired(server)) {
    ns.nuke(server);
  }

  return ns.hasRootAccess(server);
}
