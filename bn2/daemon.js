// bn2/daemon.js
//
// BN2 ("Rise of the Underworld") orchestrator. Same skeleton as bn4/daemon.js,
// with one big difference: in BN2 a gang can be created as soon as we can join
// a criminal faction (no -54k karma gate), and the gang faction sells nearly
// every augmentation in the game while its rep accrues passively from gang
// respect. So the top priority after the early bootstrap is: train combat to
// 30s -> crime to -9 karma + $1M -> join Slum Snakes -> createGang, then hand
// day-to-day gang management to /lib/gang.js (run wherever RAM allows).

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
  buyDarkweb,
  rootEverything,
  acceptInvites,
  canBuyAug,
  readLastResetTime,
  writeResetTime,
} from "../lib/daemon-lib.js";

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
const BACKDOOR_SCRIPT = CFG.paths.backdoor;   // server backdoors + finishing the BN
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
const GANG_SCRIPT = CFG.paths.gang;
// Dedicated cloud server for the gang manager, used only when home is too small
// to host it. Reserved from the botnet (via globalThis.gordReservedHosts,
// honoured by hacking/manager.js and lib/pserv.js) so its ~36GB stays free.
const GANG_HOST = GANG.host;
// Home must have at least (gang RAM + this) to host the gang itself, leaving
// room for the ~63GB daemon, the manager's reserve, and some botnet workers.
const HOME_GANG_HEADROOM = GANG.homeHeadroom;

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
    const crime = await commitBestCrimeIfUseful(ns, `karma ${karma.toFixed(1)}/${GANG_KARMA}`);
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

/**
 * Ensure a dedicated cloud server (GANG_HOST) exists and is big enough to hold
 * the gang manager. Purchased servers only come in powers of two, so we buy/
 * upgrade to the smallest power-of-two >= the gang's RAM. Spends conservatively
 * and never dips below the gang join-money floor. Returns true once GANG_HOST
 * exists at sufficient size.
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

  // This only runs once we're already in a gang, so don't reserve the gang
  // join-money here (that floor would keep us from ever buying the host at low
  // balances). Cap spend at half our cash so we don't drain funds needed for
  // augs/programs - the host gets bought as soon as it's comfortably affordable.
  const affordable = playerMoney(ns) * CFG.cloudHost.spendFraction;

  if (!exists) {
    // Need a free slot to add a dedicated host.
    if (cloud.getServerNames().length >= cloud.getServerLimit()) return false;
    if (cloud.getServerCost(size) > affordable) return false;
    if (cloud.purchaseServer(GANG_HOST, size)) {
      ns.tprint(`Provisioned dedicated gang host ${GANG_HOST} (${ns.format.ram(size)}).`);
      return true;
    }
    return false;
  }

  // Exists but too small - upgrade toward the required size.
  const cost = cloud.getServerUpgradeCost(GANG_HOST, size);
  if (cost < 0 || cost > affordable) return false;
  if (cloud.upgradeServer(GANG_HOST, size)) {
    ns.tprint(`Upgraded gang host ${GANG_HOST} -> ${ns.format.ram(size)}.`);
    return true;
  }
  return false;
}

/**
 * Keep /lib/gang.js (~36GB) running somewhere. Two strategies depending on home
 * size:
 *   - Home is big enough: reserve the gang's RAM out of home (the botnet honours
 *     globalThis.gordReservedRam and vacates that space within a batch or two),
 *     then run it on home. Free and immediate - no cloud server to buy.
 *   - Home is too small: provision a dedicated cloud server (GANG_HOST), reserve
 *     it whole from the botnet, and run it there.
 * Publishes globalThis.gordGangPending so the dashboard can show a "starting"
 * card during the short wait before it lands.
 * @param {NS} ns
 */
