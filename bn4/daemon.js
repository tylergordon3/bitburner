// bn4/daemon.js
//
// BN4 ("The Singularity") orchestrator - and the REFERENCE implementation of the
// shared per-node daemon skeleton that bn2/bn3/bn5/bn10 each specialise. BN4 has no
// punishing multiplier overrides and no node-specific mechanic to chase, so it's
// the plain loop the others are built from: accept invites, root the network, run
// the HGW botnet plus the off-home helpers (backdoor, econ, dashboard, stocks,
// contracts), grind toward the next augmentation/faction, install in batches, and
// let lib/backdoor.js finish the node and enter the next one.
//
// Everything reusable lives in lib/, so this file holds only BN4's own decision
// logic (decideNextPriority) and the main() wiring; buying augs, the install policy,
// the server budget, faction work and helper placement all come from
// lib/daemon-lib.js. The other daemons are this plus their node's special system:
// gang in BN2, corp seed in BN3, karma-gang grind in BN5, and buying sleeves +
// grafting in BN10 - which is why BN4 is the shortest of the five.

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

// Every tunable value comes from lib/config.js, resolved for this BitNode (see
// BITNODE there for the per-node overrides).
const CFG = forNode(4);
const AUGS = CFG.augs;
const FACTION_REQUIREMENTS = CFG.factions.requirements;

// Off-home helper scripts (shared by every daemon) that keep this daemon's HOME
// footprint small: each carries the expensive Singularity/Hacknet calls it needs,
// and running them off-home means those never count against the daemon's RAM.
const ECON_SCRIPT = CFG.paths.econ;           // hacknet + home-RAM spending
const SELF = CFG.paths.daemon;                // this daemon's path (post-reset callback)

/** @param {NS} ns */
async function decideNextPriority(ns) {
  // Update rolling rate snapshots
  estimateIncomeRate(ns);
  const currentTarget = globalThis.gordState?.target;
  if (currentTarget?.faction) updateRepRate(ns, currentTarget.faction);

  // Faction opportunities (used both in main logic and for dashboard)
  const opportunities = getUnjoinedFactionOpportunities(ns);
  globalThis.gordFactionPipeline = opportunities;

  // Auto-hop to a city and back for any faction that's fully ready to join
  // (all non-location requirements already met). Cheap, instant, and takes
  // priority over everything else this tick regardless of focus/idle state.
  const autoTravel = await maybeAutoTravelForReadyFaction(ns, opportunities);
  if (autoTravel) {
    return { ...autoTravel, target: null, infra: null };
  }

  // Early bootstrap
  const bootstrap = await doEarlyBootstrapIfNeeded(ns);
  if (bootstrap) {
    return { ...bootstrap, target: null, infra: null };
  }

  // Program creation
  // Covers all 5 port openers (BruteSSH, FTPCrack, relaySMTP, HTTPWorm, SQLInject).
  // More open ports = more rootable servers → more worker RAM.
  const programWork = await maybeCreatePrograms(ns);
  if (programWork) {
    const target = getNextAugTarget(ns);
    return { ...programWork, target, infra: null };
  }

  const target = getNextAugTarget(ns);
  const infra  = await maybeBuyInfra(ns, target);

  // No aug target
  if (!target) {
    // Try to unlock new factions first
    const factionPursuit = await maybePursueNextFaction(ns, opportunities, true);
    if (factionPursuit) {
      // If we're blocked on faction join money, keep earning toward that goal
      const moneyGoal = factionPursuit.joinMoneyMissing
        ? playerMoney(ns) + factionPursuit.joinMoneyMissing
        : 0;
      const idle = await doIdleWork(ns, moneyGoal);
      return { ...factionPursuit, ...idle, target: null, infra };
    }

    // Nothing to unlock - do productive idle work (crime -> study -> faction rep)
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
      // Background mode: bank more faction rep or secondary rep while hacking earns money.
      // Crime would steal nothing here since hacking runs freely in the background.
      const factionHasMoreRepWork = (() => {
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
        detail: `Hacking for $${ns.format.number(target.moneyMissing)} -> ${target.aug}`,
        target,
        infra,
      };
    }

    // Focus mode: crime is the best use of player attention.
    // Try homicide first, fall back to mugging if chance is too low.
    const crime = await commitBestCrimeIfUseful(ns, `$${ns.format.number(target.moneyMissing)} for ${target.aug}`);
    if (crime) {
      return { ...crime, target, infra };
    }

    // Can't crime effectively yet — hacking is the only income source.
    return {
      action: "Saving",
      detail: `Hacking for $${ns.format.number(target.moneyMissing)} -> ${target.aug}`,
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
    // on, and buy port openers when affordable to unlock bigger servers.
    await acceptInvites(ns);
    await buyDarkweb(ns);
    rootEverything(ns);

    // Backdoors FIRST, ahead of every RAM-hungry helper below: CSEC/avmnite-02h/
    // I.I.I.I/run4theh111z unlock CyberSec, NiteSec, The Black Hand and BitRunners,
    // and the backdoor loop is only ~9GB now that the 32GB BitNode finisher is its
    // own script (lib/finish-bn.js, launched by this same call once the world daemon
    // is backdoored). Launched after the botnet it used to lose that race for RAM
    // and never install a single backdoor.
    ensureBackdoorHelpers(ns, Number(ns.args[0] ?? CFG.backdoor.defaultNextBN), SELF);

    // Corporation (now that we have corp API access everywhere): keep the one-shot
    // creator running until a corp exists (self-funded + affordability-gated), then
    // keep its managers on the reserved cloud-corp host. Runs first so the corp
    // host reservation is published before the other helpers pick hosts. Self-gates
    // on corp.enabled / affordability, so it's a quiet no-op until we can fund it.
    const corpEvent = maybeSetupCorp(ns);
    ensureCorpManagers(ns, new Set());

    // Launch helpers off-home when possible (keeps scarce home RAM for the
    // daemon). Income manager first, then UI/luxury scripts.
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

    // Hacknet/home-RAM spending, off-home. The backdoor helpers went up first,
    // before the botnet claimed the network's RAM.
    ensureHelper(ns, ECON_SCRIPT, { optional: true });

    globalThis.gordState = await decideNextPriority(ns);
    if (corpEvent) globalThis.gordState = { ...globalThis.gordState, ...corpEvent };

    const bought = buyAugs(ns);
    if (bought?.length) {
      globalThis.gordState.purchases = bought;
    }

    // Expose the full sorted candidate list for the dashboard's "pipeline" view.
    globalThis.gordAugPipeline = getAllAugCandidates(ns).slice(0, AUGS.pipelineSize);

    maybeInstall(ns, SELF);

    ns.print(
      `Money: ${ns.format.number(playerMoney(ns))} | Hack: ${hackingLevel(ns)}`
    );
    await ns.sleep(CFG.daemon.tickMs);
  }
}