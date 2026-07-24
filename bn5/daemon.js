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
// No corporation: BN5's corp nerf plus the large RAM/complexity cost make it a
// poor trade against the gang, so this node skips the BN3 corp machinery entirely.

import { managePurchasedServers } from "../lib/pserv.js";
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
// Shared daemon core (identical across bn2/bn3/bn4/bn5) - see lib/daemon-lib.js.
import {
  playerMoney,
  hackingLevel,
  freeRam,
  ensureHelper,
  buyDarkweb,
  rootEverything,
  acceptInvites,
  canBuyAug,
  readLastResetTime,
  writeResetTime,
  recordResetSummary,
  consumeResetSummary,
} from "../lib/daemon-lib.js";

// Every tunable value comes from lib/config.js, resolved for BitNode 5 - that's
// where BN5's active-karma-grind flag lives (BITNODE[5].gang.activeKarmaGrind).
const CFG = forNode(5);
const AUGS = CFG.augs;
const GANG = CFG.gang;
const FACTION_REQUIREMENTS = CFG.factions.requirements;

// Off-home helper scripts (shared by every daemon) that keep this daemon's HOME
// footprint small: each carries the expensive Singularity/Hacknet calls it needs,
// and running them off-home means those never count against the daemon's RAM.
const BACKDOOR_SCRIPT = CFG.paths.backdoor;   // server backdoors + finishing the BN
const ECON_SCRIPT = CFG.paths.econ;           // hacknet + home-RAM spending
const SELF = CFG.paths.daemon;                // this daemon's path (post-reset callback)

// ── Gang (universal -54k karma gate, actively ground toward) ──────────────────
const GANG_KARMA = GANG.karma;                // -54,000 in BN5 (CONFIG default)
const ACTIVE_KARMA_GRIND = GANG.activeKarmaGrind;
const GANG_SCRIPT = CFG.paths.gang;
const GANG_HOST = GANG.host;
// Home must have at least (gang RAM + this) to host the gang manager itself,
// leaving room for the daemon, the botnet manager's reserve, and some workers.
const HOME_GANG_HEADROOM = GANG.homeHeadroom;
// Criminal factions that can found a gang; whichever we're already in (by this
// preference order) gets used. Cast to any[] so its elements don't trip checkJs
// against FactionName - see [[bitburner-enum-string-casts]].
const CRIMINAL_FACTIONS = /** @type {any[]} */ (GANG.criminalFactions);
// The earliest/cheapest criminal faction (30 combat) - used only for the combat
// requirements we train toward while bootstrapping the gang. Crime itself does
// most of the combat building; this is a cheap belt-and-braces call.
const GANG_TRAIN_REQS = FACTION_REQUIREMENTS["Slum Snakes"] ?? {};

/** @param {NS} ns - true if we're in a gang; false (not just missing API) otherwise. */
function inGangSafe(ns) {
  try {
    return ns.gang.inGang();
  } catch {
    return false;
  }
}

/**
 * The BitNode to enter when lib/backdoor.js destroys w0r1d_d43m0n - encoding the
 * "run BN5.1, then BN5.2, then stop" plan (see [[bitnode-progress]]):
 *   - BN5 with SF-5 level 0 (this is 5.1): re-enter BN5 (return 5) to do 5.2.
 *   - BN5 with SF-5 level >= 1 (5.2 done, or beyond): return 0, the halt sentinel
 *     lib/backdoor.js reads as "backdoor everything but DON'T auto-destroy" - the
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

  // 2. Grind karma via the best available crime (homicide, else mug). This is
  //    the crux of the BN5 strategy: crime earns karma + combat + money at once.
  const crime = await commitBestCrimeIfUseful(ns, `karma ${karma.toFixed(0)}/${GANG_KARMA} -> gang`);
  if (crime) return crime;

  // Post-bootstrap this shouldn't happen (mug chance is already high), but guard
  // it so a bad combat run reports clearly instead of silently stalling.
  return { action: "Gang Blocked", detail: "Crime chance too low - crime will raise combat stats" };
}

/**
 * Ensure a dedicated cloud server (GANG_HOST) exists and is big enough to hold
 * the gang manager. Purchased servers only come in powers of two, so we buy/
 * upgrade to the smallest power-of-two >= the gang's RAM. Spends conservatively
 * and never dips below half our cash. Returns true once GANG_HOST is big enough.
 * (Same helper as bn2/daemon.js - BN5 has only the one big cloud manager.)
 * @param {NS} ns @param {number} needRam
 */
