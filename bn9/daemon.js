// bn9/daemon.js
//
// BN9 ("Hacktocracy") orchestrator. The shared skeleton is lib/daemon-core.js
// (runDaemon + decideAugFlow); what this file owns is BN9's strategy, tuned
// around its multipliers (src/BitNode/BitNode.tsx):
//
//   ScriptHackMoney      0.1  } hacking earns ~0.1% of normal: money stolen is
//   ServerMaxMoney       0.01 } 10% of a pool that is itself 1% of normal
//   ServerStartingMoney  0.1, ServerStartingSecurity 2.5
//   HackExpGain          0.05, HackingLevelMultiplier 0.5   hacking levels crawl
//   Str/Def/Dex/Agi/Cha  0.45, CrimeMoney 0.5              crime is weak too
//   CloudServerLimit     0                                  no purchased servers
//   HomeComputerRamCost  5                                  home RAM is 5x dearer
//   WorldDaemonDifficulty 2                                 w0r1d_d43m0n wants hacking 6000
//   GangSoftcap 0.8, CorporationValuation 0.5              both still work, both reduced
//
// ...and the one thing it gives back: HACKNET SERVERS. Their hashes sell for
// $1M per 4 (the node's actual income), buy "Improve Studying" (+20% study exp
// per level - the only fast route to a hacking level whose exp gain is 5%),
// and "Reduce Minimum Security" / "Increase Maximum Money" on a target (which
// is how the botnet ever earns here). So BN9's defining move is a hacknet
// FLEET, grown from the first tick: early/driver.js starts lib/hacknet.js
// during the cold boot, and this daemon keeps it as a REQUIRED helper. Every
// tick it publishes gordHashHints - cash priority while cash is the
// bottleneck, study/gym flags from its own action, the botnet's primary target
// - which is how the helper knows what the hashes should become.
//
// The rest of the node is the ordinary aug flow with two BN9 twists:
//   - An aug install wipes the hacknet fleet, every hash upgrade and (as
//     always) hacking exp, so BITNODE[9] batches installs bigger and rarer, and
//     beforeInstall sells every hash first (gordHashDumpRequested handshake).
//   - The last wall is the world daemon's hacking gate. When the aug pipeline
//     runs dry, the player's slot STUDIES (hash-multiplied) instead of criming
//     for money the fleet already provides; grafting (SF10, lib/grafting.js)
//     adds multipliers without a reset, exactly as in BN10.
// A gang is founded passively when the sleeves' crime karma crosses the gate
// (GangSoftcap 0.8: still a fine second income and passive faction rep).

import {
  doEarlyBootstrapIfNeeded,
  maybeCreatePrograms,
  maybeAutoTravelForReadyFaction,
  doIdleWork,
  clearFactionWork,
  focusFlag,
} from "../lib/player-actions.js";
import { getNextAugTarget, getMoneyHoardGoal } from "../lib/aug-targets.js";
import { forNode } from "../lib/config.js";
import { playerMoney, hackingLevel, maybeBuyInfra, inGangSafe } from "../lib/daemon-lib.js";
import { runDaemon, decidePrelude, decideAugFlow, pursueNextFaction } from "../lib/daemon-core.js";
// Megacorp faction grinding (factions.pursueCompanyFactions): the long no-reset
// endgame makes their augs worth the grind, as in BN10.
import { makeCompanyWork } from "../lib/company-work.js";
import { activityHints } from "../lib/hacknet-logic.js";

// Every tunable value comes from lib/config.js, resolved for BitNode 9.
const CFG = forNode(9);
const GANG = CFG.gang;
const HK = CFG.hacknet;
const PL = CFG.player;
const SELF = CFG.paths.daemon;                // this daemon's path (post-reset callback)
const HOME = CFG.paths.home;
const FINAL_HOST = CFG.backdoor.finalHost;
// Hacknet servers hang off home and are named by this prefix (the batcher
// already refuses to TARGET them; reserveHacknetHosts keeps it from HOSTING on them).
const HACKNET_PREFIX = CFG.hacking.excludeTargetPrefix;
const STUDY_LOCATION = /** @type {any} */ (PL.studyLocation);
const STUDY_CLASS = /** @type {any} */ (PL.studyClass);
// Criminal factions that can found a gang; whichever we're already in gets used.
// Cast to any[] so its elements don't trip checkJs against FactionName - see
// [[bitburner-enum-string-casts]].
const CRIMINAL_FACTIONS = /** @type {any[]} */ (GANG.criminalFactions);

