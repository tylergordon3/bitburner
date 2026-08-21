// tools/kill-helpers.js
//
// Kill the daemon's OFF-HOME helpers network-wide. `killall` in the Bitburner
// terminal only kills the CURRENT server, and the daemon deliberately runs its
// helpers wherever there's spare RAM (ensureHelper in lib/daemon-lib.js) - so the
// usual `killall; run /early/driver.js` restart leaves the old copies running, with
// the old code, on whatever purchased server they landed on.
//
// That's mostly harmless, but not for the two helpers that can END A BITNODE:
// lib/backdoor.js (a backdoor on w0r1d_d43m0n IS the finish) and lib/finish-bn.js.
// After syncing a change to either, run this BEFORE restarting the daemon.
//
//   run /tools/kill-helpers.js        - the two BitNode-ending helpers (default)
//   run /tools/kill-helpers.js all    - those plus sleeves/gang/corp/grafting
//
// ensureHelper re-places whatever the node still needs on the next daemon tick,
// from the freshly-synced files.

import { allServers } from "../lib/net.js";
import { CONFIG } from "../lib/config.js";

const P = CONFIG.paths;

/** @param {NS} ns */
export async function main(ns) {
  const all = String(ns.args[0] ?? "") === "all";
  const scripts = all
    ? [P.backdoor, P.finishBn, P.sleeves, P.gang, P.grafting, P.corpSteady, P.corpUpkeep]
    : [P.backdoor, P.finishBn];

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
