

/**
 * For startup
 * @param {NS} ns 
 * @param {number} target 
 */
async function studyToResetTarget(ns, target) {

    if (ns.getPlayer().skills.hacking >= target) return;

    ns.singularity.universityCourse(
        "Rothman University",
        "Algorithms",
        true
    );

    while (ns.getPlayer().skills.hacking < target) {
        await ns.sleep(5000);
    }

    ns.singularity.stopAction();
}