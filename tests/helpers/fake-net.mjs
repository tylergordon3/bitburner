// tests/helpers/fake-net.mjs
// A fake game for the daemon's helper placement (lib/daemon-lib.js): a network
// of hosts, the scripts running on them, a stand-in for the batcher that fills
// every free GB the reservation globals let it, and an `ns` that COUNTS every
// call made through it - so a test can say how many ns calls a daemon tick costs
// as well as what it did.
//
// Only the calls the helper machinery makes are faked for real; `extra` supplies
// whatever else the code under test needs (a whole daemon tick needs a good deal
// more - see tests/helper-tick.test.mjs).

export const bare = p => String(p).replace(/^\/+/, "");

/**
 * @param {object} o
 * @param {Record<string, {max: number, rooted?: boolean}>} o.hosts - besides home
 * @param {number} [o.home] - home's RAM
 * @param {Record<string, number>} [o.ram] - script sizes by bare name (default 2GB)
 * @param {Record<string, any>} [o.extra] - more ns members (nested objects are namespaces)
 */
export function fakeNet({ hosts = {}, home = 128, ram = {}, extra = {} }) {
  const g = {
    max: /** @type {Record<string, number>} */ ({ home }),
    rooted: new Set(["home"]),
    procs: /** @type {{pid: number, host: string, script: string, ram: number, args: any[]}[]} */ ([]),
    // What the batcher holds: RAM in flight per host, landing when drain() says.
    legs: /** @type {Record<string, number>} */ ({}),
    started: /** @type {{script: string, host: string}[]} */ ([]),
    prints: /** @type {string[]} */ ([]),
    counts: /** @type {Record<string, number>} */ ({}),
    nextPid: 1,
    ram,
  };
  for (const [h, v] of Object.entries(hosts)) {
    g.max[h] = v.max;
    if (v.rooted !== false) g.rooted.add(h);
  }

  const sizeOf = script => g.ram[bare(script)] ?? 2;
  const used = host => g.procs.filter(p => p.host === host).reduce((s, p) => s + p.ram, 0) + (g.legs[host] ?? 0);
  const free = host => (g.max[host] ?? 0) - used(host);
  const need = host => { if (!(host in g.max)) throw new Error(`Invalid hostname: ${host}`); };

  /** Start a script the way exec does: only if it fits (with the game's 0.001GB of slack). */
  const start = (script, host, args = []) => {
    need(host);
    if (!g.rooted.has(host) || sizeOf(script) > free(host) + 0.001) return 0;
    const pid = g.nextPid++;
    g.procs.push({ pid, host, script: bare(script), ram: sizeOf(script), args });
    g.started.push({ script: bare(script), host });
    return pid;
  };

  // A shallow tree from home, the shape allServers walks: every host is listed
  // by its parent and lists its parent back.
  const names = () => Object.keys(g.max);
  const parentOf = h => {
    const all = names();
    const i = all.indexOf(h);
    return i <= 0 ? null : all[Math.floor((i - 1) / 4)];
  };
  const scan = host => {
    need(host);
    const out = names().filter(h => parentOf(h) === host);
    const up = parentOf(host);
    return up ? [up, ...out] : out;
  };

  const real = {
    args: [],
    disableLog() {},
    print: msg => { g.prints.push(String(msg)); },
    tprint: msg => { g.prints.push(String(msg)); },
    format: { ram: n => `${Math.round(n * 100) / 100}GB`, number: n => String(n) },
    scan,
    hasRootAccess: host => { need(host); return g.rooted.has(host); },
    serverExists: host => host in g.max,
    getServerMaxRam: host => { need(host); return g.max[host]; },
    getServerUsedRam: host => { need(host); return used(host); },
    getScriptRam: script => sizeOf(script),
    scriptRunning: (script, host) => { need(host); return g.procs.some(p => p.host === host && p.script === bare(script)); },
    scriptKill: (script, host) => {
      const before = g.procs.length;
      g.procs = g.procs.filter(p => !(p.host === host && p.script === bare(script)));
      return g.procs.length < before;
    },
    exec: (script, host, _threads, ...args) => start(script, host, args),
    scp: () => true,
    ls: () => [],
    fileExists: () => false,
    getServerNumPortsRequired: () => 5,
    gang: { inGang: () => false },
    cloud: { getServerLimit: () => 0 },
    ...extra,
  };

  // Count every call, namespaces included ("singularity.getFactionRep").
  const counted = (obj, prefix) => new Proxy(obj, {
    get(target, prop) {
      const value = target[prop];
      if (typeof prop !== "string") return value;
      if (typeof value === "function") {
        return (...a) => {
          g.counts[prefix + prop] = (g.counts[prefix + prop] ?? 0) + 1;
          return value(...a);
        };
      }
      if (value && typeof value === "object" && !Array.isArray(value) && prop !== "args") {
        return counted(value, `${prefix}${prop}.`);
      }
      return value;
    },
  });
  const ns = /** @type {any} */ (counted(real, ""));

  return {
    ns, g, used, free, start,
    /** Where `script` is running (first host), or null. */
    hostOf: script => g.procs.find(p => p.script === bare(script))?.host ?? null,
    /** Stop every copy of `script`. */
    stop: script => { g.procs = g.procs.filter(p => p.script !== bare(script)); },
    /** Total ns calls so far, and reset. */
    takeCounts() {
      const out = g.counts;
      g.counts = {};
      return { by: out, total: Object.values(out).reduce((s, n) => s + n, 0) };
    },
    /**
     * The batcher's turn: fill every rooted host with legs, as hacking/manager.js
     * would - not a host in gordReservedHosts, and not the GB gordReservedRam
     * names on a host (reservedRamFor), nor its own reserve on home.
     */
    fill(homeReserve = 8) {
      const hostsOff = globalThis.gordReservedHosts instanceof Set ? globalThis.gordReservedHosts : new Set();
      const keep = globalThis.gordReservedRam ?? {};
      for (const h of g.rooted) {
        if (hostsOff.has(h)) continue;
        const room = free(h) - (Number(keep[h]) > 0 ? keep[h] : 0) - (h === "home" ? homeReserve : 0);
        if (room > 0) g.legs[h] = (g.legs[h] ?? 0) + room;
      }
    },
    /** Every leg in flight lands. */
    drain() { g.legs = {}; },
  };
}
