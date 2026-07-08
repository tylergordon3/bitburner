import { allServers, pathTo, root } from "../lib/net.js";
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
  shouldJoinCityFaction,
} from "../lib/aug-targets.js";

const PROGRAMS = [
  "BruteSSH.exe",
  "FTPCrack.exe",
  "relaySMTP.exe",
  "HTTPWorm.exe",
  "SQLInject.exe",
];

const BACKDOOR_PRIORITY = [
  "CSEC",
  "avmnite-02h",
  "I.I.I.I",
  "run4theh111z",
  "The-Cave",
  "w0r1d_d43m0n",
];

const RESET_FILE = "/data/last-reset.txt";
const RESET_AFTER_MS = 16 * 60 * 60 * 1_000; // 16 hours

function playerMoney(ns) {
  return ns.getPlayer().money ?? 0;
}

function hackingLevel(ns) {
  return ns.getPlayer().skills?.hacking ?? ns.getHackingLevel();
}

/** @param {NS} ns @param {string} host */
function freeRam(ns, host) {
  return ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
}

/**
 * Ensure a persistent helper is running SOMEWHERE with enough RAM - not just on
 * home. globalThis is shared across every host in Bitburner, so these helpers
 * work fine on any rooted server; running them off-home keeps scarce home RAM
 * for the daemon. We prefer the roomiest off-home host and only fall back to
 * home as a last resort. Warns (doesn't fail silently) when nothing has room,
 * unless { optional: true } is passed (luxury scripts wait quietly for RAM).
 * @param {NS} ns @param {string} script @param {{optional?: boolean}} [opts]
 */
function ensureHelper(ns, script, opts = {}) {
  // Already running anywhere (home included)? Leave it be.
  if (allServers(ns).some(h => ns.hasRootAccess(h) && ns.scriptRunning(script, h))) return;

  const ram = ns.getScriptRam(script, "home");
  const reserved = globalThis.gordReservedHosts instanceof Set ? globalThis.gordReservedHosts : new Set();

  // Roomiest rooted non-home host first; home last (keep it for the daemon).
  const offHome = allServers(ns)
    .filter(s => s !== "home" && ns.hasRootAccess(s) && ns.getServerMaxRam(s) > 0 && !reserved.has(s))
    .sort((a, b) => freeRam(ns, b) - freeRam(ns, a));

  for (const host of [...offHome, "home"]) {
    const headroom = host === "home" ? 8 : 0; // leave room for the daemon's own work
    if (freeRam(ns, host) - headroom < ram) continue;
    // Copy every source file, not just the entry script: Bitburner resolves a
    // script's imports from the host it runs on, so the whole module closure has
    // to be present. Files cost no RAM, so shipping them all is simplest/safest.
    if (host !== "home") ns.scp(ns.ls("home", ".js"), host, "home");
    if (ns.exec(script, host, 1)) {
      ns.print(`Started ${script} on ${host}`);
      return;
    }
  }

  if (!opts.optional) {
    ns.print(`WARN: no host has ${ns.format.ram(ram)} free for ${script} (home ${ns.format.ram(freeRam(ns, "home"))} free)`);
  }
}

/** @param {NS} ns */
async function buyDarkweb(ns) {
  const s = ns.singularity;

  if (!ns.hasTorRouter()) {
    if (playerMoney(ns) >= 200_000) s.purchaseTor();
    return;
  }

  for (const p of PROGRAMS) {
    if (!ns.fileExists(p, "home")) {
      const cost = s.getDarkwebProgramCost(/** @type {any} */ (p));
      if (cost > 0 && playerMoney(ns) >= cost) s.purchaseProgram(/** @type {any} */ (p));
    }
  }
}

/** @param {NS} ns */
function rootEverything(ns) {
  for (const server of allServers(ns)) {
    if (server !== "home") {
      try { root(ns, server); } catch {}
    }
  }
}

/**
 * Accept all pending faction invites, except city factions we should defer
 * (see shouldJoinCityFaction) - joining one permanently bans its enemy city
 * factions for the rest of the run, so we don't want to burn that on a city
 * whose augs we already have while other city factions still have augs to give.
 * @param {NS} ns
 */
async function acceptInvites(ns) {
  for (const faction of ns.singularity.checkFactionInvitations()) {
    if (!shouldJoinCityFaction(ns, faction)) continue;
    ns.singularity.joinFaction(/** @type {any} */ (faction));
  }
}

/** @param {NS} ns */
async function backdoorTargets(ns) {
  for (const server of BACKDOOR_PRIORITY) {
    if (!ns.serverExists(server)) continue;
    const info = ns.getServer(server);
    if (info.backdoorInstalled) continue;
    if (!ns.hasRootAccess(server)) continue;
    if (hackingLevel(ns) < ns.getServerRequiredHackingLevel(server)) continue;

    const path = pathTo(ns, server);
    if (!path.length) continue;

    ns.singularity.connect("home");
    let connected = true;
    for (const hop of path.slice(1)) {
      if (!ns.singularity.connect(hop)) {
        connected = false;
        break;
      }
    }

    if (!connected) {
      ns.singularity.connect("home");
      continue;
    }

    ns.tprint(`Installing backdoor on ${server}...`);
    await ns.singularity.installBackdoor();
    ns.singularity.connect("home");
  }
}

