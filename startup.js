/** @param {NS} ns **/
export async function main(ns) {
  ns.run("deploy.js", 1);
  ns.run("purchase-servers-8gb.js", 1);
  ns.run("hacknet-manager.js", 1);
}