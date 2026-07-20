import { CONFIG } from "./config.js";

const HOME = CONFIG.paths.home;

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

  if (
    ports >= ns.getServerNumPortsRequired(server) &&
    ns.getHackingLevel() >= ns.getServerRequiredHackingLevel(server)
  ) {
    ns.nuke(server);
  }

  return ns.hasRootAccess(server);
}
