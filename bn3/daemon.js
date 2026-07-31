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
// host) and lib/corp-build.js (bounded structural buildout, run as a periodic
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

import { allServers } from "../lib/net.js";
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
// Shared daemon core (identical across bn2/bn3/bn4) - see lib/daemon-lib.js.
import {
  playerMoney,
  hackingLevel,
  freeRam,
  ensureHelper,
  placeManager,
  buyDarkweb,
  rootEverything,
  acceptInvites,
  canBuyAug,
  readLastResetTime,
  writeResetTime,
  recordResetSummary,
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
const BACKDOOR_SCRIPT = CFG.paths.backdoor;   // server backdoors + finishing the BN
const ECON_SCRIPT = CFG.paths.econ;           // hacknet + home-RAM spending
const SELF = CFG.paths.daemon;                // this daemon's path (post-reset callback)

// ── Gang (late-game, -54k karma) ──────────────────────────────────────────────
const GANG_KARMA = GANG.karma;
const GANG_SCRIPT = CFG.paths.gang;
const GANG_HOST = GANG.host;
// Criminal factions that can found a gang; whichever we're already in is used.
// Cast to any[] so its elements don't trip checkJs against FactionName (a plain
// `string` isn't assignable to the union) - see [[bitburner-enum-string-casts]].
const CRIMINAL_FACTIONS = /** @type {any[]} */ (GANG.criminalFactions);

/** @param {NS} ns - true if we're in a gang; false (not just missing API) otherwise. */
function inGangSafe(ns) {
  try {
    return ns.gang.inGang();
  } catch {
    return false;
  }
}

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
 * for off-home RAM to run the corp-build one-shot; ensureCorpManagers then adds
 * the corp host and republishes the reservation.
 * @param {NS} ns
 */
function ensureCloudManagers(ns) {
  const reserved = new Set();

  if (inGangSafe(ns)) {
    placeManager(ns, GANG_SCRIPT, GANG_HOST, reserved);
  }
  globalThis.gordReservedHosts = reserved;

  // Corp: places corp-steady on the reserved cloud-corp host (adding it to
  // `reserved` + republishing) and runs the corp-build one-shot. Self-gates on
  // corp.enabled / hasCorporation, so it's a no-op before the corp exists.
  ensureCorpManagers(ns, reserved);

  globalThis.gordReservedRam = {};
}

// ── Augs / install / infra (same policy as bn4) ──────────────────────────────

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
 * Same install policy as bn4. Resets are cheap in BN3 too: the corporation (and
 * a gang, once formed) persist through installs, so the daemon just relaunches
 * their managers after boot and they pick up mid-stride.
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
    // boot's journal. Computed AFTER the NeuroFlux buys above and BEFORE
    // writeResetTime (which overwrites the old timestamp we need for the
    // duration). Guarded: a summary failure must never block the install.
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

  const gangFaction = globalThis.gordGangState?.faction;

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

    // BN3 setup: create the corp (one free call), and snap up a gang if karma
    // has crossed the -54k gate. Both are quick, idempotent no-ops afterward.
    const corpEvent = maybeSetupCorp(ns);
    const gangEvent = maybeSetupGang(ns);

    // Keep the cloud-hosted managers (corp, gang) alive on their reserved hosts,
    // then the botnet income engine and UI/luxury scripts off-home.
    ensureCloudManagers(ns);
    ensureHelper(ns, CFG.paths.manager);
    ensureHelper(ns, CFG.paths.dashboard);
    ensureHelper(ns, CFG.paths.stocks, { optional: true });

    // Coding-contract solver (universal across all nodes): solves .cct files
    // network-wide for money/rep/karma, skipping unknown types. Off-home + optional
    // (waits quietly for RAM), since contracts are rare and non-urgent.
    ensureHelper(ns, CFG.paths.contracts, { optional: true });

    // Off-home helpers that carry this daemon's heaviest calls (see their file
    // headers): backdoors + BN-finish, and hacknet/home-RAM spending. backdoor.js
    // gets the next BitNode forwarded (the driver launches us with no args, so
    // this defaults to 1 - same as the old in-daemon behaviour).
    ensureHelper(ns, BACKDOOR_SCRIPT, { args: [Number(ns.args[0] ?? CFG.backdoor.defaultNextBN), SELF] });
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

    maybeInstall(ns);

    ns.print(
      `Money: ${ns.format.number(playerMoney(ns))} | Hack: ${hackingLevel(ns)} | Karma: ${(ns.getPlayer().karma ?? 0).toFixed(0)}`
    );
    await ns.sleep(CFG.daemon.tickMs);
  }
}