/**
 * The BitNode to enter when lib/finish-bn.js destroys w0r1d_d43m0n. Same shape
 * as BN5's plan: 9.1 re-enters BN9 for 9.2 (128GB home on every future node -
 * the single best quality-of-life Source-File level there is); from 9.2 on,
 * halt for manual selection. An explicit daemon arg ([0]) always overrides.
 * @param {NS} ns
 */
function plannedNextBN(ns) {
  if (ns.args[0] != null) return Number(ns.args[0]);

  const info = ns.getResetInfo();
  if (info.currentNode !== 9) return CFG.backdoor.defaultNextBN;

  const sf9 = info.ownedSF.get(9) ?? 0;
  return sf9 < 1 ? 9 : 0; // 9.1 -> re-enter BN9; 9.2+ -> halt for manual selection
}

/**
 * Found a gang the moment we're eligible: karma past the gate AND already a
 * member of a criminal faction. Never ground toward here - the sleeves' crime
 * karma (lib/sleeves.js gang-bootstrap mode) counts for the player and gets
 * there on its own. Needs no player attention, so it runs from the core's
 * setupGang hook.
 * @param {NS} ns
 */
function maybeSetupGang(ns) {
  if (inGangSafe(ns)) return null;

  const player = ns.getPlayer();
  if ((player.karma ?? 0) > GANG.karma) return null; // not eligible yet

  const joined = player.factions ?? [];
  const faction = CRIMINAL_FACTIONS.find(f => joined.includes(f));
  if (!faction) {
    return { action: "Gang (karma ready)", detail: "Awaiting a criminal faction invite" };
  }

  try {
    if (ns.gang.createGang(/** @type {any} */ (faction))) {
      ns.tprint(`Created gang with ${faction}!`);
      return { action: "Gang Created", detail: faction };
    }
  } catch { /* no SF2 in this run - nothing to found */ }

  return null;
}

// ── Hacknet coordination ─────────────────────────────────────────────────────

let _worldLevel = 0;
/** The world daemon's hacking requirement (3000 x WorldDaemonDifficulty). @param {NS} ns */
function worldDaemonLevel(ns) {
  if (_worldLevel > 0) return _worldLevel;
  try { _worldLevel = ns.getServerRequiredHackingLevel(FINAL_HOST); } catch { _worldLevel = 0; }
  return _worldLevel;
}

/**
 * Keep the botnet off the hacknet servers: a script running on one cuts its
 * hash rate by the RAM it uses, and in BN9 hashes are the money. Off-home
 * helpers placed by ensureHelper honour the same Set, so nothing lands there.
 * @param {NS} ns @param {Set<string>} reserved
 */
function reserveHacknetHosts(ns, reserved) {
  if (HK.botnetMayUse) return;
  for (const host of ns.scan(HOME)) {
    if (host.startsWith(HACKNET_PREFIX)) reserved.add(host);
  }
}

/**
 * Tell lib/hacknet.js what this tick's hashes are for (see its header for the
 * contract). Cash priority - sell every hash, invest nothing - while cash is
 * the bottleneck: before TOR (the whole early economy waits on it), while an
 * invite hoard is on, and while an aug is paid up in rep but not in money.
 * Otherwise the helper takes the study/gym multipliers when we're doing exactly
 * that, and the boosts go to the batcher's primary target.
 * @param {NS} ns @param {any} state
 */
function publishHashHints(ns, state) {
  const act = activityHints(state?.action);
  const t = state?.target;
  const savingForAug = !!t && (t.repMissing ?? 0) <= 0 && (t.moneyMissing ?? 0) > 0;
  const hoarding = (globalThis.gordMoneyFloor ?? 0) > 0;
  globalThis.gordHashHints = {
    cashPriority: hoarding || savingForAug || !ns.hasTorRouter(),
    studying: act.studying,
    training: act.training,
    target: globalThis.gordHackState?.target ?? null,
    savingMoney: savingForAug ? t.moneyMissing : 0,
    corp: false,
    updatedAt: Date.now(),
  };
}

