// tools/kill-helpers.js
//
// Kill the daemon's OFF-HOME helpers network-wide. `killall` in the Bitburner
// terminal only kills the CURRENT server, and the daemon deliberately runs its
// helpers wherever there's spare RAM (ensureHelper in lib/daemon-lib.js) - so the
// `killall` alone leaves the old copies running, with the old code, on whatever
// server they landed on. early/driver.js now stops them all when it starts, so
// the usual `killall; run /early/driver.js` IS a full restart; this tool is for
// stopping helpers WITHOUT restarting (and for the BitNode-ending ones below).
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
import { CONFIG, helperScripts } from "../lib/config.js";

const P = CONFIG.paths;

// The list itself lives in lib/config.js (helperScripts), shared with
// early/driver.js, which stops the same scripts whenever it starts.
export { helperScripts };

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
