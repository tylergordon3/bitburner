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
// 4x/16x, which would make even this lean driver much heavier.)

import { allServers, root } from "../lib/net.js";

const MANAGER = "/hacking/manager.js";
const WORKER = "/early/worker.js";
const GANG_BOOT = "/early/gang-boot.js";
const DASHBOARD = "/ui/dashboard.js";
const STOCKS = "/lib/stocks.js";
const HACK = "/hacking/hack.js";
const GROW = "/hacking/grow.js";
const WEAKEN = "/hacking/weaken.js";

// Free RAM the daemon needs on home on top of its own script size: enough for
// the botnet workers it spawns plus a little slack. The dashboard/stocks/manager
// script sizes are added on top of this dynamically (see requiredHomeRam).
const WORKER_HEADROOM = 8;

const HOME = "home";

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
  return scriptRamSafe(ns, daemon) + WORKER_HEADROOM;
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
function ensureMoneyEngine(ns) {
  if (ns.fileExists(MANAGER, HOME)) {
    if (!ns.scriptRunning(MANAGER, HOME)) ns.run(MANAGER, 1);
    return;
  }

  // Fallback: root everything and fill each server with worker.js threads.
  const workerRam = scriptRamSafe(ns, WORKER) || 2.5;
  for (const server of allServers(ns)) {
    try { root(ns, server); } catch {}
    if (!ns.hasRootAccess(server)) continue;
    if (ns.scriptRunning(WORKER, server)) continue;

    const reserve = server === HOME ? WORKER_HEADROOM : 0;
    const free = ns.getServerMaxRam(server) - ns.getServerUsedRam(server) - reserve;
    const threads = Math.floor(free / workerRam);
    if (threads <= 0) continue;

    if (server !== HOME) ns.scp(WORKER, server, HOME);
    ns.exec(WORKER, server, threads);
  }
}

/**
 * Tear down the money engine so the daemon boots into a clean home. The daemon
 * restarts the botnet itself once it's up.
 * @param {NS} ns
 */
function stopMoneyEngine(ns) {
  ns.scriptKill(MANAGER, HOME);
  ns.scriptKill(WORKER, HOME);
  ns.scriptKill(GANG_BOOT, HOME);
  ns.scriptKill("/startup.js", HOME);

  for (const server of allServers(ns)) {
    if (!ns.hasRootAccess(server)) continue;
    for (const p of ns.ps(server)) {
      if ([HACK, GROW, WEAKEN, WORKER].includes(p.filename)) ns.kill(p.pid);
    }
  }
}

/** @param {NS} ns - true if we're in a gang; false (not just missing API) otherwise. */
function inGangSafe(ns) {
  try {
    return ns.gang.inGang();
  } catch {
    return false;
  }
}

/**
 * Start the gang as early as home RAM allows. gang-boot.js is a ~20GB one-shot,
 * too big to share a fresh 32GB home with the botnet, so we only launch it once
 * home has grown enough to hold it alongside the manager, and we briefly clear
 * the botnet to make room (ensureMoneyEngine restarts it next tick, adapting to
 * the RAM gang-boot now holds). BN2-only: gang creation elsewhere needs karma
 * <= -54000, which this bootstrap doesn't pursue.
 * @param {NS} ns @param {number} node
 */
function maybeStartGang(ns, node) {
  if (node !== 2) return;
  if (!ns.fileExists(GANG_BOOT, HOME)) return;
  if (ns.scriptRunning(GANG_BOOT, HOME)) return;
  if (inGangSafe(ns)) return;

  const bootRam = scriptRamSafe(ns, GANG_BOOT);
  const gate = bootRam + scriptRamSafe(ns, MANAGER) + WORKER_HEADROOM;
  if (ns.getServerMaxRam(HOME) < gate) return;

  // Botnet workers hog home, so clear them to make room; the botnet restarts
  // next tick and adapts to the RAM gang-boot now holds. Only exec once the
  // room actually exists, so we never kill the botnet for a launch that fails.
  if (homeFreeRam(ns) < bootRam) stopMoneyEngine(ns);
  if (homeFreeRam(ns) < bootRam) return;

  if (ns.exec(GANG_BOOT, HOME, 1) !== 0) {
    ns.tprint(`Launched ${GANG_BOOT} (${ns.format.ram(bootRam)}) - starting the gang early.`);
  }
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const node = ns.getResetInfo().currentNode;
  let daemon = `/bn${node}/daemon.js`;

  if (!ns.fileExists(daemon, HOME)) {
    ns.tprint(`WARN: ${daemon} not found for BitNode ${node}.`);
    // Fall back to the BN4 daemon if it exists, else just keep earning so the
    // player can drop in a daemon and let this pick it up.
    daemon = ns.fileExists("/bn4/daemon.js", HOME) ? "/bn4/daemon.js" : daemon;
    ns.tprint(daemon.startsWith(`/bn${node}`) ? "No daemon to hand off to - earning until one exists." : `Falling back to ${daemon}.`);
  }

  ns.tprint(`Bootstrap started (BitNode ${node}) -> target daemon ${daemon}`);

  while (true) {
    ensureMoneyEngine(ns);

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

    await ns.sleep(15_000);
  }
}
