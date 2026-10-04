// bn14/daemon.js
//
// BN14 ("IPvGO Subnet Takeover") orchestrator. The whole strategy is the shared
// lib/blade-daemon.js - the same engine as BN6/BN7 - with BITNODE[14] in
// lib/config.js for tuning. Verified against bitburner-src (dev) BitNode.tsx on
// 2026-10-03:
//
//   WorldDaemonDifficulty 5                    hacking 15,000 to finish...
//   HackingLevelMultiplier 0.4, HackingSpeedMultiplier 0.3    ...at 40% levels
//   ScriptHackMoney 0.3, ServerMaxMoney 0.7
//   combat stats 0.5, CrimeSuccessRate 0.4
//   FactionWorkRepGain 0.2, CompanyWorkRepGain 0.2
//   AugmentationMoneyCost 1.5, GangSoftcap 0.7, GangUniqueAugs 0.4
//   BladeburnerRank 0.6, BladeburnerSkillCost 2          exactly BN7's two
//   GoPower 4                                  every IPvGO bonus is worth 4x
//
// The hacking finish is not realistic (15,000 at x0.4), so the node ends the way
// BN7 does: through the black ops. Bladeburner carries the same two penalties as
// there and nothing else; what BN14 adds is halved combat stats - and the cure
// for that is the node's own mechanic. lib/go.js (which every daemon runs) plays
// Tetrads for a bonus to all four combat stat LEVELS and Daedalus for reputation
// gain, and here each is worth four times what it is anywhere else. So the Go
// helper is not a side income in this node; it is what makes the Bladeburner
// numbers work, and it deserves its host before the luxury scripts.
//
// Sleeves (SF10) work for the division as in BN7; the gang is founded when karma
// allows but is softcapped at 0.7. The world daemon is still backdoored if the
// hacking level ever gets there - both finishes stay open.
//
// Cold boot: early/driver.js launches early/blade-boot.js wherever
// bladeburner.enabled, as in BN6/BN7. Next BitNode: the shared plan (a daemon
// arg, else `campaign.order`). Never run live as of writing.

// The config is resolved with forReset, not forNode(14): BN14's challenge run
// (CHALLENGE in lib/config.js - finish the node without a move on the Go board)
// is this same daemon with `go.enabled` overlaid to false, and with forNode the
// core would launch lib/go.js as a required helper. Outside a challenge run
// forReset IS forNode(14).

import { forReset } from "../lib/config.js";
import { runBladeDaemon } from "../lib/blade-daemon.js";

/** @param {NS} ns */
export async function main(ns) {
  await runBladeDaemon(ns, forReset(ns.getResetInfo()));
}
