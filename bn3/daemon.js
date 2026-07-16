// bn3/daemon.js
//
// BN3 ("Corporatocracy") orchestrator. Same skeleton as bn4/daemon.js (root the
// net, run the hacking botnet + helpers off-home, grind augs/factions, install,
// finish), with BN3's defining mechanic bolted on: a CORPORATION.
//
// The corporation is the income engine here. The daemon owns corp *creation*
// (one free, seed-funded call in BN3) exactly like the BN2 daemon owns gang
// creation; day-to-day play is handed to /lib/corp.js, which - being far too
// RAM-heavy to co-host with this daemon - runs on a dedicated cloud server.
//
// Gangs still feature, but unlike BN2 there's no early-gang shortcut: forming
// one needs -54,000 karma (SF2 lets us do it here at all). We don't grind crime
// toward that; instead crime we already do while saving for augs trends karma
// down, and the moment it crosses the gate we snap up a gang for free. Both the
// corp and the gang PERSIST through augmentation installs, so their managers
// simply resume after each reset.

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

// ── Corporation ───────────────────────────────────────────────────────────────
const CORP_NAME = "GordCorp";
const CORP_SCRIPT = "/lib/corp.js";
// Dedicated cloud server for the corp manager (it's too RAM-heavy to share home
// with the daemon). Reserved from the botnet via globalThis.gordReservedHosts.
const CORP_HOST = "cloud-corp";

// ── Gang (late-game, -54k karma) ──────────────────────────────────────────────
const GANG_KARMA = -54_000;
const GANG_SCRIPT = "/lib/gang.js";
const GANG_HOST = "cloud-gang";
// Criminal factions that can found a gang; whichever we're already in is used.
// Cast to any[] so its elements don't trip checkJs against FactionName (a plain
// `string` isn't assignable to the union) - see [[bitburner-enum-string-casts]].
const CRIMINAL_FACTIONS = /** @type {any[]} */ ([
  "Slum Snakes",
  "Tetrads",
  "The Syndicate",
  "The Dark Army",
  "Speakers for the Dead",
]);

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

/** @param {NS} ns - true if we're in a gang; false (not just missing API) otherwise. */
function inGangSafe(ns) {
  try {
    return ns.gang.inGang();
  } catch {
    return false;
  }
}

/**
 * Ensure a persistent helper is running SOMEWHERE with enough RAM - not just on
 * home. globalThis is shared across every host in Bitburner, so these helpers
 * work fine on any rooted server; running them off-home keeps scarce home RAM
 * for the daemon. Warns (doesn't fail silently) when nothing has room, unless
 * { optional: true } is passed (luxury scripts wait quietly for RAM).
 * @param {NS} ns @param {string} script @param {{optional?: boolean}} [opts]
 */
