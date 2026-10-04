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
// WHAT THIS DAEMON DOES NOT DO: the node's own mechanic - and so IT CANNOT
// FINISH THE NODE. BN15 enlarges the dark net (ns.dnet), whose caches pay money
// and experience and whose final lab hands out The Red Pill. Here that lab is
// the ONLY source of it: in BN15 Daedalus does not sell The Red Pill
// (bitburner-src Faction/FactionHelpers.tsx getFactionAugmentationsFiltered,
// "Remove TRP from daedalus in BN15"). Without it installed w0r1d_d43m0n has no
// network connection, and the game treats a server with none as nonexistent -
// every ns call on it throws "Invalid host" (Netscript/NetscriptHelpers
// getServer) - so it can never be rooted, lib/backdoor.js never reports it
// ready, and destroyW0r1dD43m0n's hacking requirement is never met whatever the
// hacking level. The only other scripted finish is the Bladeburner black ops,
// at BladeburnerRank 0.2 with skills at triple cost, which BITNODE[15] leaves off.
//
// Nothing in this repo automates the dark net yet. So what this daemon does is
// run the node the plain way - hacking for money (it still pays here), a gang
// for the rest, the ordinary faction ladder (Daedalus wants only 20
// augmentations) - and build up indefinitely. Ending it takes the dark net lab,
// by hand or by a script that does not exist yet; the earlier claim here that
// the plain way "will finish" was wrong.
//
// Its Source-File (TOR and the full dark web from the start of every node, and
// The Red Pill obtainable through the dark net everywhere) only pays off once
// there IS dark net automation, so writing that comes before running this.
// (`campaign.order` in lib/config.js has BN15 as its last node on those terms:
// the campaign stops in it.) Never run live as of writing.

import { forNode } from "../lib/config.js";
import { runGangDaemon } from "../lib/gang-daemon.js";

/** @param {NS} ns */
export async function main(ns) {
  ns.tprint(
    "WARN: bn15/daemon.js cannot finish BitNode 15. Daedalus does not sell The Red Pill here - it only " +
    "comes from the dark net's final lab, which nothing in this repo automates - and without it " +
    "w0r1d_d43m0n cannot be reached. The daemon builds the node up; get The Red Pill through the dark net " +
    "yourself to end it."
  );
  await runGangDaemon(ns, forNode(15));
}
