// bn11/daemon.js
//
// BN11 ("The Big Crash") orchestrator. The strategy is the shared
// lib/gang-daemon.js; what the node owns is BITNODE[11] in lib/config.js.
// Verified against bitburner-src (dev) BitNode.tsx on 2026-10-03:
//
//   ServerMaxMoney 0.01, ServerGrowthRate 0.2   hacking earns ~1% of normal
//   HackingLevelMultiplier 0.6, HackExpGain 0.5
//   CrimeMoney 3                                crime pays TRIPLE
//   (no GangSoftcap override)                   gang income un-softcapped
//   CompanyWorkMoney 0.5, HacknetNodeMoney 0.1, CorporationValuation 0.1
//   AugmentationMoneyCost 2, 4S data and API x4
//   InfiltrationMoney / InfiltrationRep 2.5     (manual; the bot doesn't infiltrate)
//   WorldDaemonDifficulty 1.5                   hacking 4500 to finish
//
// So money is crime, then the gang: the player's slot grinds karma (homicide,
// which here is also the best money), the sleeves crime alongside it at triple
// pay, and once the gang exists it carries the aug purchases. The corporation
// and hacknet nodes are switched off - neither pays back here. The botnet still
// runs: it earns little, but it is the hacking EXPERIENCE that the 4500-level
// finish needs.
//
// Its Source-File is the least valuable left (company salary/reputation, and a
// few percent off the aug price growth), which is why it is last on the plan.
// Never run live as of writing.

import { forNode } from "../lib/config.js";
import { runGangDaemon } from "../lib/gang-daemon.js";

/** @param {NS} ns */
export async function main(ns) {
  await runGangDaemon(ns, forNode(11));
}
