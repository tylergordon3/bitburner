/** @param {NS} ns */
export async function main(ns) {
  // Servers that require 0 ports
  const servers0Port = [
    "sigma-cosmetics",
    "joesguns",
    "nectar-net",
    "hong-fang-tea",
    "harakiri-sushi",
  ];

  // Servers that require 1 port
  const servers1Port = [
    "neo-net",
    "zer0",
    "max-hardware",
    "iron-gym",
  ];

  // Deploy to 0-port servers
  for (const serv of servers0Port) {
    await ns.scp("early-hack-template.js", serv);
    if (!ns.hasRootAccess(serv)) {
      ns.nuke(serv);
    }
    ns.exec("early-hack-template.js", serv, 6);
  }

  // Wait until BruteSSH.exe exists
  while (!ns.fileExists("BruteSSH.exe", "home")) {
    await ns.sleep(60_000); // 1 minute
  }

  // Deploy to 1-port servers
  for (const serv of servers1Port) {
    await ns.scp("early-hack-template.js", serv);
    if (!ns.hasRootAccess(serv)) {
      ns.brutessh(serv);
      ns.nuke(serv);
    }
    ns.exec("early-hack-template.js", serv, 12);
  }

  ns.exec("hacknet-manager.js", "home", 1)
}
