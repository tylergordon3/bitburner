// bn2/daemon.js
//
// BN2 ("Rise of the Underworld") orchestrator. The shared skeleton is
// lib/daemon-core.js (runDaemon + decideAugFlow); what BN2 adds is its gang
// shortcut: a gang can be created as soon as we can join a criminal faction (no
// -54k karma gate), and the gang faction sells nearly every augmentation in the
// game while its rep accrues passively from gang respect. So the top priority
// after the early bootstrap is: train combat to 30s -> crime to -9 karma + $1M ->
// join Slum Snakes -> createGang, then hand day-to-day gang management to
// /lib/gang.js (placed by the core on its reserved cloud host).

import {
  trainCombatIfNeeded,
  commitBestCrimeIfUseful,
  doEarlyBootstrapIfNeeded,
  maybeCreatePrograms,
  maybeAutoTravelForReadyFaction,
} from "../lib/player-actions.js";
import { getNextAugTarget } from "../lib/aug-targets.js";
import { forNode } from "../lib/config.js";
import { maybeBuyInfra } from "../lib/daemon-lib.js";
import { runDaemon, decidePrelude, decideNoTarget, decideAugFlow } from "../lib/daemon-core.js";

// Every tunable value comes from lib/config.js, resolved for BitNode 2 - that's
// where BN2's gang shortcut (-9 karma instead of -54,000, Slum Snakes, $1M join
// money) is declared, in BITNODE[2].
const CFG = forNode(2);
const GANG = CFG.gang;
const FACTION_REQUIREMENTS = CFG.factions.requirements;
const SELF = CFG.paths.daemon;                // this daemon's path (post-reset callback)

// Gang bootstrap targets (Slum Snakes join requirements).
// Cast once here rather than at each call site: config values widen to `string`,
// which checkJs won't accept for FactionName - including
// player.factions.includes(), since that array is FactionName[].
// See [[bitburner-enum-string-casts]].
const GANG_FACTION = /** @type {any} */ (GANG.faction);
const GANG_KARMA = GANG.karma;
const GANG_JOIN_MONEY = GANG.joinMoney;

// ── Gang ─────────────────────────────────────────────────────────────────────

/**
 * Drive the gang bootstrap until createGang succeeds. Returns a status object
 * while there's still player work to do, null once we're in a gang (or when
 * nothing needs player attention this tick). Called from decideNextPriority
 * rather than the core's setupGang hook because it USES the player's work slot
 * (gym, crime) and has to order against the other work that does.
 * @param {NS} ns
 */
async function maybeSetupGang(ns) {
  if (ns.gang.inGang()) return null;

  const player = ns.getPlayer();

  // Already in the faction - just create the gang (BN2 has no karma gate on
  // creation beyond the faction's own join requirements).
  if ((player.factions ?? []).includes(GANG_FACTION)) {
    if (ns.gang.createGang(/** @type {any} */ (GANG_FACTION))) {
      ns.tprint(`Created gang with ${GANG_FACTION}!`);
      return { action: "Gang Created", detail: GANG_FACTION };
    }
    return { action: "Gang", detail: `createGang(${GANG_FACTION}) failed - retrying` };
  }

  // 1. Combat stats (30 each for Slum Snakes)
  const training = await trainCombatIfNeeded(ns, FACTION_REQUIREMENTS[GANG_FACTION]);
  if (training) {
    return { ...training, detail: `${training.detail} (for ${GANG_FACTION} gang)` };
  }

  // 2. Karma (crime also earns the $1M join money along the way)
  const karma = player.karma ?? 0;
  if (karma > GANG_KARMA) {
    // Ranked by KARMA per ms, not money: karma is the gate we're grinding here.
    const crime = await commitBestCrimeIfUseful(ns, `karma ${karma.toFixed(1)}/${GANG_KARMA}`, { metric: "karma" });
    if (crime) return crime;
    return { action: "Gang Blocked", detail: "Crime chance too low for karma grind" };
  }

  // 3. Join money
  const moneyMissing = Math.max(0, GANG_JOIN_MONEY - player.money);
  if (moneyMissing > 0) {
    const crime = await commitBestCrimeIfUseful(ns, `$${ns.format.number(moneyMissing)} to join ${GANG_FACTION}`);
    if (crime) return crime;
    return { action: "Saving for Gang", detail: `Need $${ns.format.number(moneyMissing)} for ${GANG_FACTION}` };
  }

  // Requirements met - acceptInvites picks up the invite next tick.
  return { action: "Awaiting Invite", detail: `${GANG_FACTION} (requirements met)` };
}

// ── Strategy ─────────────────────────────────────────────────────────────────

/** @param {NS} ns */
async function decideNextPriority(ns) {
  const opportunities = decidePrelude(ns);

  const autoTravel = await maybeAutoTravelForReadyFaction(ns, opportunities);
  if (autoTravel) return { ...autoTravel, target: null, infra: null };

  // Early bootstrap (study to hack 50, mug for TOR/BruteSSH money)
  const bootstrap = await doEarlyBootstrapIfNeeded(ns);
  if (bootstrap) return { ...bootstrap, target: null, infra: null };

  // Gang setup - THE priority in BN2. No infra spending while this runs so
  // crime money accumulates toward the $1M Slum Snakes join requirement.
  const gangSetup = await maybeSetupGang(ns);
  if (gangSetup) return { ...gangSetup, target: getNextAugTarget(ns), infra: null };

  // Program creation (port openers still matter for worker RAM)
  const programWork = await maybeCreatePrograms(ns);
  if (programWork) return { ...programWork, target: getNextAugTarget(ns), infra: null };

  const target = getNextAugTarget(ns);
  const infra = await maybeBuyInfra(ns, target);

  if (!target) return decideNoTarget(ns, { opportunities, infra });
  return decideAugFlow(ns, { cfg: CFG, target, infra, opportunities, incomeLabel: "Gang/hacking income" });
}

/** @param {NS} ns */
export async function main(ns) {
  await runDaemon(ns, {
    cfg: CFG,
    self: SELF,
    decide: decideNextPriority,
    // lib/econ.js keeps the gang-join money free while we're still bootstrapping.
    econArgs: [GANG_JOIN_MONEY],
    statusLine: ns => ` | Karma: ${(ns.getPlayer().karma ?? 0).toFixed(0)}`,
  });
}
