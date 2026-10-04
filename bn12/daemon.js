// bn12/daemon.js
//
// BN12 ("The Recursion") orchestrator. The strategy is the shared
// lib/gang-daemon.js; what the node owns is BITNODE[12] in lib/config.js.
//
// BN12 is the one node you repeat without limit: Source-File 12 has no level
// cap, and each level is one free NeuroFlux Governor level at the start of every
// BitNode from then on. The price is that the node gets worse each time. Verified
// against bitburner-src (dev) BitNode.tsx on 2026-10-03, with inc = 1.02^level
// and dec = 1/inc (level = the SF12 level this run awards):
//
//   every stat level, every income, every exp and rep gain   x dec
//   ServerMaxMoney                                            x dec^2
//   aug money and rep cost, home RAM cost, cloud server cost  x inc
//   WorldDaemonDifficulty                                     x inc
//   DaedalusAugsRequirement                                   30 + inc, capped at 40
//   GangSoftcap 0.8, CorporationSoftcap 0.8                   flat, whatever the level
//
// At level 1 that is 2% off everything - a plain node. At level 35 everything is
// halved and server money quartered. So no tuning table can be right for every
// level, and none is attempted: the one fixed choice is the engine. The gang is
// softcapped by a constant here, not by level, and it sells most augmentations
// without faction reputation - which is what the climbing Daedalus requirement
// needs. Everything else (hacking, the corporation with SF3.3, sleeves, IPvGO)
// runs as it does anywhere, degrading with the level.
//
// How many levels to collect is the campaign's call ([12, n] in
// `campaign.order`, lib/config.js): BN12 is the one step whose target is not
// capped at 3. Without it on the campaign this node finishes once and moves on.
// Never run live as of writing.

import { forNode } from "../lib/config.js";
import { runGangDaemon } from "../lib/gang-daemon.js";

/** @param {NS} ns */
export async function main(ns) {
  await runGangDaemon(ns, forNode(12));
}
