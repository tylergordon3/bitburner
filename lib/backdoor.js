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
import { CONFIG, forNode } from "./config.js";
import { emitEvent } from "./events.js";

// Resolved per BitNode in main() via forNode(), NOT read straight off CONFIG: BN10
// sets backdoor.skipFinalHost (see targets() below). CONFIG is the fallback so the
// helpers still work if something imports them without calling main().
let B = CONFIG.backdoor;
const HOME = CONFIG.paths.home;

function hackingLevel(ns) {
  return ns.getPlayer().skills?.hacking ?? ns.getHackingLevel();
}

/** @param {NS} ns @param {string} server */
function backdoorInstalled(ns, server) {
  try { return ns.serverExists(server) && ns.getServer(server).backdoorInstalled === true; }
  catch { return false; }
}

/**
 * The servers this loop is allowed to backdoor. Normally every entry in B.priority -
 * but a node whose config sets backdoor.skipFinalHost drops the world daemon from the
 * list entirely.
 *
 * That guard exists because backdooring w0r1d_d43m0n IS the finish. Singularity
 * installBackdoor is documented as "run the backdoor command in the terminal", and on
 * the world daemon that command sends the player to the BitVerse - the same one-way
 * door lib/finish-bn.js opens with destroyW0r1dD43m0n. So in a node we mean to STAY in
 * (BN10: the sleeve shop only exists there and buying it out takes a full run), holding
 * the finisher back is only half the job - the bot must not touch the final host at
 * all, and the player backdoors it by hand when the run is done.
 */
function targets() {
  return B.skipFinalHost ? B.priority.filter(s => s !== B.finalHost) : B.priority;
}

/** @param {NS} ns */
async function backdoorTargets(ns) {
  for (const server of targets()) {
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
  const scope = targets();
  const done = scope.filter(s => backdoorInstalled(ns, s));
  // Never ready when the final host is off-limits: finalReady is exactly the signal
  // ensureBackdoorHelpers waits on before launching the 32GB finisher.
  const finalReady = !B.skipFinalHost && backdoorInstalled(ns, B.finalHost);

  globalThis.gordBackdoorState = {
    done,
    pending: scope.filter(s => ns.serverExists(s) && !done.includes(s)),
    finalHost: B.finalHost,
    finalReady,
    finalSkipped: B.skipFinalHost === true,
    updatedAt: Date.now(),
  };
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  // Per-BitNode config (getResetInfo is free, 0GB). BN10 sets skipFinalHost, which
  // takes w0r1d_d43m0n off the list for the whole run - see targets().
  B = forNode(ns.getResetInfo().currentNode).backdoor;
  if (B.skipFinalHost) {
    ns.tprint(`Backdoor helper: ${B.finalHost} is OFF LIMITS in this BitNode - backdoor it yourself when you want to end the node.`);
  }

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
