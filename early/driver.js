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

import { allServers, root, sameScript } from "../lib/net.js";
import { CONFIG, forReset } from "../lib/config.js";
import { inGangSafe } from "../lib/ns-utils.js";
import { giftStatus } from "../lib/stanek-logic.js";

const P = CONFIG.paths;
const D = CONFIG.driver;
const HOME = P.home;
// This run's config - the node's, with its challenge overlay if the run is one.
// main() sets it before anything reads it (a module variable outlives the
// process, so it is never left to the last run's value).
let CFG = CONFIG;

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
 * @param {NS} ns @param {number} node @param {Record<string, number>} holds
 */
function ensureHacknetEngine(ns, node, holds) {
  if (!CFG.hacknet.enabled) return;
  launchOffHomeFirst(ns, P.hacknet, [node, 1], "growing the hacknet fleet from the start", holds);
}

/**
 * Bladeburner nodes (CONFIG.bladeburner.enabled - BN6): gym to the division's
 * join gate (100 in every combat stat) and join, via the ~13GB one-shot
 * early/blade-boot.js. A new BitNode resets the division, so this is part of
 * every cold boot there; an aug install doesn't, so it's a no-op after one.
 * @param {NS} ns @param {number} node @param {Record<string, number>} holds
 */
function ensureBladeBoot(ns, node, holds) {
  if (!CFG.bladeburner.enabled) return;
  if (ns.bladeburner.inBladeburner()) return;
  launchOffHomeFirst(ns, P.bladeBoot, [node], "training toward the Bladeburner division", holds);
}

/**
 * Stanek's Gift (BN13 / SF13), where the node wants it: accept it before
 * anything else can cost us the chance. The gift is refused once any
 * augmentation but NeuroFlux is owned - and with Source-File 7.3, JOINING THE
 * BLADEBURNER DIVISION grants one - so the Bladeburner boot below waits for
 * this. early/stanek-boot.js is a 4.6GB one-shot that answers within a tick.
 * @param {NS} ns @param {number} node @param {Record<string, number>} holds
 * @returns {boolean} true once the question is settled (or was never asked)
 */
function giftSettled(ns, node, holds) {
  const status = giftStatus(ns.getResetInfo(), CFG.stanek, globalThis.gordStanekState);
  if (status !== "pending") return true;
  launchOffHomeFirst(ns, P.stanekBoot, [node], "accepting Stanek's Gift", holds);
  return false;
}

/**
 * Launch a cold-boot engine unless it's already running anywhere: the roomiest
 * rooted off-home host first, so home stays the botnet's, home as the fallback.
 * Never on a hacknet server - a script there cuts its hash rate.
 *
 * When nothing has room, the RAM is asked for instead: an entry in `holds`
 * (published by main as globalThis.gordReservedRam, which hacking/manager.js
 * keeps free of new legs - reservedRamFor) for home AND for one off-home host.
 * Home alone was not enough: a fresh 32GB home holds this driver and the botnet
 * manager and has ~7GB to spare, so a 13GB boot script or the 11GB hacknet
 * manager could only ever land off-home - on hosts the botnet had filled by the
 * second tick, with nothing telling it to leave a gap.
 * @param {NS} ns @param {string} script @param {any[]} args @param {string} why
 * @param {Record<string, number>} [holds] - host -> GB to keep free; added to
 * @returns {boolean} whether it's running now
 */
function launchOffHomeFirst(ns, script, args, why, holds) {
  if (!ns.fileExists(script, HOME)) return false;

  const rooted = allServers(ns).filter(s => ns.hasRootAccess(s));
  if (rooted.some(s => ns.scriptRunning(script, s))) return true;

  const ram = scriptRamSafe(ns, script);
  const offHome = rooted.filter(s => s !== HOME && !s.startsWith(CONFIG.hacking.excludeTargetPrefix));
  const hosts = offHome
    .map(s => ({ s, free: ns.getServerMaxRam(s) - ns.getServerUsedRam(s) }))
    .filter(h => h.free >= ram)
    .sort((a, b) => b.free - a.free);
  for (const { s } of hosts) {
    ns.scp(ns.ls(HOME, ".js"), s, HOME);
    if (ns.exec(script, s, 1, ...args) !== 0) {
      ns.tprint(`Launched ${script} on ${s} - ${why}.`);
      return true;
    }
  }
  if (homeFreeRam(ns) >= ram && ns.run(script, 1, ...args) !== 0) {
    ns.tprint(`Launched ${script} on home - ${why}.`);
    return true;
  }

  if (holds && ram > 0) {
    holds[HOME] = (holds[HOME] ?? 0) + ram;
    const host = holdHost(offHome.map(s => ({ host: s, max: ns.getServerMaxRam(s) })), ram, holds);
    if (host) holds[host] = (holds[host] ?? 0) + ram;
  }
  return false;
}

/**
 * The off-home host to keep `ram` GB free on for a script that found no room:
 * the SMALLEST that can still hold it next to what is already held there (the
 * botnet loses the least), by name on a tie - so the answer is the same every
 * tick and the host actually drains. Null when no host is big enough. Pure.
 * @param {{host: string, max: number}[]} hosts @param {number} ram
 * @param {Record<string, number>} holds
 * @returns {string | null}
 */
