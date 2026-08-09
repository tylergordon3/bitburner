// bn5/daemon.js
//
// BN5 ("Artificial Intelligence") orchestrator. Same skeleton as the other
// per-node daemons (root the net, run the hacking botnet + helpers off-home,
// grind augs/factions, install, finish), tuned around BN5's multipliers:
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
// every tick regardless (see main), and karma PERSISTS through installs, so the
// grind never loses ground across resets. Once the gang exists it becomes the
// primary income + passive faction rep, and we revert to the ordinary aug flow.
//
// Corporation runs alongside the gang: the gang is still the primary engine here
// (BN5's corp nerf makes a corp a weaker trade), but with corp API access
// everywhere the corp is now built too, self-funded and affordability-gated so it
// never stalls the gang/aug grind. The shared machinery lives in
// lib/corp-daemon.js; flip corp.enabled off in BITNODE[5] to opt back out.

import {
  trainCombatIfNeeded,
  commitBestCrimeIfUseful,
  shouldFocus,
  doEarlyBootstrapIfNeeded,
  maybeCreatePrograms,
  maybePursueNextFaction,
  maybeAutoTravelForReadyFaction,
  estimateIncomeRate,
  updateRepRate,
  doIdleWork,
} from "../lib/player-actions.js";
import {
  getNextAugTarget,
  getAllAugCandidates,
  getUnjoinedFactionOpportunities,
} from "../lib/aug-targets.js";
import { forNode } from "../lib/config.js";
// Shared daemon core - see lib/daemon-lib.js for what is shared and what each
// daemon still owns.
import {
  playerMoney,
  hackingLevel,
  ensureHelper,
  ensureBackdoorHelpers,
  ensureGangManager,
  inGangSafe,
  gangFactionName,
  buyAugs,
  maybeInstall,
  maybeBuyInfra,
  startBestFactionWork,
  maybeDoSecondaryFactionWork,
  buyDarkweb,
  rootEverything,
  acceptInvites,
  readLastResetTime,
  writeResetTime,
  consumeResetSummary,
} from "../lib/daemon-lib.js";
// Shared corporation orchestration (all corp-viable nodes) - see lib/corp-daemon.js.
import { maybeSetupCorp, ensureCorpManagers } from "../lib/corp-daemon.js";

// Every tunable value comes from lib/config.js, resolved for BitNode 5 - that's
// where BN5's active-karma-grind flag lives (BITNODE[5].gang.activeKarmaGrind).
const CFG = forNode(5);
const AUGS = CFG.augs;
const GANG = CFG.gang;
const FACTION_REQUIREMENTS = CFG.factions.requirements;

// Off-home helper scripts (shared by every daemon) that keep this daemon's HOME
// footprint small: each carries the expensive Singularity/Hacknet calls it needs,
// and running them off-home means those never count against the daemon's RAM.
const ECON_SCRIPT = CFG.paths.econ;           // hacknet + home-RAM spending
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
 * An explicit daemon arg ([0]) always overrides. getResetInfo() is free (0GB).
 * @param {NS} ns
 */
function plannedNextBN(ns) {
  if (ns.args[0] != null) return Number(ns.args[0]);

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
 * down so a gang eventually becomes foundable).
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

// ── Augs / install / infra (same policy as the other daemons) ─────────────────

