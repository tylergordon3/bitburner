// bn13/daemon.js
//
// BN13 ("They're lunatics") orchestrator. The strategy is the shared
// lib/blade-daemon.js - the BN6/BN7 engine - with BITNODE[13] in lib/config.js
// for tuning, plus the node's own mechanic, Stanek's Gift (lib/stanek.js).
// Verified against bitburner-src (dev) BitNode.tsx on 2026-10-03:
//
//   HackingLevelMultiplier 0.25, HackExpGain 0.1
//   WorldDaemonDifficulty 3                    hacking 9000 - out of reach
//   ScriptHackMoney 0.2, ServerMaxMoney 0.3375, ServerStartingSecurity 3
//   crime / company / hacknet / contract money 0.4
//   combat and charisma levels 0.7, every exp gain 0.5
//   FactionWorkRepGain 0.6
//   GangSoftcap 0.3, GangUniqueAugs 0.1, CorporationValuation 0.001
//   BladeburnerRank 0.45, BladeburnerSkillCost 2
//   StaneksGiftPowerMultiplier 2, StaneksGiftExtraSize 1
//
// Everything is cut hard except Bladeburner, which is why the game's own guide
// sends you through the black ops here - the same finish as BN7, at 0.45 rank
// gain instead of 0.6. What the node gives back is the Gift at double power: a
// grid of fragments that multiply chosen stats, charged by scripts. Hacking pays
// a fifth of normal on a third of the money, so a large slice of the botnet is
// better spent charging Bladeburner and combat fragments than batching.
//
// ORDER MATTERS at the very start: the Gift must be accepted before the first
// augmentation is bought (NeuroFlux aside) - and, with Source-File 7.3, before
// joining the Bladeburner division, because joining grants The Blade's
// Simulacrum. early/stanek-boot.js does that from the cold-start driver, ahead
// of early/blade-boot.js; see `stanek` in lib/config.js.
//
// Next BitNode: the shared plan (a daemon arg, else `campaign.order`). Never run
// live as of writing.
//
// The config is resolved with forReset, not forNode(13): BN13's challenge run
// (CHALLENGE in lib/config.js - finish the node WITHOUT the Gift) is this same
// daemon with `stanek.enabled` overlaid to false, and with forNode the core's
// gate would launch early/stanek-boot.js and accept the Gift in its first tick.
// Outside a challenge run forReset IS forNode(13).

import { forReset } from "../lib/config.js";
import { runBladeDaemon } from "../lib/blade-daemon.js";

/** @param {NS} ns */
export async function main(ns) {
  await runBladeDaemon(ns, forReset(ns.getResetInfo()));
}
