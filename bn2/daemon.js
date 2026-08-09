// bn2/daemon.js
//
// BN2 ("Rise of the Underworld") orchestrator. Same skeleton as bn4/daemon.js,
// with one big difference: in BN2 a gang can be created as soon as we can join
// a criminal faction (no -54k karma gate), and the gang faction sells nearly
// every augmentation in the game while its rep accrues passively from gang
// respect. So the top priority after the early bootstrap is: train combat to
// 30s -> crime to -9 karma + $1M -> join Slum Snakes -> createGang, then hand
// day-to-day gang management to /lib/gang.js (run wherever RAM allows).

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

// Every tunable value comes from lib/config.js, resolved for BitNode 2 - that's
// where BN2's gang shortcut (-9 karma instead of -54,000, Slum Snakes, $1M join
// money) is declared, in BITNODE[2].
const CFG = forNode(2);
const AUGS = CFG.augs;
const GANG = CFG.gang;
const FACTION_REQUIREMENTS = CFG.factions.requirements;

// Off-home helper scripts (shared by every daemon) that keep this daemon's HOME
// footprint small: each carries the expensive Singularity/Hacknet calls it needs,
// and running them off-home means those never count against the daemon's RAM.
const ECON_SCRIPT = CFG.paths.econ;           // hacknet + home-RAM spending
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
 * nothing needs player attention this tick).
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

// ── Augs / install / infra (same as bn4) ─────────────────────────────────────

/** @param {NS} ns */
async function decideNextPriority(ns) {
  // Update rolling rate snapshots
  estimateIncomeRate(ns);
  const currentTarget = globalThis.gordState?.target;
  if (currentTarget?.faction) updateRepRate(ns, currentTarget.faction);

  const opportunities = getUnjoinedFactionOpportunities(ns);
  globalThis.gordFactionPipeline = opportunities;

  const autoTravel = await maybeAutoTravelForReadyFaction(ns, opportunities);
  if (autoTravel) {
    return { ...autoTravel, target: null, infra: null };
  }

  // Early bootstrap (study to hack 50, mug for TOR/BruteSSH money)
  const bootstrap = await doEarlyBootstrapIfNeeded(ns);
  if (bootstrap) {
    return { ...bootstrap, target: null, infra: null };
  }

  // Gang setup - THE priority in BN2. No infra spending while this runs so
  // crime money accumulates toward the $1M Slum Snakes join requirement.
  const gangSetup = await maybeSetupGang(ns);
  if (gangSetup) {
    return { ...gangSetup, target: getNextAugTarget(ns), infra: null };
  }

  // Program creation (port openers still matter for worker RAM)
  const programWork = await maybeCreatePrograms(ns);
  if (programWork) {
    const target = getNextAugTarget(ns);
    return { ...programWork, target, infra: null };
  }

  const target = getNextAugTarget(ns);
  const infra  = await maybeBuyInfra(ns, target);

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
    // Gang faction rep accrues passively from gang respect - workForFaction
    // doesn't even apply to it. Spend player attention elsewhere.
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
        if (ns.gang.inGang() && target.faction === (globalThis.gordGangState?.faction ?? GANG_FACTION)) {
          return false; // gang rep doesn't need player work
        }
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

    // Focus mode: crime is the best use of player attention.
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

    // Gang first: it reserves cloud-gang from the botnet before anything else goes
    // looking for off-home RAM, and lib/gang.js is ~36GB - big enough to lose every
    // race for a shared host. Then the hacking manager (our main income engine -
    // starts earning on any 16GB server, no port openers needed), then UI/luxury.
    const reserved = new Set();
    ensureGangManager(ns, reserved);
    globalThis.gordReservedHosts = reserved;

    // Corporation (now that we have corp API access everywhere): keep the one-shot
    // creator running until a corp exists, then keep its managers alive on the
    // reserved cloud-corp host. ensureGangManager has just published the
    // gang reservation this tick; we add the corp host to that same fresh Set.
    // Both self-gate on corp.enabled / affordability, so this is a quiet no-op
    // until we can comfortably self-fund the corp.
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

    // Hacknet/home-RAM spending (econ.js), off-home; it keeps the gang-join money
    // free while we're still bootstrapping toward the gang. The backdoor helpers
    // went up first, before the botnet claimed the network's RAM.
    ensureHelper(ns, ECON_SCRIPT, { optional: true, args: [GANG_JOIN_MONEY] });

    globalThis.gordState = await decideNextPriority(ns);
    if (corpEvent) globalThis.gordState = { ...globalThis.gordState, ...corpEvent };

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
