// lib/daemon-core.js
//
// The per-BitNode daemon SKELETON, shared by every bnX/daemon.js. Where
// lib/daemon-lib.js holds the building blocks (rooting, helper placement, aug
// buying, the install policy), this file holds the two things that were still
// copy-pasted into every daemon after that split:
//
//   runDaemon(ns, hooks)  - main(): the tick loop. Invites, darkweb, rooting,
//                           backdoor/finisher, the off-home helpers in a fixed
//                           order, the node's decision, aug buys, the install
//                           check, the status line. Everything a node does
//                           differently arrives through `hooks`.
//   decideAugFlow(ns, c)  - the tail of decideNextPriority every node shares:
//                           combat training for the target faction, rep work
//                           (passive for a gang faction), the "rep done, money
//                           still needed" branch, and "ready to buy".
//   decidePrelude / decideNoTarget - the common head (rate snapshots + faction
//                           opportunities) and the common "no aug target" fallback.
//
// A node's own decideNextPriority is therefore only its strategy prefix: WHEN it
// bootstraps a gang, whether programs come before or after that, BN10's money
// hoard and grafting branches - and then it hands the target to decideAugFlow.
//
// Behavioural note (the one deliberate change from the copies this replaced): in
// the money-still-needed branch the SECONDARY faction work used to be started
// before the decision about PRIMARY work was made, so on ticks where the primary
// faction still had rep to earn, workForFaction was issued twice and the first
// call - the secondary - was wasted and its partial cycle thrown away every tick.
// The secondary is now only started on the path that would otherwise just "Save".
//
// RAM: importing this instead of inlining it costs a daemon nothing - Bitburner
// charges the API calls of every function REACHED from main, and each daemon
// reached all of these already. The savings live in the off-home helpers.

import {
  trainCombatIfNeeded,
  commitBestCrimeIfUseful,
  shouldFocus,
  maybePursueNextFaction,
  estimateIncomeRate,
  updateRepRate,
  doIdleWork,
} from "./player-actions.js";
import {
  getAllAugCandidates,
  getUnjoinedFactionOpportunities,
  factionRepStillUseful,
} from "./aug-targets.js";
import {
  playerMoney,
  hackingLevel,
  ensureHelper,
  ensureBackdoorHelpers,
  ensureGangManager,
  gangFactionName,
  buyAugs,
  maybeInstall,
  startBestFactionWork,
  maybeDoSecondaryFactionWork,
  buyDarkweb,
  rootEverything,
  acceptInvites,
  readLastResetTime,
  writeResetTime,
  consumeResetSummary,
  plannedNextNode,
} from "./daemon-lib.js";
import { emitEvent } from "./events.js";
import { maybeSetupCorp, ensureCorpManagers } from "./corp-daemon.js";
import { getCapabilities } from "./capabilities.js";
import { giftStatus, chargeHolds, mergeHolds } from "./stanek-logic.js";

/**
 * @typedef {object} DaemonHooks
 * @property {any} cfg                 forNode(n) for this daemon's node
 * @property {string} self             this daemon's path (post-install callback)
 * @property {(ns: NS) => Promise<any>} decide   the node's decideNextPriority
 * @property {(ns: NS) => number} [plannedNextBN]
 *   BitNode to enter when w0r1d_d43m0n falls (<= 0 = halt sentinel). Default:
 *   daemon arg [0] (remembered across installs - nextBNOverride), else the next
 *   step of the campaign plan (plannedNextNode). Only a node with a reason to
 *   depart from the plan sets this - BN10, which never ends itself.
 * @property {string} [finishCallback] script lib/finish-bn.js runs in the next
 *   node. Leave unset: the default is the cold-start driver, which fits the 8-32GB
 *   home a new BitNode starts with and boots the right daemon for it. The game
 *   refuses a callback that doesn't fit in RAM, so naming a daemon here strands
 *   the next node with nothing running.
 * @property {(ns: NS) => any} [setupGang]
 *   Called every tick before the managers are placed; a returned
 *   { action: "Gang Created" } is surfaced over the routine state. For nodes
 *   whose gang setup needs the PLAYER's slot (crime toward a karma gate), call
 *   it from `decide` instead so it orders correctly against the other work.
 * @property {boolean} [sleevesOptional] default true; BN10 makes the sleeve manager required
 * @property {{script: string, optional?: boolean, args?: any[]}[]} [priorityHelpers]
 *   off-home helpers launched BEFORE the sleeve manager - for a node whose engine
 *   is a helper that must not lose the race for RAM (BN6: the Bladeburner loop)
 * @property {{script: string, optional?: boolean, args?: any[]}[]} [extraHelpers]
 *   more off-home helpers, launched right after the sleeve manager
 * @property {any[]} [econArgs]        exec args for lib/econ.js (BN2: the gang join money)
 * @property {(ns: NS, reserved: Set<string>) => void} [reserveHosts]
 *   Add hosts the botnet and the helpers must leave alone, on top of the gang
 *   and corp hosts (BN9: the hacknet servers, whose hash rate scripts would cut).
 * @property {(ns: NS) => boolean} [beforeInstall]
 *   Asked once maybeInstall has decided to install; return false to hold the
 *   reset this tick (BN9: until the hacknet helper has sold every hash).
 * @property {(ns: NS, state: any) => void} [afterDecide]  e.g. BN10's stay-city publish
 * @property {(ns: NS) => string} [statusLine]  suffix for the per-tick log line
 * @property {{opportunities: Function, pursue: Function}} [companyWork]
 *   lib/company-work.js's makeCompanyWork(cfg), on nodes that grind megacorp rep.
 *   Threaded into the faction pipeline and maybePursueNextFaction from here so
 *   its Singularity calls are only reachable from daemons that pass it.
 */

