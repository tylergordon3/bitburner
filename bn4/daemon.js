import { allServers, pathTo, root } from "../lib/net.js";
import { managePurchasedServers } from "../lib/pserv.js";
import {
  trainCombatIfNeeded,
  commitHomicideIfUseful,
  shouldFocus,
  doEarlyBootstrapIfNeeded,
} from "../lib/player-actions.js";
import { getNextAugTarget, FACTION_REQUIREMENTS } from "../lib/aug-targets.js";

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

function playerMoney(ns) {
  return ns.getPlayer().money ?? 0;
}

function hackingLevel(ns) {
  return ns.getPlayer().skills?.hacking ?? ns.getHackingLevel();
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

/** @param {NS} ns */
async function acceptInvites(ns) {
  for (const faction of ns.singularity.checkFactionInvitations()) {
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
    for (const hop of path.slice(1)) ns.singularity.connect(hop);

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

  // Buy cheapest first; NeuroFlux Governor always last (it inflates all prices).
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

// Augs that give hacking multipliers significant enough to justify an early install.
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

  if (hasRedPill || queued >= 5 || (queued >= 2 && hasPriorityAug)) {
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

/** @param {NS} ns @param {any} target */
async function maybeBuyInfra(ns, target) {
  const money = playerMoney(ns);

  // No aug target at all: spend freely (reserve a small emergency fund).
  if (!target) {
    return await managePurchasedServers(ns, 10e6, 0.25);
  }

  const { price, moneyMissing = 0, repMissing = 0 } = target;

  // Rep still needed: the hacking loop is our income engine, so infra is
  // worth buying — but never put the aug purchase at risk.
  // Allow up to 10% of spendable cash, capped so we always keep `price`
  // in reserve once we already have it.
  if (repMissing > 0) {
    // If we already have the full aug price saved, protect it entirely.
    const hardCap = money > price ? money - price : money * 0.05;
    return await managePurchasedServers(ns, 50e6, 0.10, hardCap);
  }

  // Rep done, money still needed: save aggressively.
  // Allow only very small opportunistic buys (never more than 5% of missing).
  const tinyBudget = moneyMissing * 0.05;
  if (tinyBudget < 1e6) {
    // So close — just save.
    return {
      action: "Saving for Aug",
      detail: `${target.aug}: need $${ns.format.number(moneyMissing)}`,
    };
  }
  return await managePurchasedServers(ns, price, 0.05, tinyBudget);
}

/** @param {NS} ns */
async function decideNextPriority(ns) {
  const bootstrap = await doEarlyBootstrapIfNeeded(ns);

  if (bootstrap) {
    return {
      ...bootstrap,
      target: null,
      infra: null,
    };
  }

  const target = getNextAugTarget(ns);

  // Buy infra AFTER we know the target so we can protect the aug budget.
  const infra = await maybeBuyInfra(ns, target);

  if (!target) {
    const crime = await commitHomicideIfUseful(ns, "no augmentation target / karma");
    return {
      action: crime ? "Crime" : "Idle",
      detail: crime ? "Homicide for karma" : "No augmentation target",
      target: null,
      infra,
    };
  }

  const statTargets = FACTION_REQUIREMENTS[target.faction] ?? {};
  const training = await trainCombatIfNeeded(ns, statTargets);
  if (training) {
    return { ...training, target, infra };
  }

  if (target.repMissing > 0) {
    const workType = startBestFactionWork(ns, target.faction);
    return {
      action: "Faction Rep",
      detail: `${target.faction} (${workType ?? "none"}) -> ${target.aug}`,
      target,
      infra,
    };
  }

  if (target.moneyMissing > 0) {
    // Rep is done; we just need cash. Best strategies in order:
    //
    // 1. Homicide (if chance >= 80%) — high yield crime.
    // 2. Faction work — earns rep we may want later AND lets the
    //    hacking loop run freely in the background (no focus conflict).
    // 3. Study Algorithms — grows hack level → bigger hacking income.
    //    Only fall here if there's no faction to work for.
    //
    // We deliberately never Mug: Mug earns ~$35k/crime and requires
    // focus, which blocks the hacking loop. Hacking earns far more.

    const homicide = await commitHomicideIfUseful(ns, `money for ${target.aug}`);
    if (homicide) {
      return { ...homicide, target, infra };
    }

    // Try to keep working for any joined faction to bank extra rep.
    const workType = startBestFactionWork(ns, target.faction);
    if (workType) {
      return {
        action: "Faction Work (saving)",
        detail: `${target.faction} (${workType}) | saving $${ns.format.number(target.moneyMissing)} for ${target.aug}`,
        target,
        infra,
      };
    }

    // No faction work available — study to grow hack income.
    ns.singularity.universityCourse(
      "Rothman University",
      /** @type {any} */ ("Algorithms"),
      shouldFocus(ns)
    );
    return {
      action: "Studying",
      detail: `Growing income for ${target.aug} ($${ns.format.number(target.moneyMissing)} needed)`,
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
  // ns.ui.openTail();

  while (true) {
    if (!ns.scriptRunning("/hacking/manager.js", "home")) {
      ns.run("/hacking/manager.js", 1);
    }

    if (!ns.scriptRunning("/ui/dashboard.js", "home")) {
      ns.run("/ui/dashboard.js", 1);
    }

    await acceptInvites(ns);
    await buyDarkweb(ns);
    rootEverything(ns);
    await backdoorTargets(ns);

    globalThis.gordState = await decideNextPriority(ns);

    const bought = buyAugs(ns);
    if (bought?.length) {
      globalThis.gordState.purchases = bought;
    }

    maybeInstall(ns);
    await maybeFinishBN(ns);

    ns.print(
      `Money: ${ns.format.number(playerMoney(ns))} | Hack: ${hackingLevel(ns)}`
    );
    await ns.sleep(30_000);
  }
}