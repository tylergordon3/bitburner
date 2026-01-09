/** @param {NS} ns */
export async function main(ns) {
  const script = ns.args[0];
  const PORT = 1;
  const openers = countPortOpeners(ns);
  let q = []
  const visited = new Set();
  q.push("home")
  visited.add("home")
  while (q.length > 0) {
    let server = q.shift()

    if (!ns.hasRootAccess(server)) {
      const required = ns.getServerNumPortsRequired(server);
      if (required <= openers) {
        openAllPorts(ns, server);
        ns.nuke(server);
        ns.tprint(`Rooted ${server}`);
      }
    }

    if (ns.hasRootAccess(server)) {

      ns.scp(script, server, "home")
      if (script === "share.js") {
        const thread_count = num_threads(ns, "share.js", server)
        if (thread_count != 0) {
          const share_pid = ns.exec("share.js", server, thread_count)
          if (share_pid === 0) {
            ns.tprint(`Share failed on ${server} with ${thread_count}.`)
          } else {
            ns.tprint(`Share succeeded on ${server} with ${thread_count}.`)
          }
        }
      }
    }

    for (const neighbor of ns.scan(server)) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        q.push(neighbor);
      }
    }
  }

  if (script === 'hack.js') {
    let target = determine_target(ns, visited)
    for (const serv of visited) {
      if (ns.hasRootAccess(serv)) {
        ns.scp(script, serv, "home")
        const thread_count = num_threads(ns, "hack.js", serv)
        if (thread_count != 0) {
          const hack_pid = ns.exec("hack.js", serv, thread_count, target)
          if (hack_pid === 0) {
            ns.tprint(`Hack failed on ${serv} with ${thread_count}.`)
          } else {
            ns.tprint(`Hack succeeded on ${serv} with ${thread_count}.`)
          }
        }
      }
    }
  }
}

export function is_my_server(ns, serv) {
  if (serv === "home" || serv.purchasedByPlayer) {
    return true
  } else {
    return false
  }
}

/** @param {NS} ns */
export function weight(ns, host) {
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

/** @param {NS} ns */
export function determine_target(ns, server_set) {
  let target = ''
  let target_weight = 0
  for (const server of server_set) {
    let serv_weight = weight(ns, server)
    if (serv_weight > target_weight) {
      target = server
      target_weight = serv_weight
    }
  }
  ns.tprintf(`Target Server: ${target}, Weight: ${target_weight}`)
  return target
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

function num_threads(ns, script, server) {
  const free_ram = ns.getServerMaxRam(server) - ns.getServerUsedRam(server)
  const num_threads = Math.floor(free_ram / ns.getScriptRam(script))

  return num_threads
}