function ensureHelper(ns, script, opts = {}) {
  if (allServers(ns).some(h => ns.hasRootAccess(h) && ns.scriptRunning(script, h))) return;

  const ram = ns.getScriptRam(script, "home");
  const reserved = globalThis.gordReservedHosts instanceof Set ? globalThis.gordReservedHosts : new Set();

  const offHome = allServers(ns)
    .filter(s => s !== "home" && ns.hasRootAccess(s) && ns.getServerMaxRam(s) > 0 && !reserved.has(s))
    .sort((a, b) => freeRam(ns, b) - freeRam(ns, a));

  for (const host of [...offHome, "home"]) {
    const headroom = host === "home" ? 8 : 0;
    if (freeRam(ns, host) - headroom < ram) continue;
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
 * (see shouldJoinCityFaction). This also picks up criminal-faction invites,
 * which is what lets maybeSetupGang found a gang once karma is deep enough.
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

// ── Corporation setup ─────────────────────────────────────────────────────────

/**
 * Create the corporation as soon as we can. In BN3 the seed-funded path is free,
 * so this fires almost immediately; the self-funded ($150b) path is only a
 * fallback for the theoretically-impossible case where seed funding is blocked.
 * Returns a status object the first time it creates the corp, else null.
 * @param {NS} ns
 */
function maybeSetupCorp(ns) {
  if (ns.corporation.hasCorporation()) return null;

  if (ns.corporation.canCreateCorporation(false) === "Success") {
    if (ns.corporation.createCorporation(CORP_NAME, false)) {
      ns.tprint(`Created corporation ${CORP_NAME} (seed funded).`);
      return { action: "Corp Created", detail: CORP_NAME };
    }
  }

  if (ns.corporation.canCreateCorporation(true) === "Success" && playerMoney(ns) >= 150e9) {
    if (ns.corporation.createCorporation(CORP_NAME, true)) {
      ns.tprint(`Created corporation ${CORP_NAME} (self funded).`);
      return { action: "Corp Created", detail: `${CORP_NAME} (self-funded)` };
    }
  }

  return null;
}

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
 * Buy/upgrade a dedicated cloud server to at least `needRam` (rounded up to the
 * next power of two, since purchased servers only come in those sizes). Spends
 * conservatively - at most half our cash - so it never starves aug/program buys.
 * Returns true once the host exists at sufficient size.
 * @param {NS} ns
 */
function provisionCloudHost(ns, name, needRam) {
  const cloud = ns.cloud;
  if (cloud.getServerLimit() <= 0) return false;

  const maxRam = cloud.getRamLimit();
  let size = 2;
  while (size < needRam && size < maxRam) size *= 2;
  if (size < needRam) return false; // even the largest tier can't hold it

  const exists = ns.serverExists(name);
  if (exists && ns.getServerMaxRam(name) >= needRam) return true;

  const budget = playerMoney(ns) * 0.5;

  if (!exists) {
    if (cloud.getServerNames().length >= cloud.getServerLimit()) return false;
    if (cloud.getServerCost(size) > budget) return false;
    if (cloud.purchaseServer(name, size)) {
      ns.tprint(`Provisioned ${name} (${ns.format.ram(size)}).`);
      return true;
    }
    return false;
  }

  const cost = cloud.getServerUpgradeCost(name, size);
  if (cost < 0 || cost > budget) return false;
  if (cloud.upgradeServer(name, size)) {
    ns.tprint(`Upgraded ${name} -> ${ns.format.ram(size)}.`);
    return true;
  }
  return false;
}

/**
 * Place one big, persistent manager (corp or gang). If it's already running
 * anywhere, just note whether it's on its dedicated host (so we can reserve it
 * from the botnet). Otherwise provision the dedicated cloud host and launch it
 * there, falling back to the roomiest off-home host, then home. Adds the
 * dedicated host to `reserved` whenever the manager lives on it.
 * @param {NS} ns @param {Set<string>} reserved
 */
function placeManager(ns, script, dedicatedHost, reserved) {
  const ram = ns.getScriptRam(script, "home");

  const running = allServers(ns).find(h => ns.hasRootAccess(h) && ns.scriptRunning(script, h));
  if (running) {
    if (running === dedicatedHost) reserved.add(dedicatedHost);
    return;
  }

  provisionCloudHost(ns, dedicatedHost, ram);

  const offHome = allServers(ns)
    .filter(s => s !== "home" && s !== dedicatedHost && ns.hasRootAccess(s) && ns.getServerMaxRam(s) > 0 && !reserved.has(s))
    .sort((a, b) => freeRam(ns, b) - freeRam(ns, a));

  const candidates = [];
  if (ns.serverExists(dedicatedHost)) candidates.push(dedicatedHost);
  candidates.push(...offHome, "home");

  for (const host of candidates) {
    const headroom = host === "home" ? 8 : 0;
    if (freeRam(ns, host) - headroom < ram) continue;
    if (host !== "home") ns.scp(ns.ls("home", ".js"), host, "home");
    if (ns.exec(script, host, 1)) {
      if (host === dedicatedHost) reserved.add(dedicatedHost);
      ns.print(`Started ${script} on ${host}`);
      return;
    }
  }

  ns.print(`WARN: waiting for ${ns.format.ram(ram)} to place ${script}`);
}

/**
 * Keep the corp and gang managers running on their dedicated cloud hosts and
 * publish the combined botnet reservation so hacking/manager.js and pserv.js
 * leave those hosts alone. Rebuilt fresh each tick so a reset/relaunch heals it.
 * @param {NS} ns
 */
function ensureCloudManagers(ns) {
  const reserved = new Set();

  if (ns.corporation.hasCorporation()) {
    placeManager(ns, CORP_SCRIPT, CORP_HOST, reserved);
    globalThis.gordCorpPending = !allServers(ns).some(h => ns.hasRootAccess(h) && ns.scriptRunning(CORP_SCRIPT, h));
  } else {
    globalThis.gordCorpPending = false;
  }

  if (inGangSafe(ns)) {
    placeManager(ns, GANG_SCRIPT, GANG_HOST, reserved);
  }

  globalThis.gordReservedHosts = reserved;
  globalThis.gordReservedRam = {};
}

// ── Augs / install / infra (same policy as bn4) ──────────────────────────────

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

  const hasRedPill = ownedWithPurchased.includes("The Red Pill");
  const hasPriorityAug = INSTALL_PRIORITY_AUGS.some(
    a => ownedWithPurchased.includes(a) && !ownedInstalled.includes(a)
  );

  const allPriorityDone = INSTALL_PRIORITY_AUGS.every(a => ownedInstalled.includes(a));
  const aggressiveInstall = allPriorityDone && queued >= 1;

  const lastReset = readLastResetTime(ns);
  const elapsed = Date.now() - lastReset;
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
    ns.singularity.installAugmentations("/bn3/daemon.js");
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
  ns.singularity.destroyW0r1dD43m0n(nextBN, "/bn3/daemon.js");
}

/** @param {NS} ns */
function maybeSpendOnHacknet(ns) {
  if (hackingLevel(ns) > 200) return;

  const hn = ns.hacknet;
  const totalBudget = playerMoney(ns) * 0.20;
  if (totalBudget < 1_000) return;

  let spent = 0;
  while (true) {
    const remaining = totalBudget - spent;
    if (remaining < 1_000) break;

    const nodeCount = hn.numNodes();
    let bestCost = Infinity;
    let bestAction = null;

    if (nodeCount < 8) {
      const cost = hn.getPurchaseNodeCost();
      if (cost > 0 && cost < bestCost && cost <= remaining) {
        bestCost = cost;
        bestAction = () => { hn.purchaseNode(); return cost; };
      }
    }

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

/**
 * Upgrade home RAM when comfortably affordable. Keeps the botnet growing and
 * gives the cloud managers a home to fall back to if cloud servers are tight.
 * @param {NS} ns
 */
function maybeUpgradeHomeRam(ns) {
  const s = ns.singularity;
  const cost = s.getUpgradeHomeRamCost();
  const money = playerMoney(ns);
  if (cost <= 0 || !isFinite(cost)) return;
  if (cost <= money * 0.4) s.upgradeHomeRam();
}

/** @param {NS} ns @param {any} target */
async function maybeBuyInfra(ns, target) {
  const money = playerMoney(ns);

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
    ensureHelper(ns, "/hacking/manager.js");
    ensureHelper(ns, "/ui/dashboard.js");
    ensureHelper(ns, "/lib/stocks.js", { optional: true });

    await backdoorTargets(ns);
    maybeUpgradeHomeRam(ns);

    globalThis.gordState = await decideNextPriority(ns);
    // Surface a fresh corp/gang creation event over the routine priority.
    if (corpEvent) globalThis.gordState = { ...globalThis.gordState, ...corpEvent };
    else if (gangEvent?.action === "Gang Created") globalThis.gordState = { ...globalThis.gordState, ...gangEvent };

    const bought = buyAugs(ns);
    if (bought?.length) {
      globalThis.gordState.purchases = bought;
    }

    globalThis.gordAugPipeline = getAllAugCandidates(ns).slice(0, 10);

    maybeInstall(ns);
    await maybeFinishBN(ns);

    ns.print(
      `Money: ${ns.format.number(playerMoney(ns))} | Hack: ${hackingLevel(ns)} | Karma: ${(ns.getPlayer().karma ?? 0).toFixed(0)}`
    );
    await ns.sleep(15_000);
  }
}
