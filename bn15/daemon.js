// bn15/daemon.js
//
// BN15 ("The Secrets of the Dark Net") orchestrator. The strategy is the shared
// lib/blade-daemon.js (or lib/gang-daemon.js with Bladeburner switched off);
// what the node owns is BITNODE[15] in lib/config.js.
// Verified against bitburner-src (dev) BitNode.tsx on 2026-10-03:
//
//   HackingLevelMultiplier 0.6, HackingSpeedMultiplier 0.6
//   combat stats 0.7, charisma 1.1
//   ServerMaxMoney 0.8, ServerStartingMoney 0.5   script hack money untouched
//   AugmentationMoneyCost 3, DaedalusAugsRequirement 20
//   GangUniqueAugs 0.3                            the gang sells far fewer augs
//   CorporationValuation 0.2
//   BladeburnerRank 0.2, BladeburnerSkillCost 3   slow, but the only finish (below)
//   WorldDaemonDifficulty 2                       hacking 6000 to finish
//
// WHAT THIS DAEMON DOES NOT DO: the node's own mechanic - and so it cannot
// finish the node THE HACKING WAY. BN15 enlarges the dark net (ns.dnet), whose caches pay money
// and experience and whose final lab hands out The Red Pill. Here that lab is
// the ONLY source of it: in BN15 Daedalus does not sell The Red Pill
// (bitburner-src Faction/FactionHelpers.tsx getFactionAugmentationsFiltered,
// "Remove TRP from daedalus in BN15"). Without it installed w0r1d_d43m0n has no
// network connection, and the game treats a server with none as nonexistent -
// every ns call on it throws "Invalid host" (Netscript/NetscriptHelpers
// getServer) - so it can never be rooted, lib/backdoor.js never reports it
// ready, and destroyW0r1dD43m0n's hacking requirement is never met whatever the
// hacking level.
//
// The black ops are the other finish, and they need no Red Pill:
// destroyW0r1dD43m0n accepts every black op done in place of the hacking
// requirement (NetscriptFunctions/Singularity.ts bladeburnerRequirements), and
// Bladeburner is open here with SF6/SF7. It is slow - BladeburnerRank 0.2,
// skills at triple cost - but it ends the node with no dark net code, and since
// nothing here calls dnet.heartbleed, that finish also earns CHALLENGE_BN15. So:
// with BITNODE[15].bladeburner.enabled this daemon is the Bladeburner engine
// (lib/blade-daemon.js, as BN13/BN14), which finishes through lib/finish-bn.js
// "blade" mode. Without it, it is the plain build-up below.
//
// The plain way: hacking for money (it still pays here), a gang for the rest,
// the ordinary faction ladder (Daedalus wants only 20 augmentations) - and
// build up indefinitely. Ending it then takes the dark net lab, by hand or by a
// script that does not exist yet.
//
// Its Source-File (TOR and the full dark web from the start of every node, and
// the dark net labs everywhere) pays off most once there IS dark net
// automation. Never run live as of writing.

import { forNode } from "../lib/config.js";
import { runGangDaemon } from "../lib/gang-daemon.js";
import { runBladeDaemon } from "../lib/blade-daemon.js";

/** @param {NS} ns */
export async function main(ns) {
  const cfg = forNode(15);
  if (cfg.bladeburner.enabled) {
    await runBladeDaemon(ns, cfg);
    return;
  }
  ns.tprint(
    "WARN: bn15/daemon.js cannot finish BitNode 15 this way. Daedalus does not sell The Red Pill here - it only " +
    "comes from the dark net's labs, which nothing in this repo automates - and without it " +
    "w0r1d_d43m0n cannot be reached. Turn BITNODE[15].bladeburner.enabled on to finish through the black ops, " +
    "or get The Red Pill through the dark net yourself."
  );
  await runGangDaemon(ns, cfg);
}