function provisionGangHost(ns, needRam) {
  const cloud = ns.cloud;
  if (cloud.getServerLimit() <= 0) return false;

  const maxRam = cloud.getRamLimit();
  let size = CFG.cloudHost.minRam;
  while (size < needRam && size < maxRam) size *= 2;
  if (size < needRam) return false; // even the largest tier can't hold the gang

  const exists = ns.serverExists(GANG_HOST);
  if (exists && ns.getServerMaxRam(GANG_HOST) >= needRam) return true;

  const affordable = playerMoney(ns) * CFG.cloudHost.spendFraction;

  if (!exists) {
    if (cloud.getServerNames().length >= cloud.getServerLimit()) return false;
    if (cloud.getServerCost(size) > affordable) return false;
    if (cloud.purchaseServer(GANG_HOST, size)) {
      ns.tprint(`Provisioned dedicated gang host ${GANG_HOST} (${ns.format.ram(size)}).`);
      return true;
    }
    return false;
  }

  const cost = cloud.getServerUpgradeCost(GANG_HOST, size);
  if (cost < 0 || cost > affordable) return false;
  if (cloud.upgradeServer(GANG_HOST, size)) {
    ns.tprint(`Upgraded gang host ${GANG_HOST} -> ${ns.format.ram(size)}.`);
    return true;
  }
  return false;
}

/**
 * Keep /lib/gang.js (~36GB) running somewhere. If home is big enough, reserve
 * the gang's RAM out of home (the botnet honours globalThis.gordReservedRam and
 * vacates it within a batch or two) and run it there - free and immediate.
 * Otherwise provision the dedicated cloud host (GANG_HOST), reserve it whole from
 * the botnet, and run it there. Publishes globalThis.gordGangPending during the
 * short wait before it lands. (Same logic as bn2/daemon.js.)
 * @param {NS} ns
 */
function ensureGangManagerRunning(ns) {
  if (!inGangSafe(ns)) {
    globalThis.gordReservedRam = {};
    globalThis.gordReservedHosts = new Set();
    globalThis.gordGangPending = false;
    return;
  }

  const ram = ns.getScriptRam(GANG_SCRIPT, "home");
  const cloudNames = ns.cloud.getServerNames();

  // Already running somewhere? Sync the reservation to where it lives and stop.
  const running = ["home", GANG_HOST, ...cloudNames].find(
    h => ns.serverExists(h) && ns.scriptRunning(GANG_SCRIPT, h)
  );
  if (running) {
    globalThis.gordGangPending = false;
    globalThis.gordReservedHosts = running === GANG_HOST ? new Set([GANG_HOST]) : new Set();
    globalThis.gordReservedRam = {};
    return;
  }

  // Not running yet - pick a strategy and carve out room.
  const homeCanHost = ns.getServerMaxRam("home") >= ram + HOME_GANG_HEADROOM;
  let hosts;
  if (homeCanHost) {
    globalThis.gordReservedRam = { home: ram + GANG.homeReserveSlack };
    globalThis.gordReservedHosts = new Set();
    hosts = ["home", ...cloudNames];
  } else {
    globalThis.gordReservedRam = {};
    provisionGangHost(ns, ram);
    globalThis.gordReservedHosts = ns.serverExists(GANG_HOST) ? new Set([GANG_HOST]) : new Set();
    hosts = [GANG_HOST, ...cloudNames.filter(h => h !== GANG_HOST), "home"];
  }

  for (const host of hosts) {
    if (!ns.serverExists(host)) continue;
    const headroom = host === "home" ? CFG.helpers.homeHeadroom : 0;
    if (freeRam(ns, host) - headroom < ram) continue;
    if (host !== "home") ns.scp(ns.ls("home", ".js"), host, "home");
    if (ns.exec(GANG_SCRIPT, host, 1)) {
      ns.tprint(`Started ${GANG_SCRIPT} on ${host}`);
      globalThis.gordGangPending = false;
      return;
    }
  }

  globalThis.gordGangPending = true;
  ns.print(`WARN: waiting for ${ns.format.ram(ram)} to free for ${GANG_SCRIPT} (home ${ns.format.ram(freeRam(ns, "home"))} free)`);
}

// ── Augs / install / infra (same policy as the other daemons) ─────────────────

