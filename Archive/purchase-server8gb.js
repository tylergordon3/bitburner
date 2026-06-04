/** @param {NS} ns */
export async function main(ns) {
  let ram = 8;

  for (let i = 0; i < ns.getPurchasedServerLimit(); i++) {
    let cost = ns.getPurchasedServerCost(ram);
    while (ns.getServerMoneyAvailable("home") < cost) {
      await ns.sleep(2000);
    }
    let hostname = "pserv-" + i;
    ns.purchaseServer(hostname, ram);
  }
}