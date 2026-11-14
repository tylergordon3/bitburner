// early/handoff.js
//
// The last step of the cold boot when the daemon does not fit on home NEXT TO
// early/driver.js. The driver hands off once home holds the daemon plus
// CONFIG.driver.workerHeadroom (8GB) - but the driver itself is ~13GB and is
// still running when it calls ns.run(daemon). On a home that was grown only
// until the daemon fits (BN8, driver.homeRamOnlyToFit) a daemon within ~5GB of
// the tier therefore never started: "failed to launch ... despite sufficient
// RAM", every tick, forever.
//
// So the driver starts this instead and exits; this waits for the driver's RAM
// to come back and starts the daemon in it. 2.6GB (ns.run and nothing else) -
// keep it that way: no imports, no other Netscript calls.
//
// Not ns.spawn from the driver: spawn kills the caller before it tries the
// launch and checks nothing first, so a daemon that then fails to start leaves
// NOTHING running. Here a failed launch puts the driver back.
//
// args: [daemon path, driver path]

const TRIES = 25;
const WAIT_MS = 200;

/** @param {NS} ns */
export async function main(ns) {
  const daemon = String(ns.args[0] ?? "");
  const driver = String(ns.args[1] ?? "");
  if (!daemon) {
    ns.tprint("ERROR: handoff.js needs the daemon's path - it is started by early/driver.js, not by hand.");
    return;
  }

  // The driver exits right after starting this; its RAM is free within a tick.
  for (let i = 0; i < TRIES; i++) {
    await ns.sleep(WAIT_MS);
    const pid = ns.run(daemon, 1);
    if (pid !== 0) {
      ns.tprint(`Started ${daemon} (pid ${pid}) in the room the driver left.`);
      return;
    }
  }

  ns.tprint(`ERROR: ${daemon} still would not start with the driver gone - see its error above, if any.`);
  // Put the cold boot back rather than leave home idle; it retries from there.
  if (driver && ns.run(driver, 1) === 0) {
    ns.tprint(`ERROR: could not restart ${driver} either. Run it by hand: run ${driver}`);
  }
}