/**
 * Pre-install handshake: an install wipes every hash, so ask the helper to sell
 * them all and hold the install until it answers (or the wait times out - a
 * dead helper must not hold a reset forever). Returns true when it's fine to
 * install now. Called by maybeInstall only once it has decided to install.
 * @param {NS} ns
 */
function hashesDumped(ns) {
  const now = Date.now();
  const requested = globalThis.gordHashDumpRequested ?? 0;
  if (!requested) {
    globalThis.gordHashDumpRequested = now;
    ns.print("install pending: asking lib/hacknet.js to sell every hash first");
    return false;
  }
  const done = globalThis.gordHashDumpDone ?? 0;
  const ok = done >= requested || now - requested > HK.installDumpTimeoutMs;
  if (ok) globalThis.gordHashDumpRequested = 0; // fresh request next time
  return ok;
}

/**
 * Study toward the world daemon's hacking gate. The idle-time default here:
 * hacking exp is 5% of normal, but the "Improve Studying" hash upgrade
 * multiplies class exp and the helper buys it exactly while this runs.
 * @param {NS} ns @param {number} need @param {string} [why]
 */
function studyForEndgame(ns, need, why = "") {
  const hacking = hackingLevel(ns);
  ns.singularity.universityCourse(STUDY_LOCATION, STUDY_CLASS, focusFlag(ns));
  const bonus = globalThis.gordHacknetState?.levels?.study ?? 0;
  return {
    action: "Studying (endgame)",
    detail: `Hacking ${hacking}/${need} for ${FINAL_HOST}${bonus ? ` | hash study bonus +${bonus * 20}%` : ""}${why ? ` | ${why}` : ""}`,
  };
}

// ── Strategy ─────────────────────────────────────────────────────────────────

