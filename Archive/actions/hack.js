/** @param {NS} ns */
export async function main(ns) {
    const target = ns.args[0];
    // @ts-ignore
    await ns.hack(target)
}