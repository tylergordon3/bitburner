
/**
 * @param {NS} ns
 */
export async function stronk(ns) {
    while (ns.getPlayer().skills.strength < 100) {
        ns.singularity.gymWorkout("Powerhouse Gym", "str", true);
    }
    ns.tprint("Strength is level 100.")

    while (ns.getPlayer().skills.defense < 100) {
        ns.singularity.gymWorkout("Powerhouse Gym", "def", true);
    }
    ns.tprint("Defense is level 100.")
}

/**
 * @param {NS} ns
 */
export async function earlyCrime(ns) {
    stronk(ns);

    ns.singularity.commitCrime("Mug", true);
}