// bn5/daemon.js
//
// BN5 ("Artificial Intelligence") orchestrator. The strategy is the shared
// lib/gang-daemon.js (this file is where it was first written); what the node
// owns is BITNODE[5] in lib/config.js, tuned around its multipliers:
//
//   ScriptHackMoney       0.15   hacking earns 15% of normal
//   ServerStartingSecurity 2     servers start at 2x security (slow early hacks)
//   ServerStartingMoney    0.5   servers start with half their money
//   HackExpGain            0.5   hacking levels up half as fast
//   CrimeMoney             0.5   crime money halved (still >> hacking)
//   HacknetNodeMoney       0.2   hacknet gutted
//   CorporationValuation/Divisions 0.75   corps reduced
//   (no GangSoftcap override)    GANG INCOME IS UN-SOFTCAPPED
//
// The takeaway: hacking is a weak early engine here and a corp is a poor
// investment, but a gang is as strong as ever. So BN5's defining move is to get
// a GANG online as fast as possible - gang.activeKarmaGrind is on, and crime
// toward -54,000 karma is the player's priority after the early bootstrap
// (CrimeMoney 0.5 still beats ScriptHackMoney 0.15).
//
// The corporation runs alongside the gang: weaker here, but self-funded and
// affordability-gated so it never stalls the gang/aug grind. Flip corp.enabled
// off in BITNODE[5] to opt back out.
//
// Next BitNode: the shared plan (a daemon arg, else `campaign.order` in
// lib/config.js). BN5 used to re-enter itself for 5.2 and then halt; to collect
// more SF5 levels now, put [5, n] on the campaign.

import { forNode } from "../lib/config.js";
import { runGangDaemon } from "../lib/gang-daemon.js";

/** @param {NS} ns */
export async function main(ns) {
  await runGangDaemon(ns, forNode(5));
}
