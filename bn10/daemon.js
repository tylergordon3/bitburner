// bn10/daemon.js
//
// BN10 ("Digital Carbon") orchestrator. Same skeleton as the other per-node
// daemons (root the net, run the hacking botnet + helpers off-home, grind
// augs/factions, install, finish). BN10 has no punishing multiplier overrides -
// the ordinary economy runs like BN4 - so what makes this node different is one
// thing: duplicate SLEEVES.
//
// BN10 is the only place you can BUY extra sleeves and their memory, from The
// Covenant, and the whole value of sleeves is in their number + memory rather
// than in beating the node and moving on. So the plan (per the community wisdom
// this daemon encodes) is: build a THICK income stream the normal way, then buy
// EVERY sleeve The Covenant sells (the last costs ~1e20) and max memory (100) on
// each. That work is delegated to lib/sleeves.js, launched off-home here (it's
// ~40GB of ns.sleeve.* calls, far too heavy for home) and left running.
//
// Because that's a long, one-time shopping spree, this daemon deliberately does
// NOT auto-destroy w0r1d_d43m0n (plannedNextBN returns the halt sentinel):
// backdoor.js still backdoors everything, but you finish manually once the sleeve
// roster is complete (watch the SLEEVE dashboard tab). Pass a node number as
// arg[0] to override and auto-progress.

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
  getMoneyHoardGoal,
} from "../lib/aug-targets.js";
import { forNode } from "../lib/config.js";
// Shared daemon core (identical across bn2/bn3/bn4/bn5/bn10) - see lib/daemon-lib.js.
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
  recordResetSummary,
  consumeResetSummary,
} from "../lib/daemon-lib.js";
// Shared corporation orchestration (all corp-viable nodes) - see lib/corp-daemon.js.
import { maybeSetupCorp, ensureCorpManagers } from "../lib/corp-daemon.js";

// Every tunable value comes from lib/config.js, resolved for BitNode 10 (see
// BITNODE there - BN10 has no multiplier overrides, just its daemon path).
const CFG = forNode(10);
const AUGS = CFG.augs;
const FACTION_REQUIREMENTS = CFG.factions.requirements;

// Off-home helper scripts (shared by every daemon) that keep this daemon's HOME
// footprint small: each carries the expensive Singularity/Hacknet/Sleeve calls it
// needs, and running them off-home means those never count against the daemon's RAM.
const BACKDOOR_SCRIPT = CFG.paths.backdoor;   // server backdoors + finishing the BN
const ECON_SCRIPT = CFG.paths.econ;           // hacknet + home-RAM spending
const SLEEVE_SCRIPT = CFG.paths.sleeves;      // buy sleeves + memory, keep them working
const INFIL_SCRIPT = CFG.paths.infiltrate;    // DOM auto-solver for infiltration
const INFIL = CFG.infiltration;
const SELF = CFG.paths.daemon;                // this daemon's path (post-reset callback)

/**
 * True while the infiltration solver (lib/infiltrate.js) is mid-game. It publishes
 * globalThis.gordInfiltrating; when set we must NOT issue any player action
 * (gym/crime/faction/travel all cancel the mini-game), so the daemon yields.
 * @param {NS} ns
 */
function isInfiltrating(ns) {
  return INFIL.enabled && globalThis.gordInfiltrating === true;
}

/** True once the solver has ticked at least once (so starting a run is safe -
 * otherwise we'd navigate to an infiltration nothing is there to play). */
function infilSolverReady() {
  return typeof globalThis.gordInfiltrating === "boolean";
}

/**
 * Park the player on the infiltration location so the solver can click "Infiltrate
 * Company" and begin the next run. Travels to the target city first if needed.
 * Only used as an idle/saving activity; returns a status object, or null if we
 * can't act yet (can't afford the trip, or the solver isn't up).
 * @param {NS} ns
 */
function maybeStartInfiltration(ns) {
  if (!INFIL.enabled || !INFIL.autoStart || !infilSolverReady()) return null;

  const player = ns.getPlayer();
  if (player.city !== INFIL.city) {
    if (player.money < CFG.player.travelCost) return null;
    ns.singularity.travelToCity(/** @type {any} */ (INFIL.city));
    return { action: "Infiltrating", detail: `-> ${INFIL.city} for ${INFIL.location}` };
  }
  // Navigate to the company page; the solver clicks the Infiltrate button.
  ns.singularity.goToLocation(/** @type {any} */ (INFIL.location));
  return { action: "Infiltrating", detail: `${INFIL.location} (reward: ${INFIL.rewardMode})` };
}

