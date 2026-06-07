// lib/player-actions.js

const GYM = "Powerhouse Gym";

const COMBAT_STATS = ["strength", "defense", "dexterity", "agility"];

/** @param {NS} ns */
export async function trainCombatIfNeeded(ns, targets = {}) {
  const player = ns.getPlayer();

  for (const stat of COMBAT_STATS) {
    const current = player.skills?.[stat] ?? player[stat] ?? 0;
    const needed = targets[stat] ?? 0;

    if (current < needed) {
      ns.print(`Training ${stat}: ${current}/${needed}`);
      ns.singularity.gymWorkout(
        GYM,
        /** @type {any} */ (stat),
        false
    );
      return true;
    }
  }

  return false;
}

/** @param {NS} ns */
export async function commitHomicideIfUseful(ns, reason = "money") {
  const chance = ns.singularity.getCrimeChance("Homicide");

  if (chance >= 0.8) {
    ns.print(`Committing homicide for ${reason}. Chance: ${ns.format.percent(chance)}`);
    ns.singularity.commitCrime("Homicide", false);
    return true;
  }

  return false;
}