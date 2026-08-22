// lib/ns-utils.js
//
// The tiny Netscript wrappers that used to be re-defined in two or three files
// each (early/driver.js, lib/daemon-lib.js, lib/econ.js, lib/backdoor.js,
// lib/sleeves.js, lib/grafting.js, lib/sleeve-shop.js, hacking/manager.js,
// lib/pserv.js). Imports only lib/config.js.
//
// RAM: Bitburner charges the API calls of every function REACHED from a script's
// main, so importing this module costs an importer exactly the calls inside the
// helpers it actually uses - the same calls it was already making inline. The one
// to be deliberate about is inGangSafe (ns.gang.inGang, 1GB): only reach it from
// scripts that need the answer.

import { CONFIG } from "./config.js";

const HOME = CONFIG.paths.home;

/** @param {NS} ns */
export function playerMoney(ns) {
  return ns.getPlayer().money ?? 0;
}

/** @param {NS} ns */
export function hackingLevel(ns) {
  return ns.getPlayer().skills?.hacking ?? ns.getHackingLevel();
}

/**
 * Cash the daemon is holding for a money-gated faction invite (Daedalus / The
 * Covenant / Illuminati), published on globalThis. Every spender respects it;
 * 0 on nodes/ticks that aren't hoarding.
 */
export function moneyFloor() {
  return globalThis.gordMoneyFloor ?? 0;
}

/**
 * Spendable cash = money above the hoard floor. The off-home spenders (sleeves,
 * the sleeve shop, grafting) budget against this so an invite hoard pauses them
 * instead of being spent away.
 * @param {NS} ns
 */
export function spendableMoney(ns) {
  return Math.max(0, playerMoney(ns) - moneyFloor());
}

/** @param {NS} ns - true if we're in a gang; false (not just missing API) otherwise. */
export function inGangSafe(ns) {
  try {
    return ns.gang.inGang();
  } catch {
    return false;
  }
}

/**
 * Hosts the node daemon has reserved (published on the shared globalThis) that
 * the botnet and the server-fleet manager must leave alone - e.g. a cloud server
 * dedicated to /lib/gang.js. Empty when nothing is reserved.
 * @returns {Set<string>}
 */
export function reservedHosts() {
  const r = globalThis.gordReservedHosts;
  return r instanceof Set ? r : new Set(r ?? []);
}

/** @param {NS} ns @param {string} host */
export function freeRam(ns, host) {
  return ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
}

export { HOME };
