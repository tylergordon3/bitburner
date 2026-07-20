// bn3/corp-create.js
//
// One-shot corporation *creation*, split out of bn3/daemon.js so the daemon
// doesn't carry singularity/corporation.createCorporation (20GB) on home RAM.
// The daemon exec's this whenever it has no corporation yet; it creates one and
// exits. Idempotent: a no-op (quick exit) once a corp already exists.
//
// In BN3 the seed-funded path is free, so this fires almost immediately; the
// self-funded ($150b) path is only a fallback for the theoretically-impossible
// case where seed funding is blocked. Mirrors how the corp's day-to-day play
// lives in its own scripts (lib/corp-steady.js / lib/corp-build.js).

import { CONFIG } from "../lib/config.js";

const CORP_NAME = CONFIG.corp.name;

/** @param {NS} ns */
export async function main(ns) {
  const c = ns.corporation;
  if (c.hasCorporation()) return;

  if (c.canCreateCorporation(false) === "Success") {
    if (c.createCorporation(CORP_NAME, false)) {
      ns.tprint(`Created corporation ${CORP_NAME} (seed funded).`);
      return;
    }
  }

  const money = ns.getPlayer().money ?? 0;
  if (c.canCreateCorporation(true) === "Success" && money >= CONFIG.corp.selfFundCost) {
    if (c.createCorporation(CORP_NAME, true)) {
      ns.tprint(`Created corporation ${CORP_NAME} (self funded).`);
    }
  }
}
