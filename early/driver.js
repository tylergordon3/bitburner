// early/driver.js
/** @import { FactionName, GymType } from "../types/NetscriptDefinitions" */

/** @param {NS} ns */
export async function main(ns) {
  const daemon = "/bn4/daemon.js";
  const worker = "/early/worker.js";

  while (true) {
    // Start daemon when possible
    if (ns.getServerMaxRam("home") >= ns.getScriptRam(daemon) + 8) {
      ns.scriptKill(worker, "home");
      ns.run(daemon);
      return;
    }

    // Upgrade RAM aggressively
    try {
      while (ns.singularity.upgradeHomeRam()) {}
    } catch {}

    // Join factions
    try {
      for (const f of ns.singularity.checkFactionInvitations()) {
        ns.singularity.joinFaction(
          /** @type {any} */ (f)
        );
      }
    } catch {}

    // Work faction rep if possible
    try {
      if (ns.getPlayer().factions.includes("CyberSec")) {
        ns.singularity.workForFaction(
          /** @type {any} */ ("CyberSec"),
          "hacking",
          false
        );
      }
    } catch {}

    // Crime fallback for money
    try {
      if (ns.getServerMoneyAvailable("home") < 5e6) {
        if (ns.singularity.getCrimeChance("Homicide") > 0.8) {
          ns.singularity.commitCrime("Homicide", false);
        } else {
          ns.singularity.commitCrime("Mug", false);
        }
      }
    } catch {}

    // Launch worker if not running
    if (!ns.isRunning(worker, "home")) {
      const threads = Math.floor(
        (ns.getServerMaxRam("home") - 8) /
        ns.getScriptRam(worker)
      );

      if (threads > 0) {
        ns.run(worker, threads, "n00dles");
      }
    }

    await ns.sleep(30000);
  }
}