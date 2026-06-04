/** @param {NS} ns **/
export async function main(ns) {
    let servers = ns.scan("home");
    let ramPerThread = ns.getScriptRam("early-hack-template.js");
    for (let serverName of servers) {
        await ns.scp("early-hack-template.js", serverName);

        let openPorts = 0;
        if (ns.fileExists("BruteSSH.exe")) {
            ns.brutessh(serverName);
            openPorts++;
        }
        if (ns.fileExists("FTPCrack.exe")) {
            ns.ftpcrack(serverName);
            openPorts++;
        }
        if (ns.fileExists("RelaySMTP.exe")) {
            ns.relaysmtp(serverName);
            openPorts++;
        }
        if (ns.fileExists("HTTPWorm.exe")) {
            ns.httpworm(serverName);
            openPorts++;
        }
        if (ns.fileExists("SQLInject.exe")) {
            ns.sqlinject(serverName);
            openPorts++;
        }
        if (ns.getServerNumPortsRequired(serverName) <= openPorts) {
            ns.nuke(serverName);
        }

        if (ns.hasRootAccess(serverName)) {
            let ramAvailable = ns.getServerMaxRam(serverName)
                - ns.getServerUsedRam(serverName);
            let threads = Math.floor(ramAvailable / ramPerThread);
            if (threads > 0) {
                ns.exec("early-hack-template.js", serverName, threads, "joesguns");
            }
        }
    }
}