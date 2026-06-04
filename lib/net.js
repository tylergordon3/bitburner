/** @param {NS} ns */
export function allServers(ns, start = "home") {
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
  const parent = { home: null };
  const queue = ["home"];

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

  const tools = /** @type {[string, () => void][]} */ ([
        ["BruteSSH.exe", () => ns.brutessh(server)],
        ["FTPCrack.exe", () => ns.ftpcrack(server)],
        ["relaySMTP.exe", () => ns.relaysmtp(server)],
        ["HTTPWorm.exe", () => ns.httpworm(server)],
        ["SQLInject.exe", () => ns.sqlinject(server)],
    ]);

  let ports = 0;
  for (const [file, fn] of tools) {
    if (ns.fileExists(file, "home")) {
      fn();
      ports++;
    }
  }

  if (
    ports >= ns.getServerNumPortsRequired(server) &&
    ns.getHackingLevel() >= ns.getServerRequiredHackingLevel(server)
  ) {
    ns.nuke(server);
  }

  return ns.hasRootAccess(server);
}