/** 
 * @param {NS} ns
 */
export async function main(ns) {
    const TARGET_HACK = 100;

    ns.disableLog("ALL");

    // Study! 
    await studyToResetTarget(ns, TARGET_HACK);

    
}