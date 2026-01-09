import { weight } from './weight.js';
import { crack } from './crack.js'

/** @param {NS} ns */
export async function walk(ns) {
  let q = []
  const visited = new Set();
  const serv_struct = {};
  q.push("home")
  visited.add("home")
  while (q.length > 0) {
    let server = q.shift()
    let wgt = await weight(ns, server)
    let root = await crack(ns, server)
    serv_struct[server] = {
          hasRoot: root,
          weight: wgt
        }

    for (const neighbor of ns.scan(server)) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        q.push(neighbor);
      }
    }
  }
  return serv_struct
}