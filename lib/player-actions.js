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
      ns.singularity.gymWorkout(
        GYM,
        /** @type {any} */ (stat),
        false
      );

      return {
        action: "Training",
        detail: `${stat} ${current}/${needed}`,
        stat,
        current,
        needed,
      };
    }
  }

  return null;
}

/** @param {NS} ns */
export async function commitHomicideIfUseful(ns, reason = "money") {
  const crime = /** @type {any} */ ("Homicide");
  const chance = ns.singularity.getCrimeChance(crime);

  if (chance >= 0.8) {
    ns.singularity.commitCrime(crime, false);

    return {
      action: "Crime",
      detail: `Homicide for ${reason}`,
      crime: "Homicide",
      chance,
    };
  }

  return null;
}