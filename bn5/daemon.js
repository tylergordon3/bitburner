// bn5/daemon.js
//
// BN5 ("Artificial Intelligence") orchestrator. The shared skeleton is
// lib/daemon-core.js (runDaemon + decideAugFlow); what this file owns is BN5's
// strategy, tuned around its multipliers:
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
// a GANG online as fast as possible. There's no -9 karma shortcut (that's BN2);
// forming one needs -54,000 karma (SF2 lets us do it here at all). Unlike BN3 -
// which never grinds toward that gate and just snaps a gang up if crime-for-money
// happens to cross it - BN5 turns on gang.activeKarmaGrind (see BITNODE[5] in
// lib/config.js): after the early bootstrap, committing crime toward -54k karma
// is THE player-focus priority. Crime does triple duty - karma toward the gate,
// combat stats that unlock criminal factions (and their augs), and money
// (CrimeMoney 0.5 still beats ScriptHackMoney 0.15). Aug buying and installs run
// every tick regardless (runDaemon), and karma PERSISTS through installs, so the
// grind never loses ground across resets. Once the gang exists it becomes the
// primary income + passive faction rep, and we revert to the ordinary aug flow.
//
// The corporation runs alongside the gang (the core's shared corp machinery):
// weaker here, but self-funded and affordability-gated so it never stalls the
// gang/aug grind. Flip corp.enabled off in BITNODE[5] to opt back out.

import {
  trainCombatIfNeeded,
  commitBestCrimeIfUseful,
  doEarlyBootstrapIfNeeded,
  maybeCreatePrograms,
  maybeAutoTravelForReadyFaction,
} from "../lib/player-actions.js";
import { getNextAugTarget } from "../lib/aug-targets.js";
import { forNode } from "../lib/config.js";
import { maybeBuyInfra, inGangSafe, nextBNOverride } from "../lib/daemon-lib.js";
import { runDaemon, decidePrelude, decideNoTarget, decideAugFlow } from "../lib/daemon-core.js";

// Every tunable value comes from lib/config.js, resolved for BitNode 5 - that's
// where BN5's active-karma-grind flag lives (BITNODE[5].gang.activeKarmaGrind).
const CFG = forNode(5);
const GANG = CFG.gang;
const FACTION_REQUIREMENTS = CFG.factions.requirements;
const SELF = CFG.paths.daemon;                // this daemon's path (post-reset callback)

// ── Gang (universal -54k karma gate, actively ground toward) ──────────────────
const GANG_KARMA = GANG.karma;                // -54,000 in BN5 (CONFIG default)
const ACTIVE_KARMA_GRIND = GANG.activeKarmaGrind;
// Criminal factions that can found a gang; whichever we're already in (by this
// preference order) gets used. Cast to any[] so its elements don't trip checkJs
// against FactionName - see [[bitburner-enum-string-casts]].
const CRIMINAL_FACTIONS = /** @type {any[]} */ (GANG.criminalFactions);
// The earliest/cheapest criminal faction (30 combat) - used only for the combat
// requirements we train toward while bootstrapping the gang. Crime itself does
// most of the combat building; this is a cheap belt-and-braces call.
const GANG_TRAIN_REQS = FACTION_REQUIREMENTS["Slum Snakes"] ?? {};

/**
 * The BitNode to enter when lib/finish-bn.js destroys w0r1d_d43m0n - encoding the
 * "run BN5.1, then BN5.2, then stop" plan (see [[bitnode-progress]]):
 *   - BN5 with SF-5 level 0 (this is 5.1): re-enter BN5 (return 5) to do 5.2.
 *   - BN5 with SF-5 level >= 1 (5.2 done, or beyond): return 0, the halt sentinel
 *     ensureBackdoorHelpers reads as "backdoor everything but DON'T auto-destroy" - the
 *     player then destroys w0r1d_d43m0n manually and picks the next node (BN10).
 * An explicit daemon arg ([0]) always overrides.
 * @param {NS} ns
 */
function plannedNextBN(ns) {
  const override = nextBNOverride(ns);
  if (override != null) return override;

  const info = ns.getResetInfo();
  if (info.currentNode !== 5) return CFG.backdoor.defaultNextBN;

  const sf5 = info.ownedSF.get(5) ?? 0;
  return sf5 < 1 ? 5 : 0; // 5.1 -> re-enter BN5; 5.2+ -> halt for manual selection
}

// ── Gang bootstrap ────────────────────────────────────────────────────────────

/**
 * Drive the gang bootstrap. Returns a status object while there's still player
 * work to do toward founding the gang, null once we're in a gang (or when the
 * active grind is disabled and we're not yet eligible - the caller then handles
 * the ordinary aug/faction flow, and crime-for-money there still trends karma
 * down so a gang eventually becomes foundable). Called from decideNextPriority
 * rather than the core's setupGang hook because it USES the player's work slot.
 * @param {NS} ns
 */
