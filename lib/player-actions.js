// lib/player-actions.js

const GYM = "Powerhouse Gym";

const COMBAT_STATS = ["strength", "defense", "dexterity", "agility"];

const STUDY_LOCATION = "Rothman University";
const STUDY_CLASS = "Algorithms";
const EARLY_HACK_TARGET = 75;
const EARLY_MUG_CHANCE = 0.75;

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
        shouldFocus(ns)
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
    ns.singularity.commitCrime(crime, shouldFocus(ns));

    return {
      action: "Crime",
      detail: `Homicide for ${reason}`,
      crime: "Homicide",
      chance,
    };
  }

  return null;
}

/** @param {NS} ns */
export function shouldFocus(ns) {
  try {
    return !ns.singularity
      .getOwnedAugmentations(true)
      .includes("Neuroreceptor Management Implant");
  } catch {
    return true;
  }
}

/** @param {NS} ns */
export async function doEarlyBootstrapIfNeeded(ns) {
  const player = ns.getPlayer();
  const hacking = player.skills?.hacking ?? ns.getHackingLevel();

  if (hacking < EARLY_HACK_TARGET) {
    ns.singularity.universityCourse(
      STUDY_LOCATION,
      STUDY_CLASS,
      shouldFocus(ns)
    );

    return {
      action: "Studying",
      detail: `Hacking ${hacking}/${EARLY_HACK_TARGET}`,
    };
  }

  const mug = /** @type {any} */ ("Mug");
  const mugChance = ns.singularity.getCrimeChance(mug);

  if (mugChance < EARLY_MUG_CHANCE) {
    const strength = player.skills?.strength ?? 0;
    const defense = player.skills?.defense ?? 0;

    const stat = strength <= defense ? "strength" : "defense";

    ns.singularity.gymWorkout(
      GYM,
      /** @type {any} */ (stat),
      shouldFocus(ns)
    );

    return {
      action: "Training",
      detail: `Mug chance ${ns.format.percent(mugChance)} / ${ns.format.percent(EARLY_MUG_CHANCE)} | ${stat}`,
      stat,
      chance: mugChance,
    };
  }

  return null;
}