/** @param {NS} ns */
function buyAugs(ns) {
  const s = ns.singularity;
  const owned = new Set(s.getOwnedAugmentations(true));
  const joined = ns.getPlayer().factions ?? [];

  const candidates = [];
  const purchases = [];

  for (const faction of joined) {
    for (const aug of s.getAugmentationsFromFaction(/** @type {any} */ (faction))) {
      if (canBuyAug(ns, faction, aug, owned)) {
        candidates.push({
          faction,
          aug,
          price: s.getAugmentationPrice(aug),
          rep: s.getAugmentationRepReq(aug),
        });
      }
    }
  }

  // Buy cheapest first; NeuroFlux Governor always last.
  candidates.sort((a, b) => {
    const aNFG = a.aug === AUGS.neuroFlux ? 1 : 0;
    const bNFG = b.aug === AUGS.neuroFlux ? 1 : 0;
    if (aNFG !== bNFG) return aNFG - bNFG;
    return a.price - b.price;
  });

  for (const c of candidates) {
    if (canBuyAug(ns, c.faction, c.aug, owned)) {
      if (s.purchaseAugmentation(/** @type {any} */ (c.faction), c.aug)) {
        purchases.push(`${c.aug} from ${c.faction}`);
        owned.add(c.aug);
      }
    }
  }

  return purchases;
}

const INSTALL_PRIORITY_AUGS = AUGS.installPriority;

/** @param {NS} ns */
function startBestFactionWork(ns, faction) {
  const types = CFG.player.factionWorkTypes;
  for (const type of types) {
    const ok = ns.singularity.workForFaction(
      /** @type {any} */ (faction),
      /** @type {any} */ (type),
      shouldFocus(ns)
    );
    if (ok) return type;
  }
  return null;
}

/**
 * Same install policy as the other daemons. Resets are cheap in BN5 too: the
 * gang (members, respect, territory) AND accumulated karma both persist through
 * installs, so the daemon just relaunches /lib/gang.js after boot and the karma
 * grind never loses ground.
 * @param {NS} ns
 */
function maybeInstall(ns) {
  const ownedWithPurchased = ns.singularity.getOwnedAugmentations(true);
  const ownedInstalled = ns.singularity.getOwnedAugmentations(false);
  const queued = ownedWithPurchased.length - ownedInstalled.length;

  const hasRedPill = ownedWithPurchased.includes(AUGS.redPill);
  const hasPriorityAug = INSTALL_PRIORITY_AUGS.some(
    a => ownedWithPurchased.includes(a) && !ownedInstalled.includes(a)
  );

  const allPriorityDone = INSTALL_PRIORITY_AUGS.every(a => ownedInstalled.includes(a));
  const aggressiveInstall = allPriorityDone && queued >= AUGS.install.minQueued;

  const lastReset = readLastResetTime(ns);
  const elapsed = Date.now() - lastReset;
  const TIME_TRIGGER_MS = AUGS.install.timeTriggerMs;
  const timeTriggered = queued >= AUGS.install.minQueued && elapsed >= TIME_TRIGGER_MS;

  if (hasRedPill || queued >= AUGS.install.queuedThreshold || (queued >= AUGS.install.priorityQueuedThreshold && hasPriorityAug) || aggressiveInstall || timeTriggered) {
    if (timeTriggered) {
      const hours = (elapsed / 3_600_000).toFixed(1);
      ns.tprint(`Time-triggered install after ${hours}h with ${queued} aug(s) queued.`);
    }
    if (aggressiveInstall) {
      ns.tprint(`Aggressive install: all priority augs done, resetting with ${queued} queued.`);
    }

    // Dump remaining cash into NeuroFlux Governor right before resetting.
    const s = ns.singularity;
    const nfgFaction = (ns.getPlayer().factions ?? []).find(f =>
      s.getFactionRep(/** @type {any} */ (f)) >= s.getAugmentationRepReq(AUGS.neuroFlux)
    ) ?? null;
    if (nfgFaction) {
      let bought = true;
      while (bought) {
        const price = s.getAugmentationPrice(AUGS.neuroFlux);
        if (playerMoney(ns) < price) break;
        bought = s.purchaseAugmentation(/** @type {any} */ (nfgFaction), AUGS.neuroFlux);
      }
    }

    // Record what this reset installs + how long the run lasted, for the next
    // boot's journal. Computed AFTER the NeuroFlux buys above (so late NFG is
    // counted) and BEFORE writeResetTime (which overwrites the old timestamp we
    // need for the duration). Guarded: a summary failure must never block the
    // install.
    try {
      const installedSet = new Set(s.getOwnedAugmentations(false));
      const installing = s.getOwnedAugmentations(true).filter(a => !installedSet.has(a));
      recordResetSummary(ns, installing, Date.now() - readLastResetTime(ns));
    } catch (e) {
      ns.print(`reset summary failed: ${String(e)}`);
    }

    writeResetTime(ns);
    ns.singularity.installAugmentations(SELF);
  }
}

