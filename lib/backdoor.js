// lib/backdoor.js
//
// Shared backdoor helper for every BitNode daemon. It owns the Singularity calls
// that install server backdoors (singularity.connect + installBackdoor) plus
// ns.getServer (2GB), which is only read here.
//
// Backdoors are how the hacking factions are unlocked - CSEC -> CyberSec,
// avmnite-02h -> NiteSec, I.I.I.I -> The Black Hand, run4theh111z -> BitRunners -
// so this helper running EARLY in a run matters more than almost anything else it
// competes with for RAM. That's why the BitNode finisher
// (singularity.destroyW0r1dD43m0n, 32GB on its own) now lives in lib/finish-bn.js:
// bundled here it made this script ~40GB, which on a fresh run (an aug install
// wipes purchased servers) meant no host had room once the botnet spun up, so the
// helper silently never started and no faction backdoor ever got installed. Alone,
// the backdoor loop is ~9GB and fits nearly anywhere.
//
// Run off-home like lib/corp-steady.js and lib/gang.js: the daemon scp's this file
// to whatever server has RAM and exec's it there. It loops forever, backdooring
// targets as they become reachable, and publishes globalThis.gordBackdoorState so
// the daemon knows when the world daemon is ready for lib/finish-bn.js.

import { pathTo } from "./net.js";
import { CONFIG } from "./config.js";
import { emitEvent } from "./events.js";

const B = CONFIG.backdoor;
const HOME = CONFIG.paths.home;

function hackingLevel(ns) {
  return ns.getPlayer().skills?.hacking ?? ns.getHackingLevel();
}

/** @param {NS} ns @param {string} server */
function backdoorInstalled(ns, server) {
  try { return ns.serverExists(server) && ns.getServer(server).backdoorInstalled === true; }
  catch { return false; }
}

/** @param {NS} ns */
async function backdoorTargets(ns) {
  for (const server of B.priority) {
    if (!ns.serverExists(server)) continue;
    const info = ns.getServer(server);
    if (info.backdoorInstalled) continue;
    if (!ns.hasRootAccess(server)) continue;
    if (hackingLevel(ns) < ns.getServerRequiredHackingLevel(server)) continue;

    const path = pathTo(ns, server);
    if (!path.length) continue;

    ns.singularity.connect(HOME);
    let connected = true;
    for (const hop of path.slice(1)) {
      if (!ns.singularity.connect(hop)) {
        connected = false;
        break;
      }
    }

    if (!connected) {
      ns.singularity.connect(HOME);
      continue;
    }

    ns.tprint(`Installing backdoor on ${server}...`);
    await ns.singularity.installBackdoor();
    ns.singularity.connect(HOME);

    // Report it: a backdoor is usually a faction unlock, so it belongs in the
    // journal next to the join it's about to cause.
    if (backdoorInstalled(ns, server)) {
      emitEvent(`[+] Backdoored ${server}`, "sys");
    }
  }
}

/**
 * Publish progress for the daemon + dashboard. `finalReady` is the handshake that
 * lets the daemon launch the 32GB lib/finish-bn.js exactly once, at the end of the
 * node, instead of carrying its RAM here for the whole run.
 * @param {NS} ns
 */
function publishState(ns) {
  const done = B.priority.filter(s => backdoorInstalled(ns, s));
  const finalReady = backdoorInstalled(ns, B.finalHost);

  globalThis.gordBackdoorState = {
    done,
    pending: B.priority.filter(s => ns.serverExists(s) && !done.includes(s)),
    finalHost: B.finalHost,
    finalReady,
    updatedAt: Date.now(),
  };
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  while (true) {
    try {
      await backdoorTargets(ns);
      publishState(ns);
    } catch (e) {
      ns.print(`backdoor tick error: ${String(e)}`);
    }
    await ns.sleep(B.tickMs);
  }
}
