import { allServers, pathTo, root } from "../lib/net.js";
import { managePurchasedServers } from "../lib/pserv.js";
import { trainCombatIfNeeded, commitHomicideIfUseful, shouldFocus } from "../lib/player-actions.js";
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

const FACTION_PRIORITY = /** @type {string[]} */ ([
  "CyberSec",
  "NiteSec",
  "The Black Hand",
  "BitRunners",
  "Daedalus",
]);

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
    await ns.singularity.installBackdoor(); // async Promise API
    ns.singularity.connect("home");
  }
}

/** @param {NS} ns */
function chooseFactionWork(ns) {
  const s = ns.singularity;
  const joined = ns.getPlayer().factions ?? [];
  const owned = new Set(s.getOwnedAugmentations(true));

  const options = [];

  for (const faction of joined) {
    for (const aug of s.getAugmentationsFromFaction(/** @type {any} */ (faction))) {
      if (owned.has(aug)) continue;

      const prereqs = s.getAugmentationPrereq(aug);
      if (!prereqs.every(a => owned.has(a))) continue;

      const repNeeded = s.getAugmentationRepReq(aug);
      const curRep = s.getFactionRep(/** @type {any} */ (faction));

      if (curRep >= repNeeded) continue;

      options.push({
        faction,
        aug,
        repMissing: repNeeded - curRep,
        repNeeded,
        price: s.getAugmentationPrice(aug),
      });
    }
  }

  options.sort((a, b) => {
    const aPriority = FACTION_PRIORITY.indexOf(a.faction);
    const bPriority = FACTION_PRIORITY.indexOf(b.faction);

    const ap = aPriority === -1 ? 999 : aPriority;
    const bp = bPriority === -1 ? 999 : bPriority;

    if (ap !== bp) return ap - bp;
    return a.repMissing - b.repMissing;
  });

  return options[0]?.faction ?? joined[0] ?? null;
}

/** @param {NS} ns */
function workForRep(ns) {
  const faction = chooseFactionWork(ns);
  if (!faction) return;

  const cur = ns.singularity.getCurrentWork();
  if (cur?.type === "FACTION" && cur?.factionName === faction) return;

  ns.singularity.workForFaction(
  /** @type {any} */ (faction),
      "hacking",
      false
    );
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

  candidates.sort((a, b) => a.price - b.price);

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

/** @param {NS} ns */
function maybeInstall(ns) {
  const ownedWithPurchased = ns.singularity.getOwnedAugmentations(true);
  const ownedInstalled = ns.singularity.getOwnedAugmentations(false);
  const queued = ownedWithPurchased.length - ownedInstalled.length;

  if (queued >= 5 || ownedWithPurchased.includes("The Red Pill")) {
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

/** @param {NS} ns */
async function decideNextPriority(ns) {
  const target = getNextAugTarget(ns);
  const infra = await maybeBuyInfra(ns, target);

  if (!target) {
    const crime = await commitHomicideIfUseful(
      ns,
      "no augmentation target / karma"
    );

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
    return {
      ...training,
      target,
      infra,
    };
  }

  if (target.repMissing > 0) {
    ns.singularity.workForFaction(
      /** @type {any} */ (target.faction),
      /** @type {any} */ ("hacking"),
      shouldFocus(ns)
    );

    return {
      action: "Faction Rep",
      detail: `${target.faction} -> ${target.aug}`,
      target,
      infra,
    };
  }

  if (target.moneyMissing > 0) {
    const crime = await commitHomicideIfUseful(
      ns,
      `money for ${target.aug}`
    );

    if (crime) {
      return {
        ...crime,
        target,
        infra,
      };
    }

    ns.singularity.commitCrime(
      /** @type {any} */ ("Mug"),
      shouldFocus(ns)
    );

    return {
      action: "Crime",
      detail: `Mug for money: ${target.aug}`,
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

/** @param {NS} ns @param {any} target */
async function maybeBuyInfra(ns, target) {
  const money = playerMoney(ns);

  // No aug target: infrastructure is useful.
  if (!target) {
    return await managePurchasedServers(ns, 10e6);
  }

  // If rep is done and money is close, save for aug.
  if (target.repMissing <= 0) {
    const missing = target.moneyMissing ?? 0;

    // Close = within 30 minutes of reasonable hacking income OR within 25% of price.
    const closeByCash = money >= target.price * 0.75;
    const smallMissing = missing <= 25e6;

    if (closeByCash || smallMissing) {
      return {
        action: "Saving for Aug",
        detail: `${target.aug}: need $${ns.format.number(missing)}`,
      };
    }
  }

  // If still farming rep, allow small cloud buys only.
  if (target.repMissing > 0) {
    return await managePurchasedServers(ns, 50e6, 0.10);
  }

  // If money missing is large, allow moderate infra.
  return await managePurchasedServers(ns, 25e6, 0.15);
}