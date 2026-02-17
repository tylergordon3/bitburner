import { loop } from "../lib/constants/time";

/**
 * @param {NS} ns
 */
export async function stronk(ns) {
    while (ns.getPlayer().skills.strength < 100) {
        ns.singularity.gymWorkout("Powerhouse Gym", "str", true);
        await ns.sleep(loop);
    }
    ns.tprint("Strength is level 100.")

    while (ns.getPlayer().skills.defense < 100) {
        ns.singularity.gymWorkout("Powerhouse Gym", "def", true);
        await ns.sleep(loop);
    }
    ns.tprint("Defense is level 100.")
}

/**
 * @param {NS} ns
 */
export async function earlyCrime(ns) {
    ns.exec('./stargate.js', "home", 1);
    await stronk(ns);
    // tjos
    ns.singularity.commitCrime("Mug", true);
    return true
}