/** @param {NS} ns */
async function decideNextPriority(ns) {
  // Default the player slot to "not free for grafting"; only the genuinely-idle
  // fallback below opts back in (see lib/grafting.js for the contract).
  globalThis.gordGraftAllow = false;
  // Same for the faction grind the sleeve manager shadows (recordFactionWork).
  clearFactionWork();

  const opportunities = decidePrelude(ns);

  const autoTravel = await maybeAutoTravelForReadyFaction(ns, opportunities);
  if (autoTravel) return { ...autoTravel, target: null, infra: null };

  // Early bootstrap (study to hack 50, mug for TOR/BruteSSH money). Slow here
  // (HackExpGain 0.05), but the fleet is growing underneath it the whole time.
  const bootstrap = await doEarlyBootstrapIfNeeded(ns);
  if (bootstrap) return { ...bootstrap, target: null, infra: null };

  const programWork = await maybeCreatePrograms(ns);
  if (programWork) return { ...programWork, target: getNextAugTarget(ns), infra: null };

  const target = getNextAugTarget(ns);

  // Money-gated endgame invites: hold cash once every other requirement is met.
  // gordMoneyFloor is respected by buyAugs, maybeInstall, maybeBuyInfra and the
  // off-home spenders (the hacknet helper budgets against spendableMoney).
  const hoard = target ? null : getMoneyHoardGoal(ns);
  globalThis.gordMoneyFloor = hoard ? hoard.money : 0;

  // CloudServerLimit is 0 here, so this never buys a server; it still yields the
  // "Saving for Aug" / "Holding Cash" states the HUD's infra card shows.
  const infra = await maybeBuyInfra(ns, target);

  // A graft in progress owns the player's slot (cancelling wastes the time sunk).
  const graft = globalThis.gordGraftState;
  if (graft?.active) {
    const eta = graft.etaMs ? ` (~${ns.format.time(graft.etaMs)} left)` : "";
    return {
      action: "Grafting",
      detail: `${graft.aug}${eta} | Entropy ${graft.entropy}/${graft.entropyCap}`,
      target,
      infra,
    };
  }

  // No aug target: BN9's version of the core's decideNoTarget - the money
  // hoard, company work and grafting folded in (as BN10), and STUDY as the
  // idle default while the world daemon's gate is unmet.
  if (!target) {
    const held = hoard
      ? `[holding $${ns.format.number(hoard.money)} for ${hoard.faction} invite, $${ns.format.number(hoard.moneyMissing)} to go] `
      : "";
    const need = worldDaemonLevel(ns);
    const belowGate = need > 0 && hackingLevel(ns) < need;

    const factionPursuit = await pursueNextFaction(ns, opportunities, true);
    if (factionPursuit) {
      // Company work / training / travel actually use the slot - return them.
      // "Saving for Faction" is directional: the fleet earns the money, so the
      // slot studies (the blocker is as likely hacking level as cash here).
      if (factionPursuit.action !== "Saving for Faction") {
        return { ...factionPursuit, detail: held + factionPursuit.detail, target: null, infra };
      }
      if (belowGate) {
        const study = studyForEndgame(ns, need, factionPursuit.detail);
        return { ...factionPursuit, ...study, detail: held + study.detail, target: null, infra };
      }
      const moneyGoal = factionPursuit.joinMoneyMissing
        ? playerMoney(ns) + factionPursuit.joinMoneyMissing
        : 0;
      const idle = await doIdleWork(ns, moneyGoal);
      return { ...factionPursuit, ...idle, detail: held + factionPursuit.detail, target: null, infra };
    }

    // Genuinely out of faction work: free the slot for grafting (the ONLY place
    // this is set true) and let lib/grafting.js's cost model decide.
    globalThis.gordGraftAllow = true;
    if (graft?.worthwhile && graft.best) {
      const b = graft.best;
      return {
        action: "Grafting",
        detail: `${held}starting ${b.aug}: $${ns.format.number(b.price)}, ~${ns.format.time(b.timeMs)} | Entropy ${graft.entropy}/${graft.entropyCap}`,
        target: null,
        infra,
      };
    }

    if (belowGate) {
      const study = studyForEndgame(ns, need);
      return { ...study, detail: held + study.detail, target: null, infra };
    }

    const base = await doIdleWork(ns);
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

  return decideAugFlow(ns, { cfg: CFG, target, infra, opportunities, incomeLabel: "Hacknet/hacking income" });
}

/**
 * After the decision: the stay-city for company work / grafting (so the
 * auto-travel-home loop doesn't yank us out), then this tick's hash hints.
 */
function afterDecide(ns, state) {
  globalThis.gordCompanyCity = state?.action === "Company Work"
    ? state.companyCity ?? null
    : state?.action === "Grafting"
    ? CFG.grafting.city
    : null;
  publishHashHints(ns, state);
}

/** The fleet and its hashes, plus the gang roster. @param {NS} ns */
function statusLine(ns) {
  const h = globalThis.gordHacknetState;
  const hashNote = h
    ? ` | Hashes: ${h.hashes.toFixed(0)}/${h.capacity} @ ${h.ratePerSec.toFixed(2)}/s (~$${ns.format.number(h.incomePerSec)}/s) | Fleet: ${h.servers}/${h.maxServers}`
    : " | Hacknet: manager not running";
  const gang = globalThis.gordGangState;
  const gangNote = gang ? ` | Gang: ${gang.members}/${gang.maxMembers} (${gang.faction})` : "";
  return hashNote + gangNote;
}

/** @param {NS} ns */
export async function main(ns) {
  await runDaemon(ns, {
    cfg: CFG,
    self: SELF,
    finishCallback: SELF,
    plannedNextBN,
    setupGang: maybeSetupGang,
    decide: decideNextPriority,
    // The BN9 headline act - the hacknet manager - is launched by the core itself
    // (required wherever CONFIG.hacknet.enabled, which BITNODE[9] sets). Grafting
    // (SF10, lib/grafting.js, off-home) is the bonus for the long no-reset tail.
    extraHelpers: [{ script: CFG.paths.grafting, optional: true }],
    reserveHosts: reserveHacknetHosts,
    beforeInstall: hashesDumped,
    companyWork: makeCompanyWork(CFG),
    afterDecide,
    statusLine,
  });
}