/** @param {NS} ns @param {any} target */
async function maybeBuyInfra(ns, target) {
  const money = playerMoney(ns);

  if (!target) {
    return await managePurchasedServers(ns, CFG.infra.noTarget.reserveMoney, CFG.infra.noTarget.spendFraction);
  }

  const { price, moneyMissing = 0, repMissing = 0 } = target;

  if (repMissing > 0) {
    const hardCap = money > price ? money - price : money * CFG.infra.repPending.fallbackCapFraction;
    return await managePurchasedServers(ns, CFG.infra.repPending.reserveMoney, CFG.infra.repPending.spendFraction, hardCap);
  }

  const tinyBudget = moneyMissing * CFG.infra.savingBudgetFraction;
  if (tinyBudget < CFG.infra.minBudget) {
    return {
      action: "Saving for Aug",
      detail: `${target.aug}: need $${ns.format.number(moneyMissing)}`,
    };
  }
  return await managePurchasedServers(ns, price, CFG.infra.savingSpendFraction, tinyBudget);
}

/**
 * When our primary goal doesn't need player focus, optionally bank rep with a
 * secondary faction that has augs we'll want later. Gang faction rep is passive
 * (accrues from respect) so it's skipped here.
 * @param {NS} ns @param {string} primaryFaction
 */
function maybeDoSecondaryFactionWork(ns, primaryFaction) {
  if (shouldFocus(ns)) return null;

  const s = ns.singularity;
  const owned = new Set(s.getOwnedAugmentations(true));
  const joined = ns.getPlayer().factions ?? [];
  const gangFaction = globalThis.gordGangState?.faction;

  for (const factionName of joined) {
    if (factionName === primaryFaction) continue;
    if (factionName === gangFaction) continue; // gang rep is passive

    const augs = s.getAugmentationsFromFaction(/** @type {any} */ (factionName));
    const currentRep = s.getFactionRep(/** @type {any} */ (factionName));

    const hasUsefulWork = augs.some(aug => {
      if (aug === AUGS.neuroFlux) return false;
      if (owned.has(aug)) return false;
      const prereqs = s.getAugmentationPrereq(aug);
      if (!prereqs.every(a => owned.has(a))) return false;
      return s.getAugmentationRepReq(aug) > currentRep;
    });

    if (!hasUsefulWork) continue;

    const workType = startBestFactionWork(ns, factionName);
    if (workType) return `Secondary: ${factionName} (${workType})`;
  }

  return null;
}

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

  const gangFaction = globalThis.gordGangState?.faction;

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
    if (inGangSafe(ns) && target.faction === gangFaction) {
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
        if (inGangSafe(ns) && target.faction === gangFaction) return false;
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

    // Keep the gang manager alive on its reserved host (once we're in a gang),
    // then the botnet income engine and UI/luxury scripts off-home. Gang first
    // so it can reserve cloud-gang from the botnet before the botnet claims it.
    ensureGangManagerRunning(ns);
    ensureHelper(ns, CFG.paths.manager);
    ensureHelper(ns, CFG.paths.dashboard);
    ensureHelper(ns, CFG.paths.stocks, { optional: true });

    // Off-home helpers carrying this daemon's heaviest calls: backdoors + BN-finish
    // (backdoor.js gets the next BitNode + this daemon's path forwarded), and
    // hacknet/home-RAM spending (econ.js - hacknet is weak in BN5 but it also
    // buys home RAM, which stays valuable).
    // nextBN follows the 5.1->5.2->halt plan (plannedNextBN); no cbScript arg, so
    // backdoor.js defaults it to the cold-start driver - the safe entry for a
    // fresh 32GB node (running the big daemon directly there could fail to fit).
    ensureHelper(ns, BACKDOOR_SCRIPT, { args: [plannedNextBN(ns)] });
    ensureHelper(ns, ECON_SCRIPT, { optional: true });

    globalThis.gordState = await decideNextPriority(ns);

    const bought = buyAugs(ns);
    if (bought?.length) {
      globalThis.gordState.purchases = bought;
    }

    globalThis.gordAugPipeline = getAllAugCandidates(ns).slice(0, AUGS.pipelineSize);

    maybeInstall(ns);

    ns.print(
      `Money: ${ns.format.number(playerMoney(ns))} | Hack: ${hackingLevel(ns)} | Karma: ${(ns.getPlayer().karma ?? 0).toFixed(0)}/${GANG_KARMA}`
    );
    await ns.sleep(CFG.daemon.tickMs);
  }
}
