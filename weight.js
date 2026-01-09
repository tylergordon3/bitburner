/** @param {NS} ns */
export async function weight(ns, host) {
  const server = ns.getServer(host)
  const thresh = Math.floor(ns.getHackingLevel() / 2)
  if (is_my_server(ns, host)
    || !server.hasAdminRights
    || server.requiredHackingSkill > thresh
  ) {
    return 0
  }
  return server.moneyMax / server.minDifficulty
}

export function is_my_server(ns, serv) {
  if (serv === "home" || serv.purchasedByPlayer) {
    return true
  } else {
    return false
  }
}

