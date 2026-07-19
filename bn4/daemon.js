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
  FACTION_REQUIREMENTS,
} from "../lib/aug-targets.js";
// Shared daemon core (identical across bn2/bn3/bn4) - see lib/daemon-lib.js.
import {
  playerMoney,
  hackingLevel,
  ensureHelper,
  buyDarkweb,
  rootEverything,
  acceptInvites,
  canBuyAug,
  readLastResetTime,
  writeResetTime,
} from "../lib/daemon-lib.js";

// Off-home helper scripts (shared by every daemon) that keep this daemon's HOME
// footprint small: each carries the expensive Singularity/Hacknet calls it needs,
// and running them off-home means those never count against the daemon's RAM.
const BACKDOOR_SCRIPT = "/lib/backdoor.js";   // server backdoors + finishing the BN
const ECON_SCRIPT = "/lib/econ.js";           // hacknet + home-RAM spending
const SELF = "/bn4/daemon.js";                // this daemon's path (post-reset callback)

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
    const aNFG = a.aug === "NeuroFlux Governor" ? 1 : 0;
    const bNFG = b.aug === "NeuroFlux Governor" ? 1 : 0;
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

const INSTALL_PRIORITY_AUGS = [
  "BitWire",
  "Neuralstimulator",
  "Neural-Retention Enhancement",
  "CashRoot Starter Kit",
  "Hacknet Node CPU Architecture Neural-Upload",
];

/** @param {NS} ns */
function startBestFactionWork(ns, faction) {
  const types = ["hacking", "field", "security"];

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

/** @param {NS} ns */
function maybeInstall(ns) {
  const ownedWithPurchased = ns.singularity.getOwnedAugmentations(true);
  const ownedInstalled = ns.singularity.getOwnedAugmentations(false);
  const queued = ownedWithPurchased.length - ownedInstalled.length;

  const hasRedPill = ownedWithPurchased.includes("The Red Pill");
  const hasPriorityAug = INSTALL_PRIORITY_AUGS.some(
    a => ownedWithPurchased.includes(a) && !ownedInstalled.includes(a)
  );

  // All priority augs already installed — any single new aug is worth a reset
  // (price multiplier resets, so next aug is cheaper to sequence from scratch).
  const allPriorityDone = INSTALL_PRIORITY_AUGS.every(a => ownedInstalled.includes(a));
  const aggressiveInstall = allPriorityDone && queued >= 1;

  const lastReset = readLastResetTime(ns);
  const elapsed = Date.now() - lastReset;
  // Reduced from 16h → 8h: late-game aug prices compound fast, sooner resets win
  const TIME_TRIGGER_MS = 8 * 60 * 60 * 1_000;
  const timeTriggered = queued >= 1 && elapsed >= TIME_TRIGGER_MS;

  if (hasRedPill || queued >= 5 || (queued >= 2 && hasPriorityAug) || aggressiveInstall || timeTriggered) {
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
      s.getFactionRep(/** @type {any} */ (f)) >= s.getAugmentationRepReq("NeuroFlux Governor")
    ) ?? null;
    if (nfgFaction) {
      let bought = true;
      while (bought) {
        const price = s.getAugmentationPrice("NeuroFlux Governor");
        if (playerMoney(ns) < price) break;
        bought = s.purchaseAugmentation(/** @type {any} */ (nfgFaction), "NeuroFlux Governor");
      }
    }

    writeResetTime(ns);
    ns.singularity.installAugmentations(SELF);
  }
}

/** @param {NS} ns @param {any} target */
async function maybeBuyInfra(ns, target) {
  const money = playerMoney(ns);

  if (!target) {
    return await managePurchasedServers(ns, 10e6, 0.25);
  }

  const { price, moneyMissing = 0, repMissing = 0 } = target;

  if (repMissing > 0) {
    const hardCap = money > price ? money - price : money * 0.05;
    return await managePurchasedServers(ns, 50e6, 0.10, hardCap);
  }

  const tinyBudget = moneyMissing * 0.05;
  if (tinyBudget < 1e6) {
    return {
      action: "Saving for Aug",
      detail: `${target.aug}: need $${ns.format.number(moneyMissing)}`,
    };
  }
  return await managePurchasedServers(ns, price, 0.05, tinyBudget);
}

/**
 * When our primary goal doesn't need player focus, optionally bank rep with a
 * secondary faction that has augs we'll want later.
 * Returns a detail string if we started secondary work, null otherwise.
 * @param {NS} ns
 * @param {string} primaryFaction  - skip this faction (already working it)
 */
function maybeDoSecondaryFactionWork(ns, primaryFaction) {
  if (shouldFocus(ns)) return null; // can't background work

  const s = ns.singularity;
  const owned = new Set(s.getOwnedAugmentations(true));
  const joined = ns.getPlayer().factions ?? [];

  // Find a joined faction (other than primary) that still has augs we want,
  // and where we're missing rep. Prefer higher-priority factions.
  for (const factionName of joined) {
    if (factionName === primaryFaction) continue;

    const augs = s.getAugmentationsFromFaction(/** @type {any} */ (factionName));
    const currentRep = s.getFactionRep(/** @type {any} */ (factionName));

    const hasUsefulWork = augs.some(aug => {
      if (aug === "NeuroFlux Governor") return false;
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
          if (aug === "NeuroFlux Governor") return false;
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

  while (true) {
    // Root the network FIRST so the helpers below have off-home hosts to land
    // on, and buy port openers when affordable to unlock bigger servers.
    await acceptInvites(ns);
    await buyDarkweb(ns);
    rootEverything(ns);

    // Launch helpers off-home when possible (keeps scarce home RAM for the
    // daemon). Income manager first, then UI/luxury scripts.
    ensureHelper(ns, "/hacking/manager.js");
    ensureHelper(ns, "/ui/dashboard.js");
    ensureHelper(ns, "/lib/stocks.js", { optional: true });

    // Off-home helpers carrying this daemon's heaviest calls: backdoors + BN-finish
    // (backdoor.js gets the next BitNode + this daemon's path forwarded), and
    // hacknet/home-RAM spending (econ.js).
    ensureHelper(ns, BACKDOOR_SCRIPT, { args: [Number(ns.args[0] ?? 1), SELF] });
    ensureHelper(ns, ECON_SCRIPT, { optional: true });

    globalThis.gordState = await decideNextPriority(ns);

    const bought = buyAugs(ns);
    if (bought?.length) {
      globalThis.gordState.purchases = bought;
    }

    // Expose the full sorted candidate list for the dashboard's "pipeline" view.
    globalThis.gordAugPipeline = getAllAugCandidates(ns).slice(0, 10);

    maybeInstall(ns);

    ns.print(
      `Money: ${ns.format.number(playerMoney(ns))} | Hack: ${hackingLevel(ns)}`
    );
    await ns.sleep(15_000);
  }
}