/** @param {NS} ns */
function canBuyAug(ns, faction, aug, owned) {
  const s = ns.singularity;
  if (owned.has(aug)) return false;

  const prereqs = s.getAugmentationPrereq(aug);
  if (!prereqs.every(a => owned.has(a))) return false;

  return (
    s.getFactionRep(/** @type {any} */ (faction)) >= s.getAugmentationRepReq(aug) &&
    playerMoney(ns) >= s.getAugmentationPrice(aug)
  );
}

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
function readLastResetTime(ns) {
  try {
    const raw = ns.read(RESET_FILE);
    const t = Number(raw);
    return isNaN(t) ? 0 : t;
  } catch {
    return 0;
  }
}

/** @param {NS} ns */
function writeResetTime(ns) {
  ns.write(RESET_FILE, String(Date.now()), "w");
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
    ns.singularity.installAugmentations("/bn4/daemon.js");
  }
}

/** @param {NS} ns */
async function maybeFinishBN(ns) {
  const target = "w0r1d_d43m0n";
  if (!ns.serverExists(target)) return;

  root(ns, target);

  const server = ns.getServer(target);
  if (!server.backdoorInstalled) return;
  if (hackingLevel(ns) < ns.getServerRequiredHackingLevel(target)) return;

  const nextBN = Number(ns.args[0] ?? 1);
  ns.tprint(`Destroying w0r1d_d43m0n. Next BitNode: ${nextBN}`);
  ns.singularity.destroyW0r1dD43m0n(nextBN, "/bn4/daemon.js");
}

/**
 * Fix #10: Buy/upgrade hacknet nodes cheaply during early game.
 * Past hacking level 200, purchased servers dominate and this becomes a no-op.
 * @param {NS} ns
 */
function maybeSpendOnHacknet(ns) {
  if (hackingLevel(ns) > 200) return;

  const hn = ns.hacknet;
  const totalBudget = playerMoney(ns) * 0.20;
  if (totalBudget < 1_000) return;

  let spent = 0;

  // Loop until we've exhausted the budget or nothing is affordable
  while (true) {
    const remaining = totalBudget - spent;
    if (remaining < 1_000) break;

    const nodeCount = hn.numNodes();
    let bestCost = Infinity;
    let bestAction = null;

    // Buy a new node if under cap
    if (nodeCount < 8) {
      const cost = hn.getPurchaseNodeCost();
      if (cost > 0 && cost < bestCost && cost <= remaining) {
        bestCost = cost;
        bestAction = () => { hn.purchaseNode(); return cost; };
      }
    }

    // Check all upgrades across existing nodes
    for (let i = 0; i < nodeCount; i++) {
      const lvlCost  = hn.getLevelUpgradeCost(i, 1);
      const ramCost  = hn.getRamUpgradeCost(i, 1);
      const coreCost = hn.getCoreUpgradeCost(i, 1);

      if (lvlCost  > 0 && lvlCost  < bestCost && lvlCost  <= remaining) { bestCost = lvlCost;  bestAction = () => { hn.upgradeLevel(i, 1); return lvlCost; }; }
      if (ramCost  > 0 && ramCost  < bestCost && ramCost  <= remaining) { bestCost = ramCost;  bestAction = () => { hn.upgradeRam(i, 1);   return ramCost; }; }
      if (coreCost > 0 && coreCost < bestCost && coreCost <= remaining) { bestCost = coreCost; bestAction = () => { hn.upgradeCore(i, 1);  return coreCost; }; }
    }

    if (!bestAction) break;
    spent += bestAction();
  }
}

/** @param {NS} ns @param {any} target */
async function maybeBuyInfra(ns, target) {
  const money = playerMoney(ns);

  // Fix #10: spend on hacknet while hacking income is minimal
  maybeSpendOnHacknet(ns);

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

    await backdoorTargets(ns);

    globalThis.gordState = await decideNextPriority(ns);

    const bought = buyAugs(ns);
    if (bought?.length) {
      globalThis.gordState.purchases = bought;
    }

    // Expose the full sorted candidate list for the dashboard's "pipeline" view.
    globalThis.gordAugPipeline = getAllAugCandidates(ns).slice(0, 10);

    maybeInstall(ns);
    await maybeFinishBN(ns);

    ns.print(
      `Money: ${ns.format.number(playerMoney(ns))} | Hack: ${hackingLevel(ns)}`
    );
    await ns.sleep(15_000);
  }
}