import { applyAndWork } from "./singularity/workforce";
import { studyToResetTarget } from "./singularity/study";
import { buyTOR } from "./singularity/programs";
import { loop } from "./lib/constants/time";

/** 
 * @param {NS} ns
 */
export async function main(ns) {
    const TARGET_HACK = 100;

    ns.disableLog("ALL");

    // Study! 
    await studyToResetTarget(ns, TARGET_HACK);

    if (!buyTOR(ns)) {
        await applyAndWork(ns);
    }

    while (!buyTOR(ns)) {
        ns.sleep(loop);
    }
    
    ns.singularity.stopAction();
}