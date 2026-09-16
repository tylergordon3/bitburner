// bn7/daemon.js
//
// BN7 ("Bladeburners 2079") orchestrator. The whole strategy is the shared
// lib/blade-daemon.js - this node is BN6 with Bladeburner's own penalties
// stacked on top, so it runs the same engine with a different tuning table
// (BITNODE[7] in lib/config.js). Verified against bitburner-src (dev) on
// 2026-09-15:
//
//   - ScriptHackMoney 0.5 (BN6: 0.75) on a ServerMaxMoney of 0.2: hacking pays
//     a tenth of normal, so contract money and the gang matter more.
//   - AugmentationMoneyCost 3: every aug costs triple, so installs are batched
//     bigger and Hands of Midas keeps a real skill weight.
//   - BladeburnerSkillCost 2: skill points buy half as much, so they go to the
//     levers that pay on every action (Blade's Intuition, Overclock, Reaper,
//     Evasive System, Digital Observer) and Datamancer/Tracer are dropped.
//   - BladeburnerRank 0.6, WorldDaemonDifficulty 2, GangSoftcap 0.7: same as BN6.
//   - Source-File 7 buffs the four bladeburner_* multipliers (+8/12/14%), and
//     SF7.3 hands out The Blade's Simulacrum the moment you join the division.
//     So without a daemon arg this node re-enters itself until it holds SF7.3
//     (bladeburner.reenterUntilSF); the HUD's FINISH toggle holds Operation
//     Daedalus regardless, and `run bn7/daemon.js <n>` overrides the plan.
//
// Sleeves (SF10) are the node's second engine: contract/operation ATTEMPTS are
// its real time gate, and a sleeve on "Infiltrate Synthoids" adds attempts to
// every contract and operation every minute, while one that can clear the
// success bar runs a contract for the player's rank - see lib/sleeves.js.
//
// Cold boot: early/driver.js launches early/blade-boot.js (gym to 100 in every
// combat stat, join, Training) wherever bladeburner.enabled, so the division is
// running long before home has grown enough for this daemon.

import { forNode } from "../lib/config.js";
import { runBladeDaemon } from "../lib/blade-daemon.js";

/** @param {NS} ns */
export async function main(ns) {
  await runBladeDaemon(ns, forNode(7));
}
