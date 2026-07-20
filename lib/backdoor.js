// lib/backdoor.js
//
// Shared "endgame" helper for every BitNode daemon (bn2/bn3/bn4). It owns the two
// jobs that pulled a daemon's single most expensive Singularity calls onto scarce
// HOME RAM:
//   - installing server backdoors (singularity.connect + installBackdoor), and
//   - finishing the BitNode once w0r1d_d43m0n is backdoored
//     (singularity.destroyW0r1dD43m0n - 32GB by itself).
// Plus ns.getServer (2GB), which was only ever read here.
//
// Run off-home like lib/corp-steady.js and lib/gang.js: the daemon scp's this file
// to whatever server has RAM and exec's it there, so those ~38GB of calls never
// count against the daemon's home footprint. It loops forever, backdooring as
// targets become reachable and destroying the world daemon when ready.
//
// Args (forwarded by the launching daemon):
//   [0] nextBN     - the BitNode to enter after destroying w0r1d_d43m0n.
//   [1] cbScript   - the script to run after entering it (defaults to the cold-
//                    start driver, which auto-detects the new node and boots the
//                    right daemon).

import { pathTo, root } from "./net.js";
import { CONFIG } from "./config.js";

const B = CONFIG.backdoor;
const HOME = CONFIG.paths.home;

function hackingLevel(ns) {
  return ns.getPlayer().skills?.hacking ?? ns.getHackingLevel();
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
  }
}

/** @param {NS} ns @param {number} nextBN @param {string} cbScript */
async function maybeFinishBN(ns, nextBN, cbScript) {
  const target = B.finalHost;
  if (!ns.serverExists(target)) return;

  root(ns, target);

  const server = ns.getServer(target);
  if (!server.backdoorInstalled) return;
  if (hackingLevel(ns) < ns.getServerRequiredHackingLevel(target)) return;

  ns.tprint(`Destroying ${target}. Next BitNode: ${nextBN}`);
  ns.singularity.destroyW0r1dD43m0n(nextBN, cbScript);
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  const nextBN = Number(ns.args[0] ?? B.defaultNextBN);
  const cbScript = String(ns.args[1] ?? CONFIG.paths.driver);

  while (true) {
    try {
      await backdoorTargets(ns);
      await maybeFinishBN(ns, nextBN, cbScript);
    } catch (e) {
      ns.print(`backdoor tick error: ${String(e)}`);
    }
    await ns.sleep(B.tickMs);
  }
}
