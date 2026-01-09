import { walk } from './walkServers.js'
import { print_struct } from './print_struct.js'

/** @param {NS} ns */
export async function main(ns) {
  let servers = await walk(ns)
  await print_struct(ns, servers)
}