export function holdHost(hosts, ram, holds) {
  const fits = hosts
    .filter(h => h.max - (holds[h.host] ?? 0) >= ram)
    .sort((a, b) => a.max - b.max || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
  return fits.length ? fits[0].host : null;
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

  // blade-boot too: the daemon trains toward the division itself, and two
  // scripts re-issuing different gym workouts would just fight over the slot.
  // (stanekCharge: the Gift's charge workers hold whole hosts, home included,
  // and the daemon about to start needs home. lib/stanek.js restarts them.)
  // By string key on purpose: written P.hack / P.grow / P.weaken, the three
  // property names are billed as ns.hack, ns.grow and ns.weaken (0.4GB of a
  // script that has to share a 32GB home) for functions it never calls.
  const stray = ["hack", "grow", "weaken", "worker", "bladeBoot", "stanekCharge"].map(key => P[key]);
  for (const server of allServers(ns)) {
    if (!ns.hasRootAccess(server)) continue;
    for (const p of ns.ps(server)) {
      if (stray.some(s => sameScript(p.filename, s))) ns.kill(p.pid);
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
  if (!CFG.gang.faction) return;
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

  const reset = ns.getResetInfo();
  const node = reset.currentNode;
  // forReset, not forNode(node): a node entered as a CHALLENGE run (see
  // CHALLENGE in lib/config.js) is played with an overlay that this script is
  // the first to act on - a different daemon to hand off to, and none of the
  // boot scripts for the mechanic the run forbids. Booting the node's ordinary
  // config there forfeits the challenge in the first second (accepting Stanek's
  // Gift in BN13, buying hacknet servers in BN9).
  CFG = forReset(reset);
  // Registered nodes get their daemon path from config; anything else still
  // resolves by convention so a new bnX/ folder works without a config edit.
  let daemon = CFG.paths.daemon ?? `/bn${node}/daemon.js`;

  if (!ns.fileExists(daemon, HOME)) {
    ns.tprint(`WARN: ${daemon} not found for BitNode ${node}.`);
    // Fall back to the BN4 daemon if it exists, else just keep earning so the
    // player can drop in a daemon and let this pick it up.
    daemon = ns.fileExists(D.fallbackDaemon, HOME) ? D.fallbackDaemon : daemon;
    ns.tprint(daemon.startsWith(`/bn${node}`) ? "No daemon to hand off to - earning until one exists." : `Falling back to ${daemon}.`);
  }

  ns.tprint(`Bootstrap started (BitNode ${node}) -> target daemon ${daemon}`);

  // BITNODE[n].driver, resolved for this node (D above is the shared default).
  // homeRamOnlyToFit: stop buying home RAM at the size the daemon needs - BN8,
  // where the starting $250m is the stock trader's capital and "as much home RAM
  // as money allows" spends most of it in the first tick.
  const onlyToFit = /** @type {any} */ (CFG.driver).homeRamOnlyToFit === true;

  while (true) {
    // RAM the cold-boot engines below are still waiting for, by host; rebuilt
    // every tick and published for hacking/manager.js to keep free. Rebuilding
    // it here also drops whatever the LAST node's daemon left in the map
    // (globalThis outlives a BitNode), which would otherwise idle those hosts
    // for the whole cold boot.
    const holds = /** @type {Record<string, number>} */ ({});
    ensureMoneyEngine(ns);
    ensureHacknetEngine(ns, node, holds);
    // The gift first: joining the division can forfeit it (see giftSettled).
    if (giftSettled(ns, node, holds)) ensureBladeBoot(ns, node, holds);
    globalThis.gordReservedRam = holds;
    globalThis.gordReservedRamAt = Date.now();   // see hacking.reservedRamMaxAgeMs

    // Grow home RAM as aggressively as money allows (or, with homeRamOnlyToFit,
    // only until the daemon fits). At SF4.3 Singularity is 1x RAM; upgradeHomeRam
    // and the daemon are the only Singularity the driver itself touches (the gang
    // bootstrap lives in its own process).
    try {
      while (
        (!onlyToFit || ns.getServerMaxRam(HOME) < requiredHomeRam(ns, daemon)) &&
        ns.singularity.upgradeHomeRam()
      ) {}
    } catch {}

    // Kick off the gang as soon as there's room; its income accelerates the
    // remaining home-RAM grind toward the daemon.
    maybeStartGang(ns, node);

    const needed = requiredHomeRam(ns, daemon);
    const haveDaemon = ns.fileExists(daemon, HOME);

    if (haveDaemon && ns.getServerMaxRam(HOME) >= needed) {
      stopMoneyEngine(ns);
      // The boot holds end with the boot: whatever the daemon's helpers need
      // kept free, the daemon asks for itself at the end of each of its ticks
      // (lib/daemon-core.js is the map's only writer from here on). A failed
      // launch below just rebuilds them on the next pass.
      globalThis.gordReservedRam = {};
      globalThis.gordReservedRamAt = Date.now();
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
