// bn15/daemon.js
//
// BN15 ("The Secrets of the Dark Net") orchestrator. The strategy is the shared
// lib/gang-daemon.js; what the node owns is BITNODE[15] in lib/config.js.
// Verified against bitburner-src (dev) BitNode.tsx on 2026-10-03:
//
//   HackingLevelMultiplier 0.6, HackingSpeedMultiplier 0.6
//   combat stats 0.7, charisma 1.1
//   ServerMaxMoney 0.8, ServerStartingMoney 0.5   script hack money untouched
//   AugmentationMoneyCost 3, DaedalusAugsRequirement 20
//   GangUniqueAugs 0.3                            the gang sells far fewer augs
//   CorporationValuation 0.2
//   BladeburnerRank 0.2, BladeburnerSkillCost 3   Bladeburner is NOT the way here
//   WorldDaemonDifficulty 2                       hacking 6000 to finish
//
// WHAT THIS DAEMON DOES NOT DO: the node's own mechanic. BN15 enlarges the dark
// net (ns.dnet), whose caches pay money and experience and whose final lab hands
// out The Red Pill - by the game's own guide the quicker finish. Nothing in this
// repo automates the dark net yet, so this is the node run the plain way:
// hacking for money (it still pays here), a gang for the rest, the ordinary
// faction ladder to Daedalus (only 20 augmentations needed), and the long climb
// to hacking 6000 at x0.6. It will finish; it will not be fast.
//
// Its Source-File (TOR and the full dark web from the start of every node, and
// The Red Pill obtainable through the dark net everywhere) only pays off once
// there IS dark net automation, so writing that comes before running this.
// Never run live as of writing.

import { forNode } from "../lib/config.js";
import { runGangDaemon } from "../lib/gang-daemon.js";

/** @param {NS} ns */
export async function main(ns) {
  await runGangDaemon(ns, forNode(15));
}
