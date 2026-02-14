
/**
 * 
 * @param {NS} ns 
 * @param {number} torCost 
 */
async function buyTOR(ns, torCost) {
    if (ns.singularity.purchaseTor()) {
        return true;
    }

    ns.tprint("Cannot buy TOR. Launching stargate and working.");
    if (!ns.scriptRunning("stargate.js", "home")) {
        ns.run("stargate.js", 1);
        ns.tprint("Launched stargate.js");
    }

    await startCompanyWork(ns);
}