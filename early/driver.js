// early/driver.js

/** @param {NS} ns */
export async function main(ns) {
  const daemon = "/bn4/daemon.js";
  const worker = "/early/worker.js";

  const TARGET = "joesguns";
  const HOME_RESERVE = 8;

  while (true) {
    // Start daemon when possible
    if (ns.getServerMaxRam("home") >= ns.getScriptRam(daemon) + HOME_RESERVE) {
      ns.scriptKill(worker, "home");
      ns.scriptKill("/startup.js", "home");

      ns.run(daemon);

      ns.tprint(`Started ${daemon}`);
      return;
    }

    // Upgrade RAM aggressively
    try {
      while (ns.singularity.upgradeHomeRam()) {}
    } catch {}

    // Join faction invites
    try {
      for (const faction of ns.singularity.checkFactionInvitations()) {
        ns.singularity.joinFaction(
          /** @type {any} */ (faction)
        );
      }
    } catch {}

    try {
      const player = ns.getPlayer();
      const factions = player.factions;
      const money = ns.getServerMoneyAvailable("home");

      // Focused faction rep early
      if (factions.includes("CyberSec")) {
        ns.singularity.workForFaction(
          /** @type {any} */ ("CyberSec"),
          "hacking",
          true
        );
      }

      else if (factions.includes("NiteSec")) {
        ns.singularity.workForFaction(
          /** @type {any} */ ("NiteSec"),
          "hacking",
          true
        );
      }

      // Study hacking early if low
      else if (player.skills.hacking < 150) {
        ns.singularity.universityCourse(
          "Rothman University",
          "Algorithms",
          true
        );
      }

      // Crime only if poor
      else if (money < 5e6) {
        if (ns.singularity.getCrimeChance("Homicide") >= 0.8) {
          ns.singularity.commitCrime("Homicide", true);
        } else {
          ns.singularity.commitCrime("Mug", true);
        }
      }

    } catch {}

    // Launch hacking worker if not already running
    if (!ns.isRunning(worker, "home")) {
      const freeRam =
        ns.getServerMaxRam("home") -
        HOME_RESERVE;

      const threads = Math.floor(
        freeRam / ns.getScriptRam(worker)
      );

      if (threads > 0) {
        ns.run(worker, threads, TARGET);
      }
    }

    await ns.sleep(30000);
  }
}