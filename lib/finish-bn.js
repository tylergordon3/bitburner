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
// the daemon only when lib/backdoor.js reports the world daemon is READY (rooted,
// hacking level met - it is never backdoored by script, that would end the node
// by itself) AND the node's plan is to auto-continue (nextBN > 0). See ensureBackdoorHelpers in
// lib/daemon-lib.js.
//
// Args (forwarded by the launching daemon):
//   [0] nextBN     - the BitNode to enter after destroying w0r1d_d43m0n.
//   [1] cbScript   - the script to run after entering it (defaults to the cold-
//                    start driver, which auto-detects the new node and boots the
//                    right daemon).
//   [2] mode       - "blade": the node was won through Bladeburner (every black op,
//                    Operation Daedalus last, is done - bn6/daemon.js launches us
//                    only then). destroyW0r1dD43m0n accepts that in place of the
//                    backdoor + hacking level, so those checks are skipped.

import { root } from "./net.js";
import { CONFIG, forNode } from "./config.js";

const B = CONFIG.backdoor;

/**
 * The HUD's FINISH switch, read straight off globalThis (shared by every script in
 * the game, whatever host it runs on) rather than through lib/toggles.js: this
 * script usually runs OFF-HOME, and ns.read only ever sees the LOCAL host's files,
 * so the persisted /data/auto-finish.txt isn't there to read. Reconciling it here
 * would read an absent file as "on" and could write that back over a deliberate
 * "off" - so the file stays the home daemon's business and we consume the flag.
 *
 * On home the persisted file is consulted as a fallback, so a MANUAL `run
 * /lib/finish-bn.js <bn>` with no daemon up still works: there the file is the same
 * truth lib/toggles.js keeps, and its absence means "never configured", i.e. on.
 * Off-home ns.read just returns "", which stays unknown.
 *
 * Three states, and the difference matters:
 *   false     - the player turned FINISH off. Stop, permanently.
 *   true      - the daemon has read the toggle and it's on. Proceed.
 *   undefined - NOBODY has decided yet (globalThis is wiped by a page load, and
 *               Bitburner restores running scripts on load - so an orphaned
 *               finisher can come back BEFORE the daemon has seeded the flag).
 *               Wait. This is the case that used to beat a node the player had
 *               explicitly told us not to finish.
 * @param {NS} ns
 * @returns {"off" | "on" | "unknown"}
 */
function finishPermission(ns) {
  if (globalThis.gordAutoFinish === false) return "off";
  if (globalThis.gordAutoFinish === true) return "on";

  // Not seeded yet. ns.read is 0GB and sees only the LOCAL host, so this is a free
  // answer on home and no answer anywhere else.
  const stored = String(ns.read(CONFIG.paths.autoFinishFile)).trim();
  if (ns.getHostname() === CONFIG.paths.home) return stored === "off" ? "off" : "on";
  return stored === "off" ? "off" : "unknown";
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  const nextBN = Number(ns.args[0] ?? B.defaultNextBN);
  const cbScript = String(ns.args[1] ?? CONFIG.paths.driver);
  const bladeFinish = String(ns.args[2] ?? "") === "blade";

  if (nextBN <= 0) {
    ns.tprint("finish-bn.js: auto-finish is off (halt sentinel) - exiting.");
    return;
  }

  // The node-level lock, checked even when a real nextBN was passed: a node with
  // backdoor.skipFinalHost (BN10) is one the player ends BY HAND, so this script has
  // no business running there at all - not from the daemon, not from a stray manual
  // `run /lib/finish-bn.js 12`. getResetInfo is free (0GB) and works off-home, unlike
  // the toggle file below.
  const nodeCfg = forNode(ns.getResetInfo().currentNode).backdoor;
  if (nodeCfg.skipFinalHost) {
    ns.tprint(`finish-bn.js: this BitNode is set to finish MANUALLY (backdoor.skipFinalHost) - refusing to destroy ${nodeCfg.finalHost}. Exiting.`);
    return;
  }

  let waitedOnFlag = false;
  let announcedBlade = false;

  // Loop rather than one-shot: the daemon launches us once the world daemon is
  // backdoored, so the checks below normally pass immediately - but if anything is
  // momentarily off (root lost to a reset, hacking level short), we wait it out
  // here instead of exiting and being re-exec'd every daemon tick.
  //
  // That patience is exactly why the FINISH toggle has to be checked HERE too, not
  // only by the daemon that launched us: a finisher waiting on hacking level can
  // sit for hours, survive a `killall` on home (which doesn't touch other hosts)
  // and survive a page reload, and the daemon's stopFinisher only reaches us while
  // lib/backdoor.js is alive to publish gordBackdoorState. Left to itself, such an
  // orphan destroys the node the moment the level lands - toggle or no toggle.
  while (true) {
    const permission = finishPermission(ns);

    if (permission === "off") {
      ns.tprint("finish-bn.js: FINISH is off in the HUD - not destroying w0r1d_d43m0n. Exiting.");
      return;
    }

    if (permission === "unknown") {
      // Announce once, then keep waiting: the daemon seeds the flag on its first
      // tick, so this resolves in seconds during normal operation.
      if (!waitedOnFlag) {
        waitedOnFlag = true;
        ns.print("Waiting for the daemon to publish the FINISH toggle before destroying anything.");
      }
      await ns.sleep(B.tickMs);
      continue;
    }

    const target = B.finalHost;

    if (bladeFinish) {
      // No backdoor/level to check: the black ops ARE the requirement. The call
      // just logs and returns if the game disagrees, so a retry loop is safe.
      try {
        if (!announcedBlade) ns.tprint(`Bladeburner black ops complete - destroying ${target}. Next BitNode: ${nextBN}`);
        announcedBlade = true;
        ns.singularity.destroyW0r1dD43m0n(nextBN, cbScript);
      } catch (e) {
        ns.print(`finish-bn (blade) error: ${String(e)} - pick the next BitNode from the BitVerse screen.`);
      }
      await ns.sleep(B.tickMs);
      continue;
    }

    try {
      if (ns.serverExists(target)) {
        root(ns, target);
        const hacking = ns.getPlayer().skills?.hacking ?? ns.getHackingLevel();

        // Root + hacking level is the game's whole requirement. No backdoor: a
        // scripted backdoor on the world daemon opens the BitVerse by itself,
        // which is why lib/backdoor.js no longer installs one.
        if (ns.hasRootAccess(target) && hacking >= ns.getServerRequiredHackingLevel(target)) {
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
