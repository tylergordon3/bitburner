// tools/kill-helpers.js
//
// Kill the daemon's OFF-HOME helpers network-wide. `killall` in the Bitburner
// terminal only kills the CURRENT server, and the daemon deliberately runs its
// helpers wherever there's spare RAM (ensureHelper in lib/daemon-lib.js) - so the
// usual `killall; run /early/driver.js` restart leaves the old copies running, with
// the old code, on whatever purchased server they landed on.
//
// That's mostly harmless, but not for the helpers that can END A BITNODE:
// lib/backdoor.js (a backdoor on w0r1d_d43m0n IS the finish), lib/finish-bn.js, and
// lib/bladeburner.js (Operation Daedalus, BN6/7). After syncing a change to any of
// them, run this BEFORE restarting the daemon.
//
//   run /tools/kill-helpers.js        - the BitNode-ending helpers (default)
//   run /tools/kill-helpers.js all    - every helper the daemon places off-home
//
// `all` is derived from CONFIG.paths rather than listed by hand: the hand-kept
// list had fallen ten helpers behind (the HUD, stocks, contracts, econ, hacknet
// and the corp phases), so a synced change to any of those never deployed -
// ensureHelper saw the old copy "already running" and left it there.
//
// The botnet manager (hacking/manager.js) is on the `all` list for the same
// reason: it runs off-home, so `killall` on home leaves the OLD manager running
// and ensureHelper then sees it "already running" and never starts the new code.
//
// ensureHelper re-places whatever the node still needs on the next daemon tick,
// from the freshly-synced files.

import { allServers } from "../lib/net.js";
import { CONFIG } from "../lib/config.js";

const P = CONFIG.paths;

// CONFIG.paths entries that are NOT daemon-placed helpers: the daemons and
// cold-boot scripts (home only, restarted by hand) and the batcher's worker
// legs (the manager's; they land by themselves within a weaken-time).
const NOT_HELPERS = new Set(["daemon", "driver", "worker", "gangBoot", "bladeBoot", "hack", "grow", "weaken", "share", "legacyStartup"]);

/** Every script path in CONFIG.paths that ensureHelper may have placed off-home. */
export function helperScripts() {
  return Object.entries(P)
    .filter(([key, path]) => typeof path === "string" && path.endsWith(".js") && !NOT_HELPERS.has(key))
    .map(([, path]) => /** @type {string} */ (path));
}

/** @param {NS} ns */
export async function main(ns) {
  const all = String(ns.args[0] ?? "") === "all";
  const scripts = all ? helperScripts() : [P.backdoor, P.finishBn, P.bladeburner];

  let killed = 0;
  for (const host of allServers(ns)) {
    if (!ns.hasRootAccess(host)) continue;
    for (const script of scripts) {
      if (!ns.scriptRunning(script, host)) continue;
      ns.scriptKill(script, host);
      ns.tprint(`Killed ${script} on ${host}`);
      killed++;
    }
  }

  ns.tprint(killed
    ? `${killed} helper(s) stopped. The daemon re-launches what it needs on its next tick.`
    : "No matching helpers were running.");
}
