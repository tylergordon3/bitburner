// bn3/daemon.js
//
// BN3 ("Corporatocracy") orchestrator. The shared skeleton is lib/daemon-core.js
// (runDaemon + decideAugFlow); the corporation that defines this node is the
// shared lib/corp-daemon.js machinery the core already runs every tick (creation
// via lib/corp-create.js, corp-steady on the reserved cloud-corp host, the four
// build phases in rotation). So this file is nearly the BN4 loop.
//
// Gangs still feature, but unlike BN2 there's no early-gang shortcut: forming
// one needs -54,000 karma (SF2 lets us do it here at all). We don't grind crime
// toward that; instead crime we already do while saving for augs trends karma
// down, and the moment it crosses the gate we snap up a gang for free. Both the
// corp and the gang PERSIST through augmentation installs, so their managers
// simply resume after each reset.

import {
  doEarlyBootstrapIfNeeded,
  maybeCreatePrograms,
  maybeAutoTravelForReadyFaction,
} from "../lib/player-actions.js";
import { getNextAugTarget } from "../lib/aug-targets.js";
import { forNode } from "../lib/config.js";
import { maybeBuyInfra, inGangSafe } from "../lib/daemon-lib.js";
import { runDaemon, decidePrelude, decideNoTarget, decideAugFlow } from "../lib/daemon-core.js";

// Every tunable value comes from lib/config.js, resolved for BitNode 3. BN3 has
// no gang shortcut, so gang.karma keeps CONFIG's universal -54,000 gate.
const CFG = forNode(3);
const GANG = CFG.gang;
const SELF = CFG.paths.daemon;                // this daemon's path (post-reset callback)

// Criminal factions that can found a gang; whichever we're already in is used.
// Cast to any[] so its elements don't trip checkJs against FactionName (a plain
// `string` isn't assignable to the union) - see [[bitburner-enum-string-casts]].
const CRIMINAL_FACTIONS = /** @type {any[]} */ (GANG.criminalFactions);

/**
 * Found a gang the moment we're eligible: karma past the -54k gate AND already a
 * member of a criminal faction. Needs no player attention, so it runs from the
 * core's setupGang hook (before the managers are placed) rather than inside the
 * decision. Returns a status object while there's something to report.
 * @param {NS} ns
 */
function maybeSetupGang(ns) {
  if (inGangSafe(ns)) return null;

  const player = ns.getPlayer();
  if ((player.karma ?? 0) > GANG.karma) return null; // not eligible yet

  const joined = player.factions ?? [];
  const faction = CRIMINAL_FACTIONS.find(f => joined.includes(f));
  if (faction) {
    if (ns.gang.createGang(/** @type {any} */ (faction))) {
      ns.tprint(`Created gang with ${faction}!`);
      return { action: "Gang Created", detail: faction };
    }
  }

  return { action: "Gang (karma ready)", detail: "Awaiting a criminal faction invite" };
}

/** @param {NS} ns */
async function decideNextPriority(ns) {
  const opportunities = decidePrelude(ns);

  const autoTravel = await maybeAutoTravelForReadyFaction(ns, opportunities);
  if (autoTravel) return { ...autoTravel, target: null, infra: null };

  const bootstrap = await doEarlyBootstrapIfNeeded(ns);
  if (bootstrap) return { ...bootstrap, target: null, infra: null };

  const programWork = await maybeCreatePrograms(ns);
  if (programWork) return { ...programWork, target: getNextAugTarget(ns), infra: null };

  const target = getNextAugTarget(ns);
  const infra = await maybeBuyInfra(ns, target);

  if (!target) return decideNoTarget(ns, { opportunities, infra });
  return decideAugFlow(ns, { cfg: CFG, target, infra, opportunities, incomeLabel: "Corp/hacking income" });
}

/** @param {NS} ns */
export async function main(ns) {
  await runDaemon(ns, {
    cfg: CFG,
    self: SELF,
    setupGang: maybeSetupGang,
    decide: decideNextPriority,
    statusLine: ns => ` | Karma: ${(ns.getPlayer().karma ?? 0).toFixed(0)}`,
  });
}
