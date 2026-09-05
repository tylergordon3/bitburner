// early/driver.js
//
// Cold-start bootstrap for a fresh BitNode. One job: make money and grow home
// RAM until the current node's daemon (plus the helper scripts it launches)
// actually fits on home, then hand off and exit.
//
// Deliberately lean. A fresh BitNode starts with only 32GB of home RAM, and the
// node's daemon is large, so this file touches Singularity as little as possible
// - just upgradeHomeRam - and lets the (bigger) daemon do the rest once there's
// room for it. It does NOT import lib/aug-targets.js on purpose: importing it
// would pull that module's many Singularity calls into this script's RAM cost
// for no benefit here. (At SF4.3 Singularity RAM is 1x; at lower SF4 levels it's
// 4x/16x, which would make even this lean driver much heavier.) lib/config.js is
// safe to import by contrast - it has no Netscript calls at all.

import { allServers, root } from "../lib/net.js";
import { CONFIG, forNode } from "../lib/config.js";
import { inGangSafe } from "../lib/ns-utils.js";

const P = CONFIG.paths;
const D = CONFIG.driver;
const HOME = P.home;

/** @param {NS} ns @param {string} file */
function scriptRamSafe(ns, file) {
  try {
    return ns.getScriptRam(file, HOME);
  } catch {
    return 0;
  }
}

/**
 * Home RAM the daemon needs before we hand off. The daemon now runs its helpers
 * (manager/dashboard/stocks) OFF home - on any rooted server - so we no longer
 * add their sizes here. We only need home to hold the daemon itself plus a bit
 * of slack (the gang, when applicable, is also placed off-home or in reserved
 * space). Handing off at daemon+slack instead of daemon+all-helpers means we
 * hand off a full RAM tier sooner.
 * @param {NS} ns @param {string} daemon
 */
function requiredHomeRam(ns, daemon) {
  return scriptRamSafe(ns, daemon) + D.workerHeadroom;
}

/** @param {NS} ns */
function homeFreeRam(ns) {
  return ns.getServerMaxRam(HOME) - ns.getServerUsedRam(HOME);
}

/**
 * Keep a money engine running. Prefer the real HGW botnet (manager.js); if it
 * isn't present, fall back to spraying the single-target worker across every
 * rooted server we can reach. Neither touches Singularity, so both are cheap.
 * @param {NS} ns
 */
let _managerWarnedAt = 0;

function ensureMoneyEngine(ns) {
  if (ns.fileExists(P.manager, HOME)) {
    if (!ns.scriptRunning(P.manager, HOME) && ns.run(P.manager, 1) === 0) {
      // Say so: a failed launch here used to be silent, and a home with no
      // botnet looks exactly like a home with an idle one.
      if (Date.now() - _managerWarnedAt > 60_000) {
        _managerWarnedAt = Date.now();
        ns.tprint(`WARN: could not start ${P.manager} on home - needs ${ns.format.ram(scriptRamSafe(ns, P.manager))}, ${ns.format.ram(homeFreeRam(ns))} free.`);
      }
    }
    return;
  }

  // Fallback: root everything and fill each server with worker.js threads.
  const workerRam = scriptRamSafe(ns, P.worker) || D.fallbackWorkerRam;
  for (const server of allServers(ns)) {
    try { root(ns, server); } catch {}
    if (!ns.hasRootAccess(server)) continue;
    if (ns.scriptRunning(P.worker, server)) continue;

    const reserve = server === HOME ? D.workerHeadroom : 0;
    const free = ns.getServerMaxRam(server) - ns.getServerUsedRam(server) - reserve;
    const threads = Math.floor(free / workerRam);
    if (threads <= 0) continue;

    // Copy every source file, not just worker.js: Bitburner resolves a script's
    // imports from the host it runs on, and worker.js imports lib/config.js.
    // Files cost no RAM, so shipping them all is simplest and safest.
    if (server !== HOME) ns.scp(ns.ls(HOME, ".js"), server, HOME);
    ns.exec(P.worker, server, threads);
  }
}

/**
 * Where hacknet SERVERS are the economy (BN9: hacking earns ~0.1% of normal),
 * the cold boot would crawl on the botnet alone, so the fleet manager (~7GB)
 * runs from the first tick. Placed like the daemon's helpers: the roomiest
 * rooted off-home host first, so home stays the botnet's, and home only as the
 * fallback. Never on a hacknet server itself - a script there cuts the hash
 * rate it exists to grow. Only nodes whose config turns it on (BITNODE[9]).
 * @param {NS} ns @param {number} node
 */
function ensureHacknetEngine(ns, node) {
  if (!forNode(node).hacknet.enabled) return;
  if (!ns.fileExists(P.hacknet, HOME)) return;

  const rooted = allServers(ns).filter(s => ns.hasRootAccess(s));
  if (rooted.some(s => ns.scriptRunning(P.hacknet, s))) return;

  const ram = scriptRamSafe(ns, P.hacknet);
  const hosts = rooted
    .filter(s => s !== HOME && !s.startsWith(CONFIG.hacking.excludeTargetPrefix))
    .map(s => ({ s, free: ns.getServerMaxRam(s) - ns.getServerUsedRam(s) }))
    .filter(h => h.free >= ram)
    .sort((a, b) => b.free - a.free);
  for (const { s } of hosts) {
    ns.scp(ns.ls(HOME, ".js"), s, HOME);
    if (ns.exec(P.hacknet, s, 1, node, 1) !== 0) {
      ns.tprint(`Launched ${P.hacknet} on ${s} - growing the hacknet fleet from the start.`);
      return;
    }
  }
  if (homeFreeRam(ns) >= ram && ns.run(P.hacknet, 1, node, 1) !== 0) {
    ns.tprint(`Launched ${P.hacknet} on home - growing the hacknet fleet from the start.`);
  }
}

