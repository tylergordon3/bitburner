import { log } from "../lib/io";
import { money } from "../lib/money";
import { assert, exec } from "../lib/util";

/**
 * @param {NS} ns
 * @returns {number} 
 */
function choose_threshold(ns) {
    if (ns.getServer("home").maxRam < 512) {
        return Math.ceil(ns.singularity.getUpgradeHomeRamCost());
    }

    return 5 * 1e6;
}

/**
 * @param {NS} ns
 * @param {number} threshold
 */
async function commit_crimes(ns, threshold) {
    assert(threshold > 0);
    log(ns, "Commit crimes to raise money and lower karma");
    const script = "singularity/crime.js";
    const option = { preventDuplicates: true, threads: 1};
    ns.exec(script, "home", option, threshold);

    while (ns.scriptRunning(script, "home")) {
        await ns.sleep(5e3);
    }
}

/**
 * @param {NS} ns
 */
function load_chain(ns) {
    exec(ns, './chain/misc.js')
}

/**
 * @param {NS} ns
 * @returns {boolean}
 */
function is_upgrade_home_ram(ns) {
    return ns.getServer("home").maxRam < 512;
}

/**
 * @param {NS} ns
 */
export async function main(ns) {
    ns.disableLog("sleep");

    const threshold = choose_threshold(ns);
    if (money(ns) > threshold && !is_upgrade_home_ram(ns)) {
        load_chain(ns);
        return
    }
    await commit_crimes(ns, threshold);

    if (is_upgrade_home_ram(ns)) {
        log(ns, "Raise money to upgrade home RAM");

        const cost = ns.singularity.getUpgradeHomeRamCost();
        let success = ns.singularity.upgradeHomeRam();
        while (!success) {
            await commit_crimes(ns, cost);
            success = ns.singularity.upgradeHomeRam();
        }

        ns.singularity.softReset("./go.js");
    }
    load_chain(ns);
}