// Published state a NEW daemon run must not inherit - see runDaemon. The HUD
// toggles are deliberately absent: they're the player's, and lib/toggles.js
// reconciles them with their files.
const STALE_AT_BOOT = [
  "gordState",
  "gordBackdoorState",
  "gordAwaitingManualBN",
  "gordMoneyFloor",
  "gordGraftState",
  "gordGraftAllow",
  "gordHashDumpRequested",
  "gordHashDumpDone",
  "gordInstallRequested",
];

// The companyWork hook, kept at module level so decidePrelude / decideNoTarget /
// decideAugFlow can use it without every node threading it through by hand.
let _companyWork = /** @type {any} */ (null);

/**
 * The common head of every decideNextPriority: refresh the rate snapshots the
 * ETA sort needs, then compute (and publish for the HUD) the faction pipeline.
 * @param {NS} ns @returns {any[]} the unjoined-faction opportunities
 */
export function decidePrelude(ns) {
  estimateIncomeRate(ns);
  const currentTarget = globalThis.gordState?.target;
  if (currentTarget?.faction) updateRepRate(ns, currentTarget.faction);

  const opportunities = getUnjoinedFactionOpportunities(ns, _companyWork?.opportunities ?? null);
  globalThis.gordFactionPipeline = opportunities;
  return opportunities;
}

/**
 * maybePursueNextFaction with this daemon's companyWork hook applied. Nodes
 * with their own no-target branch (BN10) call this rather than the raw one.
 * @param {NS} ns @param {any[]} opportunities @param {boolean} isIdle
 */
export function pursueNextFaction(ns, opportunities, isIdle) {
  return maybePursueNextFaction(ns, opportunities, isIdle, _companyWork);
}

/**
 * No aug target: unlock new factions if any are worth pursuing, else do
 * productive idle work (crime -> rep banking -> study).
 * @param {NS} ns @param {{opportunities: any[], infra: any}} c
 */
export async function decideNoTarget(ns, { opportunities, infra }) {
  const factionPursuit = await pursueNextFaction(ns, opportunities, true);
  if (factionPursuit) {
    // Blocked on faction join money: keep earning toward that goal.
    const moneyGoal = factionPursuit.joinMoneyMissing
      ? playerMoney(ns) + factionPursuit.joinMoneyMissing
      : 0;
    const idle = await doIdleWork(ns, moneyGoal);
    return { ...factionPursuit, ...idle, target: null, infra };
  }

  const idle = await doIdleWork(ns);
  return { ...idle, target: null, infra };
}

/**
 * The shared tail: we have an aug target, so train for its faction if it has
 * combat gates, earn its rep, then its price, then buy.
 *
 * @param {NS} ns
 * @param {{cfg: any, target: any, infra: any, opportunities: any[], incomeLabel?: string}} c
 *   incomeLabel names the passive income the "Saving" line credits
 *   ("Hacking", "Gang/hacking income", "Corp/hacking income").
 */