async function maybeSetupGang(ns) {
  if (inGangSafe(ns)) {
    globalThis.gordGangBootstrap = null;
    return null;
  }

  const player = ns.getPlayer();
  const karma = player.karma ?? 0;
  const joined = player.factions ?? [];

  // Eligible? Past the -54k gate AND already a member of a criminal faction ->
  // found the gang now (acceptInvites joins the criminal factions along the way).
  const eligibleFaction = karma <= GANG_KARMA
    ? CRIMINAL_FACTIONS.find(f => joined.includes(f))
    : null;

  // Publish bootstrap progress for the dashboard (ui/bn5.js) even when we don't
  // take an action this tick, so the karma-toward-gate card stays live.
  globalThis.gordGangBootstrap = {
    karma,
    target: GANG_KARMA,
    inCriminalFaction: CRIMINAL_FACTIONS.some(f => joined.includes(f)),
  };

  if (eligibleFaction) {
    if (ns.gang.createGang(/** @type {any} */ (eligibleFaction))) {
      ns.tprint(`Created gang with ${eligibleFaction}! (karma ${karma.toFixed(0)})`);
      globalThis.gordGangBootstrap = null;
      return { action: "Gang Created", detail: eligibleFaction };
    }
    return { action: "Gang", detail: `createGang(${eligibleFaction}) failed - retrying` };
  }

  // Not eligible yet. Only actively grind if this node opts in; otherwise leave
  // the gang to be snapped up passively by the normal crime-for-money flow.
  if (!ACTIVE_KARMA_GRIND) return null;

  // 1. Build combat toward the first criminal faction's gate (Slum Snakes, 30).
  //    Mostly redundant - crime below builds combat too - but cheap and safe.
  const training = await trainCombatIfNeeded(ns, GANG_TRAIN_REQS);
  if (training) {
    return { ...training, detail: `${training.detail} (toward gang)` };
  }

  // 2. Grind karma via the best available crime. This is the crux of the BN5
  //    strategy: crime earns karma + combat + money at once. Ranked by KARMA per
  //    ms here rather than money (homicide is 3.0 a hit against mug's 0.25, so it
  //    takes the lead far earlier than a money ranking would give it).
  const crime = await commitBestCrimeIfUseful(ns, `karma ${karma.toFixed(0)}/${GANG_KARMA} -> gang`, { metric: "karma" });
  if (crime) return crime;

  // Post-bootstrap this shouldn't happen (mug chance is already high), but guard
  // it so a bad combat run reports clearly instead of silently stalling.
  return { action: "Gang Blocked", detail: "Crime chance too low - crime will raise combat stats" };
}

// ── Strategy ─────────────────────────────────────────────────────────────────

/** @param {NS} ns */
async function decideNextPriority(ns) {
  const opportunities = decidePrelude(ns);

  const autoTravel = await maybeAutoTravelForReadyFaction(ns, opportunities);
  if (autoTravel) return { ...autoTravel, target: null, infra: null };

  // Early bootstrap (study to hack 50, then mug for TOR/BruteSSH money).
  const bootstrap = await doEarlyBootstrapIfNeeded(ns);
  if (bootstrap) return { ...bootstrap, target: null, infra: null };

  const target = getNextAugTarget(ns);
  const infra = await maybeBuyInfra(ns, target);

  // Gang bootstrap - THE priority in BN5. Runs BEFORE program creation so we
  // crime toward -54k karma (which also builds combat + money) instead of
  // studying for hacking programs (weak here; port openers come via darkweb off
  // crime money anyway). Infra keeps flowing so the botnet still grows; buyAugs
  // + maybeInstall in the core keep snapping up augs on the rep we passively hold.
  const gangSetup = await maybeSetupGang(ns);
  if (gangSetup) return { ...gangSetup, target, infra };

  // Program creation (port openers still matter for worker RAM; relevant once
  // we're in a gang and no longer criming, or when the grind is disabled).
  const programWork = await maybeCreatePrograms(ns);
  if (programWork) return { ...programWork, target, infra: null };

  if (!target) return decideNoTarget(ns, { opportunities, infra });
  return decideAugFlow(ns, { cfg: CFG, target, infra, opportunities, incomeLabel: "Gang/hacking income" });
}

/** @param {NS} ns */
export async function main(ns) {
  await runDaemon(ns, {
    cfg: CFG,
    self: SELF,
    plannedNextBN,
    decide: decideNextPriority,
    statusLine: ns => ` | Karma: ${(ns.getPlayer().karma ?? 0).toFixed(0)}/${GANG_KARMA}`,
  });
}
