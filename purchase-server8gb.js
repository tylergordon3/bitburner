/** @param {NS} ns */
export async function main(ns) {
  let ram = 8;

  for (let i = 0; i < ns.getPurchasedServerLimit(); i++) {
    ns.print(ns.getPurchasedServerLimit())
    let cost = ns.getPurchasedServerCost(ram);
    ns.print(cost)
    while (ns.getServerMoneyAvailable("home") < cost) {
      await ns.sleep(2000);
    }
    let hostname = "pserv-" + i;
    ns.purchaseServer(hostname, ram);
    ns.print(hostname)
    ns.scp("early-hack-template.js", hostname);
    ns.exec("early-hack-template.js", "joesguns", 3);
  }
}