export async function decideAugFlow(ns, { cfg, target, infra, opportunities, incomeLabel = "Hacking" }) {
  // Combat-stat requirements for the target's faction.
  const statTargets = cfg.factions.requirements[target.faction] ?? {};
  const training = await trainCombatIfNeeded(ns, statTargets);
  if (training) return { ...training, target, infra };

  // A gang faction's rep accrues passively from respect - workForFaction isn't
  // even offered for it - so player attention goes elsewhere. Null without a gang.
  const gangFaction = gangFactionName(ns);

  // Rep still needed.
  if (target.repMissing > 0) {
    // Likewise a faction that offers no work at all (target.passive: Bladeburners'
    // rep is rank, the Church of the Machine God's comes from charging the gift).
    if (target.faction === gangFaction || target.passive) {
      const secondary = maybeDoSecondaryFactionWork(ns, target.faction);
      const extra = secondary ?? (await doIdleWork(ns))?.detail;
      const gang = target.faction === gangFaction;
      return {
        action: gang ? "Gang Rep (passive)" : "Faction Rep (passive)",
        detail: `${target.faction} ${gang ? "respect" : "reputation"} -> ${target.aug}${extra ? ` | ${extra}` : ""}`,
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

  // Rep done, money still needed.
  if (target.moneyMissing > 0) {
    const saving = `saving $${ns.format.number(target.moneyMissing)} for ${target.aug}`;

    if (!shouldFocus(ns)) {
      // Background mode: hacking earns the money freely, so spend the work slot
      // on reputation. Primary faction first (more augs from it later), and only
      // if it has nothing left does a secondary faction get the slot.
      if (target.faction !== gangFaction) {
        const owned = new Set(ns.singularity.getOwnedAugmentations(true));
        const moreRepWork = factionRepStillUseful(ns, target.faction, owned, {
          excludeAug: target.aug,
          requirePrereqs: false,
        });
        if (moreRepWork) {
          const workType = startBestFactionWork(ns, target.faction);
          if (workType) {
            return {
              action: "Faction Work (banking rep)",
              detail: `${target.faction} (${workType}, no focus) | ${saving}`,
              target,
              infra,
            };
          }
        }
      }

      const secondary = maybeDoSecondaryFactionWork(ns, target.faction);
      if (secondary) {
        return { action: "Faction Work (secondary)", detail: `${secondary} | ${saving}`, target, infra };
      }

      const factionPursuit = await pursueNextFaction(ns, opportunities, false);
      if (factionPursuit) {
        return { ...factionPursuit, detail: `${factionPursuit.detail} | ${saving}`, target, infra };
      }

      return savingState(ns, target, infra, incomeLabel);
    }

    // Focus mode: crime is the best use of player attention.
    const crime = await commitBestCrimeIfUseful(ns, `$${ns.format.number(target.moneyMissing)} for ${target.aug}`);
    if (crime) return { ...crime, target, infra };

    return savingState(ns, target, infra, incomeLabel);
  }

  // Ready to buy (buyAugs in the main loop does it this same tick).
  return { action: "Ready to Purchase", detail: `${target.faction} -> ${target.aug}`, target, infra };
}

function savingState(ns, target, infra, incomeLabel) {
  return {
    action: "Saving",
    detail: `${incomeLabel} for $${ns.format.number(target.moneyMissing)} -> ${target.aug}`,
    target,
    infra,
  };
}

/**
 * The daemon main loop. See the file header for what each hook does; the order
 * of the helper launches below is the priority order for scarce off-home RAM:
 * the backdoor loop (unlocks the hacking factions), the sleeve manager (claims
 * RAM before the botnet fills the network), node extras, the gang and corp
 * managers (dedicated hosts, reserved from the botnet), then the botnet itself
 * and the luxury scripts.
 * @param {NS} ns @param {DaemonHooks} hooks
 */
export async function runDaemon(ns, hooks) {
  const { cfg, self } = hooks;
  ns.disableLog("ALL");
  _companyWork = hooks.companyWork ?? null;

  // Which gated APIs this run has (0GB beyond the getResetInfo the daemon pays
  // anyway). Passed down to helpers as exec args so THEY don't each pay 1GB for
  // getResetInfo to learn the same node number.
  const caps = getCapabilities(ns);
  const node = caps.currentNode;

  if (readLastResetTime(ns) === 0) writeResetTime(ns);

  // If the previous run ended in an aug install, surface a one-time summary for
  // the journal. globalThis is wiped by the install, so this is read from disk
  // (and blanked) exactly once, here at boot.
  globalThis.gordLastReset = consumeResetSummary(ns);

  // globalThis is NOT wiped by an aug install or by entering a new BitNode (only
  // by a page load), so whatever the previous run's helpers last published is
  // still here - and some of it gates irreversible or blocking decisions: a
  // "world daemon ready" from the last node, a money hoard nobody is holding any
  // more, a graft that died with its script. Live helpers republish within a tick.
  for (const key of STALE_AT_BOOT) delete globalThis[key];

  let decideFailures = 0;

  while (true) {
    // Root the network FIRST so the helpers below have off-home hosts to land
    // on, and buy port openers when affordable to unlock bigger servers.
    await acceptInvites(ns);
    await buyDarkweb(ns);
    rootEverything(ns);

    // Backdoors ahead of every RAM-hungry helper: CSEC/avmnite-02h/I.I.I.I/
    // run4theh111z unlock the hacking factions, and the backdoor loop is only
    // ~9GB now that the 32GB finisher is its own script (launched by this same
    // call once the world daemon is ready, unless the node's plan or the
    // HUD's FINISH toggle holds it).
    const nextBN = hooks.plannedNextBN
      ? hooks.plannedNextBN(ns)
      : plannedNextNode(ns, cfg);
    ensureBackdoorHelpers(ns, node, nextBN, hooks.finishCallback);

    // Stanek's Gift (BN13 / SF13). It can only be accepted while no augmentation
    // but NeuroFlux is owned or queued, and there is no second chance within the
    // node - so while nobody has asked yet ("pending") nothing below may buy an
    // aug, start a graft, or join the Bladeburner division (SF7.3 hands out The
    // Blade's Simulacrum on joining). The one-shot that asks is tiny and runs
    // within a tick; after it, the gate is "accepted" or "refused" for good.
    const gift = giftStatus(caps.reset, cfg.stanek, globalThis.gordStanekState);
    globalThis.gordGiftPending = gift === "pending";
    if (gift === "pending") {
      ensureHelper(ns, cfg.paths.stanekBoot, { optional: false, args: [node] });
    } else if (gift === "accepted") {
      // The manager lays out the gift and tends the charge workers. Ahead of the
      // botnet, so it has a host before the workers fill the network.
      ensureHelper(ns, cfg.paths.stanek, { optional: true, args: [node] });
    }

    // A node's own engine, when it's a helper, goes ahead of the sleeve manager.
    for (const h of hooks.priorityHelpers ?? []) {
      ensureHelper(ns, h.script, { optional: h.optional ?? true, args: h.args });
    }
    // IPvGO where the node makes it part of the engine (go.priority - BN14, where
    // every bonus is worth four times as much): placed here, before the botnet
    // has the RAM, and worth a warning when nothing has room. Elsewhere it is
    // launched further down as a luxury.
    if (cfg.go.enabled && cfg.go.priority) {
      ensureHelper(ns, cfg.paths.go, { optional: false, args: [node] });
    }

    // Duplicate sleeves (BN10 or SF10): ~72GB of ns.sleeve.* calls, so it runs
    // off-home, and BEFORE the botnet so it can claim RAM before workers fill the
    // network. lib/sleeves.js self-exits where sleeves are unavailable.
    ensureHelper(ns, cfg.paths.sleeves, {
      optional: hooks.sleevesOptional ?? true,
      args: [node, caps.gang ? 1 : 0],
    });
    // The Covenant's sleeve + memory shop exists in one node only; elsewhere the
    // helper (and its 16GB of shop calls) is never launched.
    if (node === cfg.sleeves.shopBitNode) {
      ensureHelper(ns, cfg.paths.sleeveShop, { optional: true, args: [node] });
    }
    // (Held while the gift is pending: the grafting manager is one of these.)
    for (const h of gift === "pending" ? [] : hooks.extraHelpers ?? []) {
      ensureHelper(ns, h.script, { optional: h.optional ?? true, args: h.args });
    }
    // The hacknet SERVER fleet (BN9 / SF9) - see lib/hacknet.js. Required where
    // the node's config turns it on (it IS the economy there), so it claims its
    // few GB before the botnet fills the network; elsewhere never launched.
    if (cfg.hacknet.enabled) {
      ensureHelper(ns, cfg.paths.hacknet, { optional: false, args: [node, caps.hacknetServer ? 1 : 0] });
    }

    // Gang first: it reserves cloud-gang from the botnet before anything else
    // goes looking for off-home RAM, and lib/gang.js is ~36GB - big enough to
    // lose every race for a shared host. The reservation Set is rebuilt fresh
    // each tick so a reset/relaunch heals it; ensureCorpManagers adds the corp
    // host to the same Set and republishes.
    const reserved = new Set();
    ensureGangManager(ns, reserved);
    hooks.reserveHosts?.(ns, reserved);
    globalThis.gordReservedHosts = reserved;
    // RAM the gift's charge workers are still waiting for on hosts the botnet
    // has filled: kept free as its legs land (ensureGangManager just rebuilt the
    // map, so this has to be folded back in every tick).
    if (gift === "accepted") {
      globalThis.gordReservedRam = mergeHolds(
        globalThis.gordReservedRam,
        chargeHolds(globalThis.gordStanekState, Date.now(), cfg.ui.staleMs.helper),
      );
    }

    const gangEvent = hooks.setupGang ? await hooks.setupGang(ns) : null;
    const corpEvent = maybeSetupCorp(ns);
    ensureCorpManagers(ns, reserved);

    // The botnet income engine, then UI / luxury scripts, all off-home.
    ensureHelper(ns, cfg.paths.manager);
    ensureHelper(ns, cfg.paths.dashboard);
    ensureHelper(ns, cfg.paths.stocks, { optional: true, args: [node] });
    // Coding contracts: universal, rare and non-urgent - waits quietly for RAM.
    ensureHelper(ns, cfg.paths.contracts, { optional: true });
    // IPvGO (lib/go.js, 9.6GB): node-power stat multipliers, re-earned after every install.
    if (cfg.go.enabled) ensureHelper(ns, cfg.paths.go, { optional: true, args: [node] });
    // The aug stat table (one-shot; it exits once it has published). Until it
    // has run, aug targets are ranked as if every aug were worth the same.
    if (cfg.augs.value.enabled && !globalThis.gordAugStats) {
      ensureHelper(ns, cfg.paths.augStats, { optional: true });
    }
    // Hacknet / home-RAM spending, after the backdoor helpers claimed their RAM.
    // Arg [0] is the home-RAM money reserve, [1] the node (so econ can resolve
    // its per-node config without paying for getResetInfo itself).
    ensureHelper(ns, cfg.paths.econ, {
      optional: true,
      args: [hooks.econArgs?.[0] ?? cfg.econ.homeRamReserve, node],
    });

    // The decision is a long chain of Singularity calls, several of which THROW
    // on a state they don't like (workForCompany when unemployed, a faction that
    // vanished) - and an exception here used to end the daemon, and with it the
    // whole bot. Keep the last state, say so, and try again next tick.
    let state;
    try {
      state = await hooks.decide(ns);
      decideFailures = 0;
    } catch (e) {
      const msg = String(e?.message ?? e).split("\n")[0];
      ns.print(`ERROR: decide failed: ${msg}`);
      if (decideFailures++ % cfg.daemon.decideErrorEveryTicks === 0) {
        emitEvent(`[!] daemon decision failed: ${msg}`, "sys");
      }
      state = { ...(globalThis.gordState ?? {}), action: "Error", detail: msg };
    }
    // Surface a fresh corp/gang creation over the routine priority.
    if (corpEvent) state = { ...state, ...corpEvent };
    else if (gangEvent?.action === "Gang Created") state = { ...state, ...gangEvent };
    // Stamped, so the HUD can tell a live daemon from the last words of a dead one.
    globalThis.gordState = { ...state, updatedAt: Date.now() };
    hooks.afterDecide?.(ns, state);

    // No purchase while the gift is still to be asked for - see the gate above.
    const bought = gift === "pending" ? [] : buyAugs(ns);
    if (bought?.length) globalThis.gordState.purchases = bought;

    // The full sorted candidate list for the dashboard's pipeline view.
    globalThis.gordAugPipeline = getAllAugCandidates(ns).slice(0, cfg.augs.pipelineSize);

    maybeInstall(ns, self, hooks.beforeInstall ?? null, cfg.augs.install);

    const extra = hooks.statusLine ? hooks.statusLine(ns) : "";
    const held = globalThis.gordAugSavingFor;
    const saving = held ? ` | Augs: saving $${ns.format.number(held.price)} for ${held.aug}` : "";
    ns.print(`Money: ${ns.format.number(playerMoney(ns))} | Hack: ${hackingLevel(ns)}${saving}${extra}`);
    await ns.sleep(cfg.daemon.tickMs);
  }
}
