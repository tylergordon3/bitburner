/** @param {NS} ns */
export async function main(ns) {
  const target = String(ns.args[0]);
  const delay = Number(ns.args[1] ?? 0);

  if (delay > 0) await ns.sleep(delay);
  await ns.grow(target);
}