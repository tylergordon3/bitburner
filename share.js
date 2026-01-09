/** @param {NS} ns */
export async function main(ns) {
    for (;;) {
        await ns.share();
    }
}