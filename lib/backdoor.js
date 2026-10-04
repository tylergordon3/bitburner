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
// The hacking level is read with ns.getHackingLevel (0.05GB), not through
// ns-utils' hackingLevel(): that one reads it off ns.getPlayer(), which is free
// for a script that calls getPlayer anyway and 0.5GB for this one, which doesn't.

// Resolved per BitNode in main() via forNode(), NOT read straight off CONFIG: BN10
// sets backdoor.skipFinalHost (see targets() below). CONFIG is the fallback so the
// helpers still work if something imports them without calling main().
let B = CONFIG.backdoor;
const HOME = CONFIG.paths.home;

/** @param {NS} ns @param {string} server */
function backdoorInstalled(ns, server) {
  try { return ns.serverExists(server) && ns.getServer(server).backdoorInstalled === true; }
  catch { return false; }
}

/**
 * The servers this loop is allowed to backdoor: every entry in B.priority EXCEPT
 * the world daemon, on every node.
 *
 * Backdooring w0r1d_d43m0n IS the finish: Singularity's installBackdoor routes
 * the player to the BitVerse the moment it lands there (bitburner-src
 * NetscriptFunctions/Singularity.ts), a one-way door with no "stay" option. This
 * loop used to do that as soon as the hacking level allowed, which made the
 * HUD's FINISH: OFF and a `0` next-BitNode arg hold only the finisher, not the
 * finish. And nothing needs it: destroyW0r1dD43m0n checks hacking level and root
 * access, never the backdoor. So the final host is lib/finish-bn.js's alone,
 * behind its locks, and this loop only REPORTS when it is ready (finalReady).
 */
function targets() {
  return B.priority.filter(s => s !== B.finalHost);
}

/** @param {NS} ns */
async function backdoorTargets(ns) {
  for (const server of targets()) {
    if (!ns.serverExists(server)) continue;
    const info = ns.getServer(server);
    if (info.backdoorInstalled) continue;
    if (!ns.hasRootAccess(server)) continue;
    if (ns.getHackingLevel() < ns.getServerRequiredHackingLevel(server)) continue;

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
  // Ready = what destroyW0r1dD43m0n itself requires: root on the world daemon and
  // the hacking level to match. Never when the final host is off-limits
  // (skipFinalHost): finalReady is exactly the signal ensureBackdoorHelpers waits
  // on before launching the 32GB finisher.
  const finalReady = !B.skipFinalHost
    && ns.serverExists(B.finalHost)
    && ns.hasRootAccess(B.finalHost)
    && ns.getHackingLevel() >= ns.getServerRequiredHackingLevel(B.finalHost);

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

  // Per-BitNode config, with the node number passed as exec arg [0] by the daemon
  // (lib/daemon-lib.js ensureBackdoorHelpers): getResetInfo is 1GB, which this
  // ~9GB helper would otherwise pay for one integer. BN10 sets skipFinalHost,
  // which keeps finalReady false for the whole run - see publishState.
  const node = Number(ns.args[0]);
  if (!Number.isFinite(node)) {
    ns.tprint("backdoor.js: usage: run /lib/backdoor.js <bitnode> (the daemon passes this) - exiting.");
    return;
  }
  B = forNode(node).backdoor;
  if (B.skipFinalHost) {
    ns.tprint(`Backdoor helper: this BitNode finishes MANUALLY - backdoor ${B.finalHost} yourself when you want to end the node.`);
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
