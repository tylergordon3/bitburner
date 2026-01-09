/**
 * NOTE: Assume that we have root access on the target server.
 *
 * Hack a server and steal its money.  We weaken the server's security as
 * necessary, grow the server in case the amount of money on the server is
 * below our threshold, and hack the server when all conditions are met.  We
 * want one command line argument, i.e. the name of the server to hack.
 *
 * Usage: run hack.js [targetServer]
 * Example: run hack.js n00dles
 *
 * @param ns The Netscript API.
 * 
 * @args : target
 * Source: https://github.com/quacksouls/bitwalk/blob/main/doc/script.md
 */
export async function main(ns) {
  // The target server
  const target = ns.args[0];

  // Threshold set at 75% of server max $ before hacking
  // NOTE: Even if bankrupt hacking provides xp still
  const money_threshold = Math.floor(ns.getServerMaxMoney(target) * 0.75);

  // Security threshold for server - if higher weaken server
  const security_threshold = ns.getServerMinSecurityLevel(target) + 5;

  // Loop to hack/grow/weaken
  for (;;) {
        const money = ns.getServerMoneyAvailable(target);
        if (ns.getServerSecurityLevel(target) > security_threshold) {
            await ns.weaken(target);
        } else if (money < money_threshold) {
            await ns.grow(target);
        } else {
            await ns.hack(target);
        }
    }
}