/** @param {NS} ns */
async function decideNextPriority(ns) {
  estimateIncomeRate(ns);
  const currentTarget = globalThis.gordState?.target;
  if (currentTarget?.faction) updateRepRate(ns, currentTarget.faction);

  const opportunities = getUnjoinedFactionOpportunities(ns);
  globalThis.gordFactionPipeline = opportunities;

  const autoTravel = await maybeAutoTravelForReadyFaction(ns, opportunities);
  if (autoTravel) {
    return { ...autoTravel, target: null, infra: null };
  }

  // Early bootstrap (study to hack 50, then mug for TOR/BruteSSH money).
  const bootstrap = await doEarlyBootstrapIfNeeded(ns);
  if (bootstrap) {
    return { ...bootstrap, target: null, infra: null };
  }

  const target = getNextAugTarget(ns);
  const infra  = await maybeBuyInfra(ns, target);

  // Gang bootstrap - THE priority in BN5. Runs BEFORE program creation so we
  // crime toward -54k karma (which also builds combat + money) instead of
  // studying for hacking programs (weak here; port openers come via darkweb off
  // crime money anyway). Infra keeps flowing so the botnet still grows; buyAugs
  // + maybeInstall in main() keep snapping up augs on the rep we passively hold.
  const gangSetup = await maybeSetupGang(ns);
  if (gangSetup) {
    return { ...gangSetup, target, infra };
  }

  // Program creation (port openers still matter for worker RAM; relevant once
  // we're in a gang and no longer criming, or when the grind is disabled).
  const programWork = await maybeCreatePrograms(ns);
  if (programWork) {
    return { ...programWork, target, infra: null };
  }

  // No aug target
  if (!target) {
    const factionPursuit = await maybePursueNextFaction(ns, opportunities, true);
    if (factionPursuit) {
      const moneyGoal = factionPursuit.joinMoneyMissing
        ? playerMoney(ns) + factionPursuit.joinMoneyMissing
        : 0;
      const idle = await doIdleWork(ns, moneyGoal);
      return { ...factionPursuit, ...idle, target: null, infra };
    }

    const idle = await doIdleWork(ns);
    return { ...idle, target: null, infra };
  }

  // Combat-stat requirements for current faction
  const statTargets = FACTION_REQUIREMENTS[target.faction] ?? {};
  const training = await trainCombatIfNeeded(ns, statTargets);
  if (training) {
    return { ...training, target, infra };
  }

  // Rep still needed
  if (target.repMissing > 0) {
    // A gang faction's rep accrues passively from respect - workForFaction
    // doesn't apply, so spend player attention elsewhere.
    if (target.faction === gangFactionName(ns)) {
      const secondary = maybeDoSecondaryFactionWork(ns, target.faction);
      const extra = secondary ?? (await doIdleWork(ns))?.detail;
      return {
        action: "Gang Rep (passive)",
        detail: `${target.faction} respect -> ${target.aug}${extra ? ` | ${extra}` : ""}`,
        target,
        infra,
      };
    }

    const workType = startBestFactionWork(ns, target.faction);
    return {
      action: "Faction Rep",
      detail: `${target.faction} (${workType ?? "none"}) -> ${target.aug}`,
      target,
      infra,
    };
  }

  // Rep done, money still needed
  if (target.moneyMissing > 0) {
    if (!shouldFocus(ns)) {
      const factionHasMoreRepWork = (() => {
        if (target.faction === gangFactionName(ns)) return false;
        const s = ns.singularity;
        const owned = new Set(s.getOwnedAugmentations(true));
        const currentRep = s.getFactionRep(/** @type {any} */ (target.faction));
        return s.getAugmentationsFromFaction(/** @type {any} */ (target.faction)).some(aug => {
          if (aug === AUGS.neuroFlux) return false;
          if (owned.has(aug)) return false;
          if (aug === target.aug) return false;
          return s.getAugmentationRepReq(aug) > currentRep;
        });
      })();

      const secondary = maybeDoSecondaryFactionWork(ns, target.faction);

      if (factionHasMoreRepWork) {
        const workType = startBestFactionWork(ns, target.faction);
        if (workType) {
          return {
            action: "Faction Work (banking rep)",
            detail: `${target.faction} (${workType}, no focus) | saving $${ns.format.number(target.moneyMissing)} for ${target.aug}${secondary ? ` | ${secondary}` : ""}`,
            target,
            infra,
          };
        }
      }

      if (secondary) {
        return {
          action: "Faction Work (secondary)",
          detail: `${secondary} | saving $${ns.format.number(target.moneyMissing)} for ${target.aug}`,
          target,
          infra,
        };
      }

      const factionPursuit = await maybePursueNextFaction(ns, opportunities, false);
      if (factionPursuit) {
        return {
          ...factionPursuit,
          detail: `${factionPursuit.detail} | saving $${ns.format.number(target.moneyMissing)} for ${target.aug}`,
          target,
          infra,
        };
      }

      return {
        action: "Saving",
        detail: `Gang/hacking income for $${ns.format.number(target.moneyMissing)} -> ${target.aug}`,
        target,
        infra,
      };
    }

    // Focus mode: crime is the best use of player attention in BN5 (money +
    // karma, which also keeps trending toward the gang gate if not yet reached).
    const crime = await commitBestCrimeIfUseful(ns, `$${ns.format.number(target.moneyMissing)} for ${target.aug}`);
    if (crime) {
      return { ...crime, target, infra };
    }

    return {
      action: "Saving",
      detail: `Gang/hacking income for $${ns.format.number(target.moneyMissing)} -> ${target.aug}`,
      target,
      infra,
    };
  }

  // Ready to buy
  return {
    action: "Ready to Purchase",
    detail: `${target.faction} -> ${target.aug}`,
    target,
    infra,
  };
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  if (readLastResetTime(ns) === 0) writeResetTime(ns);

  // If the previous run ended in an aug install, surface a one-time summary for
  // the journal. globalThis is wiped by the install, so this is read from disk
  // (and blanked) exactly once, here at boot.
  globalThis.gordLastReset = consumeResetSummary(ns);

  while (true) {
    // Root the network FIRST so the helpers below have off-home hosts to land
    // on, and buy port openers when affordable (crime funds these via darkweb).
    await acceptInvites(ns);
    await buyDarkweb(ns);
    rootEverything(ns);

    // Backdoors FIRST, ahead of every RAM-hungry helper below: CSEC/avmnite-02h/
    // I.I.I.I/run4theh111z unlock CyberSec, NiteSec, The Black Hand and BitRunners,
    // and the backdoor loop is only ~9GB now that the 32GB BitNode finisher is its
    // own script (lib/finish-bn.js, launched by this same call once the world daemon
    // is backdoored). Launched after the botnet it used to lose that race for RAM
    // and never install a single backdoor.
    ensureBackdoorHelpers(ns, plannedNextBN(ns));

    // Gang first: it reserves cloud-gang from the botnet before anything else goes
    // looking for off-home RAM, and lib/gang.js is ~36GB - big enough to lose every
    // race for a shared host. Then the hacking manager (our main income engine -
    // starts earning on any 16GB server, no port openers needed), then UI/luxury.
    const reserved = new Set();
    ensureGangManager(ns, reserved);
    globalThis.gordReservedHosts = reserved;

    // Corporation alongside the gang: keep the one-shot creator running until a
    // corp exists (self-funded + affordability-gated), then keep its managers on
    // the reserved cloud-corp host. ensureGangManager has just published
    // the gang reservation this tick; we add the corp host to that same fresh Set.
    const corpEvent = maybeSetupCorp(ns);
    ensureCorpManagers(ns, reserved);

    // Duplicate sleeves (BN10 or SF10). ~72GB of ns.sleeve.* calls, so it runs
    // off-home like the gang manager, and BEFORE the botnet so it can claim RAM
    // before workers fill the network. Optional: early on no host has room, and it
    // simply starts later. lib/sleeves.js self-exits where sleeves are unavailable,
    // and until we have a gang it points the whole roster at crime for KARMA -
    // sleeve karma counts for the player, so the roster is our fastest route to
    // founding one. After that each sleeve mirrors the player's own work.
    ensureHelper(ns, CFG.paths.sleeves, { optional: true });

    ensureHelper(ns, CFG.paths.manager);
    ensureHelper(ns, CFG.paths.dashboard);
    ensureHelper(ns, CFG.paths.stocks, { optional: true });

    // Coding-contract solver (universal across all nodes): solves .cct files
    // network-wide for money/rep/karma, skipping unknown types. Off-home + optional
    // (waits quietly for RAM), since contracts are rare and non-urgent.
    ensureHelper(ns, CFG.paths.contracts, { optional: true });

    // Hacknet/home-RAM spending, off-home (hacknet is weak in BN5 but econ.js also
    // buys home RAM, which stays valuable). The backdoor helpers went up first,
    // before the botnet claimed the network's RAM.
    ensureHelper(ns, ECON_SCRIPT, { optional: true });

    globalThis.gordState = await decideNextPriority(ns);
    if (corpEvent) globalThis.gordState = { ...globalThis.gordState, ...corpEvent };

    const bought = buyAugs(ns);
    if (bought?.length) {
      globalThis.gordState.purchases = bought;
    }

    globalThis.gordAugPipeline = getAllAugCandidates(ns).slice(0, AUGS.pipelineSize);

    maybeInstall(ns, SELF);

    ns.print(
      `Money: ${ns.format.number(playerMoney(ns))} | Hack: ${hackingLevel(ns)} | Karma: ${(ns.getPlayer().karma ?? 0).toFixed(0)}/${GANG_KARMA}`
    );
    await ns.sleep(CFG.daemon.tickMs);
  }
}
