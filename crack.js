/** @param {NS} ns */
export async function crack(ns, server) {
  if (!ns.hasRootAccess(server)){

    if (ns.getHackingLevel() < ns.getServerRequiredHackingLevel(server)) {
      return false;
    }

    const required = ns.getServerNumPortsRequired(server);
    const openers = countPortOpeners(ns)

    if (required <= openers) {
      openAllPorts(ns, server);
      nuke_check = ns.nuke(server);
      if (nuke_check) {
        return true
      } else {
        return false
      }
    }
    return false
  } 
  return true
}

/** @param {NS} ns */
function countPortOpeners(ns) {
  let n = 0;
  if (ns.fileExists("BruteSSH.exe", "home")) n++;
  if (ns.fileExists("FTPCrack.exe", "home")) n++;
  if (ns.fileExists("relaySMTP.exe", "home")) n++;
  if (ns.fileExists("HTTPWorm.exe", "home")) n++;
  if (ns.fileExists("SQLInject.exe", "home")) n++;
  return n;
}

/** @param {NS} ns */
function openAllPorts(ns, server) {
  if (ns.fileExists("BruteSSH.exe", "home")) ns.brutessh(server);
  if (ns.fileExists("FTPCrack.exe", "home")) ns.ftpcrack(server);
  if (ns.fileExists("relaySMTP.exe", "home")) ns.relaysmtp(server);
  if (ns.fileExists("HTTPWorm.exe", "home")) ns.httpworm(server);
  if (ns.fileExists("SQLInject.exe", "home")) ns.sqlinject(server);
}