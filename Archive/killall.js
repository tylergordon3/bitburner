/** @param {NS} ns */
export async function main(ns) {
  const visited = new Set(["home"]);
  const queue = ["home"];

  // Get purchased servers once
  const purchased = new Set(ns.getPurchasedServers());

  while (queue.length > 0) {
    const server = queue.shift();

    for (const neighbor of ns.scan(server)) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  for (const server of visited) {
    // Skip home and purchased servers
    if (server === "home") continue;
    if (purchased.has(server)) continue;

    if (ns.hasRootAccess(server)) {
      ns.killall(server);
      ns.tprint(`Killed all scripts on ${server}`);
    }
  }

  ns.tprint("Finished killing scripts on world servers.");
}