/**
 * The BitNode to enter when lib/backdoor.js destroys w0r1d_d43m0n. Default is the
 * HALT sentinel (<= 0), which backdoor.js reads as "backdoor everything but DON'T
 * auto-destroy". That's the whole BN10 strategy: buying every sleeve + maxing
 * memory only happens in this node and takes a full run, so we stay and shop
 * rather than smashing the node and leaving. Finish manually once the SLEEVE tab
 * shows the roster complete. An explicit daemon arg ([0]) overrides (e.g.
 * `run bn10/daemon.js 10` to auto-re-enter BN10). getResetInfo() is free (0GB).
 * @param {NS} ns
 */
function plannedNextBN(ns) {
  if (ns.args[0] != null) return Number(ns.args[0]);
  return 0; // halt: let the player finish manually after the sleeve shopping spree
}

/** @param {NS} ns */
function buyAugs(ns) {
  const s = ns.singularity;
  const owned = new Set(s.getOwnedAugmentations(true));
  const joined = ns.getPlayer().factions ?? [];
  // While hoarding cash for a money-gated invite, never spend below the floor.
  const floor = globalThis.gordMoneyFloor ?? 0;

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
    if (canBuyAug(ns, c.faction, c.aug, owned) && playerMoney(ns) - c.price >= floor) {
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

/** @param {NS} ns */
function maybeInstall(ns) {
  // While hoarding for a money-gated invite, do NOT install: an install soft-resets
  // and drops our skills below the invite's skill gates (which we've just met), and
  // the pre-install NeuroFlux dump would spend the cash we're trying to hold.
  if ((globalThis.gordMoneyFloor ?? 0) > 0) return;

  const ownedWithPurchased = ns.singularity.getOwnedAugmentations(true);
  const ownedInstalled = ns.singularity.getOwnedAugmentations(false);
  const queued = ownedWithPurchased.length - ownedInstalled.length;

  const hasRedPill = ownedWithPurchased.includes(AUGS.redPill);
  const hasPriorityAug = INSTALL_PRIORITY_AUGS.some(
    a => ownedWithPurchased.includes(a) && !ownedInstalled.includes(a)
  );

  // All priority augs already installed — any single new aug is worth a reset
  // (price multiplier resets, so next aug is cheaper to sequence from scratch).
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

  // Hoarding for a money-gated invite: hold cash, don't buy servers.
  if ((globalThis.gordMoneyFloor ?? 0) > 0) {
    return { action: "Holding Cash", detail: "servers paused - saving for a faction invite" };
  }

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
 * secondary faction that has augs we'll want later.
 * @param {NS} ns @param {string} primaryFaction - skip this faction (already working it)
 */
function maybeDoSecondaryFactionWork(ns, primaryFaction) {
  if (shouldFocus(ns)) return null; // can't background work

  const s = ns.singularity;
  const owned = new Set(s.getOwnedAugmentations(true));
  const joined = ns.getPlayer().factions ?? [];

  for (const factionName of joined) {
    if (factionName === primaryFaction) continue;

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

  // Yield the player entirely while an infiltration mini-game is on screen: any
  // gym/crime/faction/travel call below would cancel it. The solver handles the
  // whole run + reward; we resume next tick once gordInfiltrating clears.
  if (isInfiltrating(ns)) {
    return { action: "Infiltrating", detail: "solving mini-game (player yielded)", target: null, infra: null };
  }

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

  // Money-gated endgame invites (Daedalus / The Covenant / Illuminati, ...): when
  // we've met every requirement EXCEPT the big cash gate, hold cash instead of
  // spending it away before the invite can fire. gordMoneyFloor is respected by
  // buyAugs, maybeInstall, maybeBuyInfra here and by the sleeve manager off-home.
  // Only considered when there's no ordinary aug target left (i.e. "out of factions").
  const hoard = target ? null : getMoneyHoardGoal(ns);
  globalThis.gordMoneyFloor = hoard ? hoard.money : 0;

  const infra  = await maybeBuyInfra(ns, target);

  // No aug target
  if (!target) {
    // Prefix surfacing the money-hoard, if one is active, so it's visible whatever
    // income activity we run underneath (spending is already blocked by the floor).
    const held = hoard
      ? `[holding $${ns.format.number(hoard.money)} for ${hoard.faction} invite, $${ns.format.number(hoard.moneyMissing)} to go] `
      : "";

    const factionPursuit = await maybePursueNextFaction(ns, opportunities, true);
    if (factionPursuit) {
      // Company Work actually issues workForCompany; doIdleWork's crime would
      // cancel it (and crime earns no company rep), so return it directly. Other
      // pursuits (city/combat) are directional - doIdleWork does the real income
      // work toward them.
      if (factionPursuit.action === "Company Work") {
        return { ...factionPursuit, detail: held + factionPursuit.detail, target: null, infra };
      }
      const moneyGoal = factionPursuit.joinMoneyMissing
        ? playerMoney(ns) + factionPursuit.joinMoneyMissing
        : 0;
      const idle = await doIdleWork(ns, moneyGoal);
      return { ...factionPursuit, ...idle, detail: held + factionPursuit.detail, target: null, infra };
    }

    // Genuinely out of faction work -> infiltrate for money (+rep) if enabled,
    // else fall back to ordinary idle work (crime/study/rep-banking). Both earn
    // toward the hoard while the money floor stops us spending it away.
    const infil = maybeStartInfiltration(ns);
    const base = infil ?? (await doIdleWork(ns));
    if (hoard) {
      return {
        action: "Saving for Faction",
        detail: `${hoard.faction} invite: hold $${ns.format.number(hoard.money)} (need $${ns.format.number(hoard.moneyMissing)} more) | earning via ${base.action}`,
        target: null,
        infra,
      };
    }
    return { ...base, target: null, infra };
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

    // Focus mode, rep already met - money is the only gate. Infiltration is the
    // best focused money source here (also faction rep if rewardMode=="rep"), so
    // prefer it; otherwise crime. Sleeves keep criming in the background either way.
    const infil = maybeStartInfiltration(ns);
    if (infil) {
      return { ...infil, detail: `${infil.detail} | saving for ${target.aug}`, target, infra };
    }

    const crime = await commitBestCrimeIfUseful(ns, `$${ns.format.number(target.moneyMissing)} for ${target.aug}`);
    if (crime) {
      return { ...crime, target, infra };
    }

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

    // The BN10 headline act: the sleeve manager (buy every sleeve + max memory +
    // keep them working). It's ~40GB of ns.sleeve.* calls, so it runs off-home
    // like the gang manager; ensureHelper places it on the roomiest rooted host.
    // Launched first so it can claim RAM before the botnet fills the network.
    // Early on there may be no host with room - it simply starts later, once the
    // network (and our cash) have grown enough for sleeves to matter anyway.
    ensureHelper(ns, SLEEVE_SCRIPT);

    // Infiltration auto-solver (DOM automation). Optional/off-home; it sits idle
    // until the daemon parks us on a company page (maybeStartInfiltration), then
    // plays the mini-game and publishes gordInfiltrating so we yield the player.
    if (INFIL.enabled) ensureHelper(ns, INFIL_SCRIPT, { optional: true });

    // Corporation (now that we have corp API access everywhere): keep the one-shot
    // creator running until a corp exists (self-funded + affordability-gated), then
    // keep its managers on the reserved cloud-corp host. Self-gates on
    // corp.enabled / affordability, so it's a quiet no-op until we can fund it.
    const corpEvent = maybeSetupCorp(ns);
    ensureCorpManagers(ns, new Set());

    // Botnet income engine, then UI/luxury scripts, all off-home.
    ensureHelper(ns, CFG.paths.manager);
    ensureHelper(ns, CFG.paths.dashboard);
    ensureHelper(ns, CFG.paths.stocks, { optional: true });

    // Off-home helpers carrying this daemon's heaviest calls: backdoors + BN-finish
    // (nextBN defaults to the halt sentinel - see plannedNextBN; no cbScript arg,
    // so backdoor.js defaults it to the cold-start driver), and hacknet/home-RAM
    // spending (econ.js).
    ensureHelper(ns, BACKDOOR_SCRIPT, { args: [plannedNextBN(ns)] });
    ensureHelper(ns, ECON_SCRIPT, { optional: true });

    globalThis.gordState = await decideNextPriority(ns);
    if (corpEvent) globalThis.gordState = { ...globalThis.gordState, ...corpEvent };

    // Publish the company-grind city intent so maybeAutoTravelForReadyFaction won't
    // pull us home while we're deliberately parked in a megacorp's city for its rep
    // (only meaningful when companyWorkNeedsCity is on). Cleared on any other action.
    globalThis.gordCompanyCity = globalThis.gordState?.action === "Company Work"
      ? globalThis.gordState.companyCity ?? null
      : null;

    const bought = buyAugs(ns);
    if (bought?.length) {
      globalThis.gordState.purchases = bought;
    }

    globalThis.gordAugPipeline = getAllAugCandidates(ns).slice(0, AUGS.pipelineSize);

    maybeInstall(ns);

    const sleeves = globalThis.gordSleeveState;
    const sleeveNote = sleeves
      ? ` | Sleeves: ${sleeves.count}${sleeves.maxed ? " (max)" : ""}`
      : "";
    ns.print(
      `Money: ${ns.format.number(playerMoney(ns))} | Hack: ${hackingLevel(ns)}${sleeveNote}`
    );
    await ns.sleep(CFG.daemon.tickMs);
  }
}
