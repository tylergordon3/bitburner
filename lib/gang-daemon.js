// lib/gang-daemon.js
//
// The strategy shared by the nodes whose engine is a GANG - bn5, bn11, bn12 and
// bn15 are each a few lines on top of this, the way bn6/bn7/bn13/bn14 sit on
// lib/blade-daemon.js. The skeleton is lib/daemon-core.js (runDaemon +
// decideAugFlow); what this file owns is the gang bootstrap and where it sits in
// the order of the player's work slot.
//
// It began as bn5/daemon.js. A gang is the one income that most nodes leave
// alone (no GangSoftcap override in BN5, BN11 or BN15; a flat 0.8 in BN12
// whatever the level), it sells most of the game's augmentations without any
// faction reputation, and its benefits survive every aug install. Outside BN2
// there is no shortcut to one: forming it takes -54,000 karma (SF2 is what lets
// us do it at all). So where a node opts in (gang.activeKarmaGrind in its
// BITNODE entry), committing crime toward that gate is THE player-focus
// priority after the early bootstrap. Crime does triple duty - karma toward the
// gate, combat stats that unlock the criminal factions, and money - and eight
// sleeves on crime (lib/sleeves.js) do most of the karma. Aug buying and
// installs run every tick regardless (runDaemon), and karma PERSISTS through
// installs, so the grind never loses ground across resets. Once the gang exists
// it is the primary income and passive faction rep, and the slot reverts to the
// ordinary aug flow.
//
// With the grind off (the default) a gang is still snapped up the moment karma
// happens to cross the gate through crime-for-money - the node just never
// spends the slot getting there.
//
// The corporation runs alongside where the node leaves it enabled (the core's
// shared corp machinery): self-funded and affordability-gated, so it never
// stalls the gang/aug grind.

import {
  trainCombatIfNeeded,
  commitBestCrimeIfUseful,
  doEarlyBootstrapIfNeeded,
  maybeCreatePrograms,
  maybeAutoTravelForReadyFaction,
} from "./player-actions.js";
import { getNextAugTarget } from "./aug-targets.js";
import { maybeBuyInfra, inGangSafe } from "./daemon-lib.js";
import { runDaemon, decidePrelude, decideNoTarget, decideAugFlow } from "./daemon-core.js";
import { getCapabilities } from "./capabilities.js";

/**
 * Run a gang node's daemon. `cfg` is forNode(n); everything that differs between
 * the nodes is in lib/config.js. The next BitNode comes from the shared plan
 * (runDaemon's default: a daemon arg, else the campaign order).
 * @param {NS} ns @param {any} cfg
 */
export async function runGangDaemon(ns, cfg) {
  const GANG = cfg.gang;
  const GANG_KARMA = GANG.karma;                // -54,000 outside BN2
  // Criminal factions that can found a gang; whichever we're already in (by this
  // preference order) gets used. Cast to any[] so its elements don't trip checkJs
  // against FactionName - see [[bitburner-enum-string-casts]].
  const CRIMINAL_FACTIONS = /** @type {any[]} */ (GANG.criminalFactions);
  // The earliest/cheapest criminal faction (30 combat) - used only for the combat
  // requirements we train toward while bootstrapping the gang. Crime itself does
  // most of the combat building; this is a cheap belt-and-braces call.
  const GANG_TRAIN_REQS = cfg.factions.requirements["Slum Snakes"] ?? {};
  // No gang API (neither BN2 nor Source-File 2): createGang can never succeed,
  // so the karma grind below would hold the work slot for the whole node.
  const canGang = getCapabilities(ns).gang;

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
    if (!canGang || inGangSafe(ns)) {
      globalThis.gordGangBootstrap = null;
      return null;
    }

    const player = ns.getPlayer();
    const karma = player.karma ?? 0;
    const joined = player.factions ?? [];

    // Eligible? Past the karma gate AND already a member of a criminal faction ->
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
      // The game refused (it logs why and does not throw). Retried next tick;
      // meanwhile the slot goes to the ordinary flow rather than to nothing.
      ns.print(`WARN: createGang(${eligibleFaction}) failed - retrying next tick.`);
      return null;
    }

    // Not eligible yet. Only actively grind if this node opts in; otherwise leave
    // the gang to be snapped up passively by the normal crime-for-money flow.
    if (!GANG.activeKarmaGrind) return null;

    // 1. Build combat toward the first criminal faction's gate (Slum Snakes, 30).
    //    Mostly redundant - crime below builds combat too - but cheap and safe.
    const training = await trainCombatIfNeeded(ns, GANG_TRAIN_REQS);
    if (training) {
      return { ...training, detail: `${training.detail} (toward gang)` };
    }

    // 2. Grind karma via the best available crime: karma + combat + money at
    //    once. Ranked by KARMA per ms here rather than money (homicide is 3.0 a
    //    hit against mug's 0.25, so it takes the lead far earlier than a money
    //    ranking would give it).
    const crime = await commitBestCrimeIfUseful(ns, `karma ${karma.toFixed(0)}/${GANG_KARMA} -> gang`, { metric: "karma" });
    if (crime) return crime;

    // No crime clears its success floor (post-bootstrap this shouldn't happen -
    // mug chance is already high). Nothing was started, so returning a status
    // here would leave the slot on whatever it held, every tick, with nothing
    // raising the stats that would unblock it. Hand the tick to the ordinary
    // flow instead: its faction work, gym and crime-for-money all move it on.
    return null;
  }

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

    // Gang bootstrap - THE priority where the node opts in. Runs BEFORE program
    // creation so we crime toward the karma gate (which also builds combat +
    // money) instead of studying for hacking programs (port openers come via the
    // darkweb off crime money anyway). Infra keeps flowing so the botnet still
    // grows; buyAugs + maybeInstall in the core keep snapping up augs on the rep
    // we passively hold.
    const gangSetup = await maybeSetupGang(ns);
    if (gangSetup) return { ...gangSetup, target, infra };

    // Program creation (port openers still matter for worker RAM; relevant once
    // we're in a gang and no longer criming, or when the grind is disabled).
    const programWork = await maybeCreatePrograms(ns);
    if (programWork) return { ...programWork, target, infra: null };

    if (!target) return decideNoTarget(ns, { opportunities, infra });
    return decideAugFlow(ns, { cfg, target, infra, opportunities, incomeLabel: "Gang/hacking income" });
  }

  await runDaemon(ns, {
    cfg,
    self: cfg.paths.daemon,
    decide: decideNextPriority,
    statusLine: ns => ` | Karma: ${(ns.getPlayer().karma ?? 0).toFixed(0)}/${GANG_KARMA}`,
  });
}
