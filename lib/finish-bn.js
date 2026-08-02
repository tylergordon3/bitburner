// lib/finish-bn.js
//
// The BitNode finisher: destroy w0r1d_d43m0n and enter the next node. Split out of
// lib/backdoor.js because of ONE call - ns.singularity.destroyW0r1dD43m0n costs
// 32GB, roughly four fifths of what the combined script used to cost. Bundling it
// with the backdoor loop meant the whole helper needed ~40GB free SOMEWHERE before
// any backdoor could be installed, and on a fresh run (purchased servers are wiped
// by an install) the botnet claims the network's RAM long before that. The result
// was a helper that quietly never started, so CSEC/avmnite-02h/I.I.I.I/run4theh111z
// never got backdoored and their factions never invited us.
//
// So: lib/backdoor.js is now a ~9GB loop that only backdoors, and this file - the
// expensive part, needed exactly once at the very end of a node - is launched by
// the daemon only when lib/backdoor.js reports the world daemon is backdoored AND
// the node's plan is to auto-continue (nextBN > 0). See ensureBackdoorHelpers in
// lib/daemon-lib.js.
//
// Args (forwarded by the launching daemon):
//   [0] nextBN     - the BitNode to enter after destroying w0r1d_d43m0n.
//   [1] cbScript   - the script to run after entering it (defaults to the cold-
//                    start driver, which auto-detects the new node and boots the
//                    right daemon).

import { root } from "./net.js";
import { CONFIG } from "./config.js";

const B = CONFIG.backdoor;

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  const nextBN = Number(ns.args[0] ?? B.defaultNextBN);
  const cbScript = String(ns.args[1] ?? CONFIG.paths.driver);

  if (nextBN <= 0) {
    ns.tprint("finish-bn.js: auto-finish is off (halt sentinel) - exiting.");
    return;
  }

  const target = B.finalHost;

  // Loop rather than one-shot: the daemon launches us once the world daemon is
  // backdoored, so the checks below normally pass immediately - but if anything is
  // momentarily off (root lost to a reset, hacking level short), we wait it out
  // here instead of exiting and being re-exec'd every daemon tick.
  while (true) {
    try {
      if (ns.serverExists(target)) {
        root(ns, target);
        const server = ns.getServer(target);
        const hacking = ns.getPlayer().skills?.hacking ?? ns.getHackingLevel();

        if (server.backdoorInstalled && hacking >= ns.getServerRequiredHackingLevel(target)) {
          ns.tprint(`Destroying ${target}. Next BitNode: ${nextBN}`);
          ns.singularity.destroyW0r1dD43m0n(nextBN, cbScript);
          return;
        }
      }
    } catch (e) {
      ns.print(`finish-bn tick error: ${String(e)}`);
    }
    await ns.sleep(B.tickMs);
  }
}
