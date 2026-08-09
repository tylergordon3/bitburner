// bn3/daemon.js
//
// BN3 ("Corporatocracy") orchestrator. Same skeleton as bn4/daemon.js (root the
// net, run the hacking botnet + helpers off-home, grind augs/factions, install,
// finish), with BN3's defining mechanic bolted on: a CORPORATION.
//
// The corporation is the income engine here. The whole corp machinery is now
// shared across every corp-viable node in lib/corp-daemon.js (creation via the
// one-shot lib/corp-create.js, plus keeping the managers alive): day-to-day play
// is split into lib/corp-steady.js (small, always-on, on the dedicated cloud-corp
// host) and the four build phases lib/corp-expand/office/market/invest.js (run in
// one-shot on borrowed off-home RAM). Both are far too RAM-heavy to co-host with
// this daemon on home. This daemon likewise keeps its own heaviest calls off home
// via bn3/backdoor.js (backdoors + finishing the BN) and bn3/econ.js (hacknet +
// home-RAM spending).
//
// Gangs still feature, but unlike BN2 there's no early-gang shortcut: forming
// one needs -54,000 karma (SF2 lets us do it here at all). We don't grind crime
// toward that; instead crime we already do while saving for augs trends karma
// down, and the moment it crosses the gate we snap up a gang for free. Both the
// corp and the gang PERSIST through augmentation installs, so their managers
// simply resume after each reset.

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

// Every tunable value comes from lib/config.js, resolved for BitNode 3. BN3 has
// no gang shortcut, so gang.karma keeps CONFIG's universal -54,000 gate (see
// BITNODE in lib/config.js).
const CFG = forNode(3);
const AUGS = CFG.augs;
const GANG = CFG.gang;
const FACTION_REQUIREMENTS = CFG.factions.requirements;

// Off-home helper scripts (shared by every daemon) that keep this daemon's HOME
// footprint small: each carries the expensive Singularity/Hacknet calls it needs,
// and running them off-home means those never count against the daemon's RAM.
// Corp orchestration (create + operate) lives in lib/corp-daemon.js.
const ECON_SCRIPT = CFG.paths.econ;           // hacknet + home-RAM spending
const SELF = CFG.paths.daemon;                // this daemon's path (post-reset callback)

// ── Gang (late-game, -54k karma) ──────────────────────────────────────────────
const GANG_KARMA = GANG.karma;
// Criminal factions that can found a gang; whichever we're already in is used.
// Cast to any[] so its elements don't trip checkJs against FactionName (a plain
// `string` isn't assignable to the union) - see [[bitburner-enum-string-casts]].
const CRIMINAL_FACTIONS = /** @type {any[]} */ (GANG.criminalFactions);

// ── Gang setup ────────────────────────────────────────────────────────────────

/**
 * Found a gang the moment we're eligible: karma past the -54k gate AND already a
 * member of a criminal faction. We never grind toward this - crime done while
 * saving for augs sinks karma over the long run, and acceptInvites joins the
 * criminal faction whose (easily-met) requirements land first. Returns a status
 * object while there's something to report, null otherwise.
 * @param {NS} ns
 */
function maybeSetupGang(ns) {
  if (inGangSafe(ns)) return null;

  const player = ns.getPlayer();
  if ((player.karma ?? 0) > GANG_KARMA) return null; // not eligible yet

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

// ── Cloud-hosted managers (corp + gang) ──────────────────────────────────────

/**
 * Keep the corp and gang managers running on their dedicated cloud hosts and
 * publish the combined botnet reservation so hacking/manager.js and pserv.js
 * leave those hosts alone. Rebuilt fresh each tick so a reset/relaunch heals it.
 * Gang is placed first so its host is reserved before ensureCorpManagers looks
 * for off-home RAM to run the build-phase one-shots; ensureCorpManagers then adds
 * the corp host and republishes the reservation.
 * @param {NS} ns
 */
function ensureCloudManagers(ns) {
  const reserved = new Set();

  // Gang first: lib/gang.js is ~36GB and loses any race for shared RAM, so its host
  // has to be reserved before the corp goes looking for somewhere to run.
  ensureGangManager(ns, reserved);
  globalThis.gordReservedHosts = reserved;

  // Corp: places corp-steady on the reserved cloud-corp host (adding it to
  // `reserved` + republishing) and rotates the build phases. Self-gates on
  // corp.enabled / hasCorporation, so it's a no-op before the corp exists.
  ensureCorpManagers(ns, reserved);
}

// ── Augs / install / infra (same policy as bn4) ──────────────────────────────

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

  const bootstrap = await doEarlyBootstrapIfNeeded(ns);
  if (bootstrap) {
    return { ...bootstrap, target: null, infra: null };
  }

  const programWork = await maybeCreatePrograms(ns);
  if (programWork) {
    const target = getNextAugTarget(ns);
    return { ...programWork, target, infra: null };
  }

  const target = getNextAugTarget(ns);
  const infra  = await maybeBuyInfra(ns, target);

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

  const statTargets = FACTION_REQUIREMENTS[target.faction] ?? {};
  const training = await trainCombatIfNeeded(ns, statTargets);
  if (training) {
    return { ...training, target, infra };
  }

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
        detail: `Corp/hacking income for $${ns.format.number(target.moneyMissing)} -> ${target.aug}`,
        target,
        infra,
      };
    }

    // Focus mode: crime is the best use of player attention (money + karma,
    // which also trends us toward the -54k gang gate).
    const crime = await commitBestCrimeIfUseful(ns, `$${ns.format.number(target.moneyMissing)} for ${target.aug}`);
    if (crime) {
      return { ...crime, target, infra };
    }

    return {
      action: "Saving",
      detail: `Corp/hacking income for $${ns.format.number(target.moneyMissing)} -> ${target.aug}`,
      target,
      infra,
    };
  }

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
    // Root the network FIRST so the helpers below have off-home hosts to land on.
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

    // BN3 setup: create the corp (one free call), and snap up a gang if karma
    // has crossed the -54k gate. Both are quick, idempotent no-ops afterward.
    const corpEvent = maybeSetupCorp(ns);
    const gangEvent = maybeSetupGang(ns);

    // Keep the cloud-hosted managers (corp, gang) alive on their reserved hosts,
    // then the botnet income engine and UI/luxury scripts off-home.
    ensureCloudManagers(ns);
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

    // Hacknet/home-RAM spending, off-home (see its file header). The backdoor
    // helpers went up first, before the botnet claimed the network's RAM.
    ensureHelper(ns, ECON_SCRIPT, { optional: true });

    globalThis.gordState = await decideNextPriority(ns);
    // Surface a fresh corp/gang creation event over the routine priority.
    if (corpEvent) globalThis.gordState = { ...globalThis.gordState, ...corpEvent };
    else if (gangEvent?.action === "Gang Created") globalThis.gordState = { ...globalThis.gordState, ...gangEvent };

    const bought = buyAugs(ns);
    if (bought?.length) {
      globalThis.gordState.purchases = bought;
    }

    globalThis.gordAugPipeline = getAllAugCandidates(ns).slice(0, AUGS.pipelineSize);

    maybeInstall(ns, SELF);

    ns.print(
      `Money: ${ns.format.number(playerMoney(ns))} | Hack: ${hackingLevel(ns)} | Karma: ${(ns.getPlayer().karma ?? 0).toFixed(0)}`
    );
    await ns.sleep(CFG.daemon.tickMs);
  }
}