/**
 * Tear down the money engine so the daemon boots into a clean home. The daemon
 * restarts the botnet itself once it's up (and the hacknet manager, off-home).
 * @param {NS} ns
 */
function stopMoneyEngine(ns) {
  ns.scriptKill(P.manager, HOME);
  ns.scriptKill(P.hacknet, HOME);
  ns.scriptKill(P.worker, HOME);
  ns.scriptKill(P.gangBoot, HOME);
  ns.scriptKill(P.legacyStartup, HOME);

  for (const server of allServers(ns)) {
    if (!ns.hasRootAccess(server)) continue;
    for (const p of ns.ps(server)) {
      if ([P.hack, P.grow, P.weaken, P.worker].includes(p.filename)) ns.kill(p.pid);
    }
  }
}

/**
 * Start the gang as early as home RAM allows. gang-boot.js is a ~20GB one-shot,
 * too big to share a fresh 32GB home with the botnet, so we only launch it once
 * home has grown enough to hold it alongside the manager, and we briefly clear
 * the botnet to make room (ensureMoneyEngine restarts it next tick, adapting to
 * the RAM gang-boot now holds).
 *
 * Only nodes whose config names a bootstrap gang faction (see BITNODE in
 * lib/config.js - BN2 only today) can do this: everywhere else founding a gang
 * needs karma <= -54,000, which this bootstrap doesn't pursue.
 * @param {NS} ns @param {number} node
 */
function maybeStartGang(ns, node) {
  if (!forNode(node).gang.faction) return;
  if (!ns.fileExists(P.gangBoot, HOME)) return;
  if (ns.scriptRunning(P.gangBoot, HOME)) return;
  if (inGangSafe(ns)) return;

  const bootRam = scriptRamSafe(ns, P.gangBoot);
  const gate = bootRam + scriptRamSafe(ns, P.manager) + D.workerHeadroom;
  if (ns.getServerMaxRam(HOME) < gate) return;

  // Botnet workers hog home, so clear them to make room; the botnet restarts
  // next tick and adapts to the RAM gang-boot now holds. Only exec once the
  // room actually exists, so we never kill the botnet for a launch that fails.
  if (homeFreeRam(ns) < bootRam) stopMoneyEngine(ns);
  if (homeFreeRam(ns) < bootRam) return;

  if (ns.exec(P.gangBoot, HOME, 1) !== 0) {
    ns.tprint(`Launched ${P.gangBoot} (${ns.format.ram(bootRam)}) - starting the gang early.`);
  }
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const node = ns.getResetInfo().currentNode;
  // Registered nodes get their daemon path from config; anything else still
  // resolves by convention so a new bnX/ folder works without a config edit.
  let daemon = forNode(node).paths.daemon ?? `/bn${node}/daemon.js`;

  if (!ns.fileExists(daemon, HOME)) {
    ns.tprint(`WARN: ${daemon} not found for BitNode ${node}.`);
    // Fall back to the BN4 daemon if it exists, else just keep earning so the
    // player can drop in a daemon and let this pick it up.
    daemon = ns.fileExists(D.fallbackDaemon, HOME) ? D.fallbackDaemon : daemon;
    ns.tprint(daemon.startsWith(`/bn${node}`) ? "No daemon to hand off to - earning until one exists." : `Falling back to ${daemon}.`);
  }

  ns.tprint(`Bootstrap started (BitNode ${node}) -> target daemon ${daemon}`);

  while (true) {
    ensureMoneyEngine(ns);
    ensureHacknetEngine(ns, node);

    // Grow home RAM as aggressively as money allows. At SF4.3 Singularity is 1x
    // RAM; upgradeHomeRam and the daemon are the only Singularity the driver
    // itself touches (the gang bootstrap lives in its own process).
    try {
      while (ns.singularity.upgradeHomeRam()) {}
    } catch {}

    // Kick off the gang as soon as there's room; its income accelerates the
    // remaining home-RAM grind toward the daemon.
    maybeStartGang(ns, node);

    const needed = requiredHomeRam(ns, daemon);
    const haveDaemon = ns.fileExists(daemon, HOME);

    if (haveDaemon && ns.getServerMaxRam(HOME) >= needed) {
      stopMoneyEngine(ns);
      const pid = ns.run(daemon, 1);
      if (pid !== 0) {
        ns.tprint(`Home RAM ${ns.format.ram(ns.getServerMaxRam(HOME))} >= ${ns.format.ram(needed)} needed. Started ${daemon} (pid ${pid}).`);
        return;
      }
      ns.tprint(`ERROR: failed to launch ${daemon} despite sufficient RAM - retrying.`);
    }

    ns.print(
      `Home ${ns.format.ram(ns.getServerMaxRam(HOME))} / need ${ns.format.ram(needed)} | ` +
      `free ${ns.format.ram(homeFreeRam(ns))} | $${ns.format.number(ns.getServerMoneyAvailable(HOME))}`
    );

    await ns.sleep(D.tickMs);
  }
}
