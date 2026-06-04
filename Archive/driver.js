import { applyAndWork } from "../singularity/workforce";
import { studyToResetTarget } from "../singularity/study";
import { buyPrograms, buyTOR } from "../singularity/programs";
import { loop } from "./lib/constants/time";
import { earlyCrime } from "../singularity/crime";

/** 
 * @param {NS} ns
 */
export async function main(ns) {
    const TARGET_HACK = 100;

    ns.disableLog("ALL");
    // ns.run("hacknet-manager.js", 1);
    ns.run("purchase-server8gb.js", 1);
    // Study! 
    await studyToResetTarget(ns, TARGET_HACK);

    if (!buyTOR(ns)) {
        await applyAndWork(ns);
    }

    while (!buyTOR(ns)) {
        ns.sleep(loop);
    }
    
    ns.singularity.stopAction();

    ns.tprint("Criming like a boss while waiting to upgrade RAM.")
    await earlyCrime(ns);
    while (true) {
        await buyPrograms(ns);
        await ns.sleep(loop);
    }
    // ns.singularity.upgradeHomeRam();
    // ns.singularity.stopAction()
   
}