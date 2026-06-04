/** 
 * Calculates number of threads that can be run
 * 
 * 
 * @args: [0] script, [1] server to use
 * 
 * @param {NS} ns */
export async function main(ns) {
  const script = ns.args[0];
  const server = ns.args[1];

  // @ts-ignore
  const free_ram = ns.getServerMaxRam(server) - ns.getServerUsedRam(server)
  // @ts-ignore
  const num_threads = Math.floor(free_ram / ns.getScriptRam(script))

  ns.writePort(1, num_threads)
  return num_threads
}