import { log } from "../lib/io";
import { money } from "../lib/money";
import { assert } from "../lib/util";
import { CrimeType } from "../NetscriptDefinitions";

/**
 * @param {NS} ns
 * @param {number} threshold
*/
async function commit_other_crime(ns, threshold) {
    assert(threshold > 0);
    log(ns, `Commit homicide to raise money to ${threshold}`);
    ns.singularity.commitCrime(CrimeType.homicide, true);
    while (money(ns) < threshold) {
        await ns.sleep(1e3);
    }
    ns.singularity.stopAction();
}

/**
 * @param {NS} ns
 * @returns {boolean}
 */
function has_mug_threshold(ns) {
    const stat = ns.getPlayer().skills;
    return (
        stat.agility >= 10
        && stat.defense >= 10
        && stat.dexterity >= 10
        && stat.strength >= 10
    );
}

/**
 * @param {NS} ns
 * @returns {boolean}
 */
function has_shoplift_threshold(ns) {
    const stat = ns.getPlayer().skills;
    return stat.agility >= 5 && stat.dexterity >= 5;
}

/**
 * @param {NS} ns
 */
async function mug_someone(ns) {
    log(ns, "Mug someone to raise money and combat stats");
    const stat = ns.singularity.getCrimeStats(CrimeType.shoplift);
    const time = 10 * stat.time;
    ns.singularity.commitCrime(CrimeType.shoplift, true);
    if (!has_mug_threshold(ns)) {
        await ns.sleep(time);
    }
    ns.singularity.stopAction();
}

/**
 * @param {NS} ns
 */
async function shoplift(ns) {
    log(ns, "Shoplift to raise money, and Dexerity and Agility stats");
    const stat = ns.singularity.getCrimeStats(CrimeType.shoplift);
    const time = 10 * stat.time;
    ns.singularity.commitCrime(CrimeType.shoplift, true);
    if (!has_shoplift_threshold(ns)) {
        await ns.sleep(time);
    }
    ns.singularity.stopAction();
}

/**
 * @param {NS} ns
 */
export async function main(ns) {
    ns.disableLog("getServerMoneyAvailable");
    ns.disableLog("sleep");
    const checkArg = (...args) => {
        const first = args[0];
        if (typeof first === 'number' && first > 0) {
            return first;
        }
    };

    await shoplift(ns);
    await mug_someone(ns);
    await commit_other_crime(ns, checkArg())
}