function ensureGangManagerRunning(ns) {
  if (!ns.gang.inGang()) {
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
    // Only keep a whole-host reservation for the dedicated cloud server; when it
    // runs on home/a shared server its RAM already shows as "used".
    globalThis.gordReservedHosts = running === GANG_HOST ? new Set([GANG_HOST]) : new Set();
    globalThis.gordReservedRam = {};
    return;
  }

  // Not running yet - pick a strategy and carve out room.
  const homeCanHost = ns.getServerMaxRam("home") >= ram + HOME_GANG_HEADROOM;
  let hosts;
  if (homeCanHost) {
    // Reserve room on home so the botnet frees space for the gang there.
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
    const headroom = host === "home" ? CFG.helpers.homeHeadroom : 0; // leave room for daemon children
    if (freeRam(ns, host) - headroom < ram) continue;
    // Copy the whole source tree, not just gang.js: it imports lib/config.js,
    // and Bitburner resolves a script's imports from the host it runs on.
    if (host !== "home") ns.scp(ns.ls("home", ".js"), host, "home");
    if (ns.exec(GANG_SCRIPT, host, 1)) {
      ns.tprint(`Started ${GANG_SCRIPT} on ${host}`);
      globalThis.gordGangPending = false;
      return;
    }
  }

  // Couldn't place it this tick - usually just waiting for the botnet's current
  // batches to finish and free the RAM we reserved on home.
  globalThis.gordGangPending = true;
  ns.print(`WARN: waiting for ${ns.format.ram(ram)} to free for ${GANG_SCRIPT} (home ${ns.format.ram(freeRam(ns, "home"))} free)`);
}

// ── Augs / install / infra (same as bn4) ─────────────────────────────────────

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
 * Same install policy as bn4. Resets are extra cheap in BN2 because the gang
 * (members, respect, territory) persists through augmentation installs - the
 * daemon just relaunches /lib/gang.js after boot.
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
 * secondary faction that has augs we'll want later.
 * @param {NS} ns
 * @param {string} primaryFaction
 */
function maybeDoSecondaryFactionWork(ns, primaryFaction) {
  if (shouldFocus(ns)) return null;

  const s = ns.singularity;
  const owned = new Set(s.getOwnedAugmentations(true));
  const joined = ns.getPlayer().factions ?? [];

  for (const factionName of joined) {
    if (factionName === primaryFaction) continue;
    if (factionName === GANG_FACTION) continue; // gang rep is passive

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
    const gangFaction = globalThis.gordGangState?.faction ?? GANG_FACTION;
    if (ns.gang.inGang() && target.faction === gangFaction) {
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

  while (true) {
    // Root the network FIRST so the helpers below have off-home hosts to land
    // on, and buy port openers when affordable to unlock bigger servers.
    await acceptInvites(ns);
    await buyDarkweb(ns);
    rootEverything(ns);

    // Launch helpers off-home (the ~63GB daemon fills home by itself). Order by
    // priority: gang first (it also reserves cloud-gang from the botnet), then
    // the hacking manager (our main income engine - starts earning on any 16GB
    // server, no port openers needed), then the UI/luxury scripts.
    ensureGangManagerRunning(ns);
    ensureHelper(ns, CFG.paths.manager);
    ensureHelper(ns, CFG.paths.dashboard);
    ensureHelper(ns, CFG.paths.stocks, { optional: true });

    // Off-home helpers carrying this daemon's heaviest calls: backdoors + BN-finish
    // (backdoor.js gets the next BitNode + this daemon's path forwarded), and
    // hacknet/home-RAM spending (econ.js). econ keeps the gang-join money free
    // while we're still bootstrapping toward the gang.
    ensureHelper(ns, BACKDOOR_SCRIPT, { args: [Number(ns.args[0] ?? CFG.backdoor.defaultNextBN), SELF] });
    ensureHelper(ns, ECON_SCRIPT, { optional: true, args: [GANG_JOIN_MONEY] });

    globalThis.gordState = await decideNextPriority(ns);

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
