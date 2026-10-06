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
  beginHelperTick,
  helperTickYielded,
  closeHelperTick,
  acceptInvites,
  readLastResetTime,
  resetDonationMemory,
  writeResetTime,
  consumeResetSummary,
  plannedNextNode,
} from "./daemon-lib.js";
import { emitEvent } from "./events.js";
import { maybeSetupCorp, ensureCorpManagers } from "./corp-daemon.js";
import { getCapabilities } from "./capabilities.js";
import { giftStatus, chargeHolds, mergeHolds } from "./stanek-logic.js";
// Only the pure predicate: the buyer's ns.hacknet.* calls stay in its own script.
import { hacknetNodesWanted } from "./hacknet-nodes.js";

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
  // Rebuilt by the first tick, but its EARLY helpers are placed before that:
  // without this they would avoid (or not avoid) the last run's reserved hosts.
  "gordReservedHosts",
  "gordBackdoorState",
  "gordAwaitingManualBN",
  "gordMoneyFloor",
  "gordGraftState",
  "gordGraftAllow",
  "gordHashDumpRequested",
  "gordHashDumpDone",
  "gordInstallRequested",
  // The stay-city BN8/BN9/BN10 publish for a graft or a company grind. Left over
  // from such a node it pins the player in that city in the next one
  // (maybeAutoTravelForReadyFaction won't go home from it), where the gym and
  // the university - both Sector-12 - then fail silently.
  "gordCompanyCity",
  // The income estimate. Earnings are measured since the last install, so the
  // old snapshot reads as a negative gain and the old RATE decays by a fifth a
  // tick: for ~10 minutes after every install the bot plans (what to save for,
  // which aug is nearest) with the income it had before the reset.
  // estimateIncomeRate re-seeds from this run's own earnings when it is absent.
  "_incomeSnap",
  "_incomeRatePerMs",
];

// Published state that describes a BITNODE rather than a run: kept across aug
// installs (a faction's last measured reputation rate is still the best
// planning number after one), dropped when the node changes - another node's
// rates were earned under other multipliers and other favor.
const STALE_IN_NEW_NODE = [
  "_repSnaps",
  "gordAugHolds",
];

/**
 * Drop what a new daemon run must not inherit from the last one. `g` is
 * globalThis (a plain object in the tests); `nodeStamp` is
 * ns.getResetInfo().lastNodeReset, which identifies the BitNode run.
 * @param {any} g @param {number} nodeStamp
 */
export function clearStaleState(g, nodeStamp) {
  for (const key of STALE_AT_BOOT) delete g[key];
  if (g.gordNodeStamp !== nodeStamp) {
    for (const key of STALE_IN_NEW_NODE) delete g[key];
    g.gordNodeStamp = nodeStamp;
  }
}

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
 * Is the achievement table lib/achievements.js publishes
 * (globalThis.gordAchievements) due a re-read? When there is none, when it is
 * older than `refreshMs`, and when it predates this BitNode - the run that just
 * ended is what awarded the achievements the campaign plan is about to ask
 * after, and lib/capabilities.js heldAchievements refuses such a table (the
 * plan then WAITS at a challenge step, so nothing would ever be finished).
 * A failed read is published too, so it is retried on the interval, not every
 * tick. Pure.
 * @param {any} published @param {number} now @param {number} refreshMs
 * @param {number} nodeResetAt - ns.getResetInfo().lastNodeReset
 */
export function achievementsDue(published, now, refreshMs, nodeResetAt) {
  const at = Number(published?.updatedAt);
  if (!Number.isFinite(at)) return true;
  return now - at > refreshMs || at < nodeResetAt;
}

/**
 * The RAM (GB) per host that Stanek's charge workers hold or are still to take,
 * from a LIVE helper state (lib/stanek.js publishes one row per planned host).
 * A charge worker never lands, and on a host in its plan the charge manager
 * takes whatever comes free until the plan is full - so none of this is room a
 * hold for a daemon helper could ever free, and the helper tick is told so
 * (beginHelperTick `taken`). What is left of a host beyond the plan (home's
 * stanek.homeReserveRam, the tail of a partly planned host) the charge manager
 * leaves alone, and that can be held. Pure.
 * @param {any} state globalThis.gordStanekState @param {number} now @param {number} staleMs
 * @returns {Record<string, number>}
 */
export function chargeTaken(state, now, staleMs) {
  const out = /** @type {Record<string, number>} */ ({});
  if (!state || !(now - (state.updatedAt ?? 0) <= staleMs)) return out;
  const threadRam = Number(state.ram?.threadRam) || 0;
  for (const r of Array.isArray(state.ram?.hosts) ? state.ram.hosts : []) {
    const gb = Math.max(Number(r?.threads) || 0, Number(r?.want) || 0) * threadRam;
    if (r?.host && gb > 0) out[r.host] = gb;
  }
  return out;
}

/**
 * The daemon main loop. See the file header for what each hook does; the order
 * of the helper launches below is the priority order for scarce off-home RAM:
 * the backdoor loop (unlocks the hacking factions), the sleeve manager (claims
 * RAM before the botnet fills the network), node extras, the gang and corp
 * managers (dedicated hosts, reserved from the botnet), then the botnet itself
 * and the luxury scripts.
 *
 * That order is also who gets RAM HELD for them first: a required helper (or a
 * manager) that finds no room has its size kept free of new batcher legs on one
 * host until it can be placed (lib/daemon-lib.js "Room for a required helper").
 *
 * ── The two reservation globals, and who writes them ──
 * globalThis.gordReservedHosts - whole hosts the botnet, the fleet manager and
 *   the helpers leave alone. A Set built fresh each tick below (the gang's and
 *   the corp's dedicated hosts while their manager is ON them, plus the node's
 *   reserveHosts hook) and published as soon as it is known; lib/corp-daemon.js
 *   republishes the same Set once the corp host is in it. Nobody else writes it.
 * globalThis.gordReservedRam - host -> GB a SHARED host must keep free of new
 *   batcher legs (hacking/manager.js reservedRamFor is the only reader that
 *   acts on it). While a daemon is ticking it is REPLACED once per tick, at the
 *   end, by the line that closes the helper tick: this tick's helper and
 *   manager holds, with the charge workers' holds folded in (the larger of the
 *   two on a shared host). Nothing else in the daemon writes it - not
 *   ensureGangManager any more - so a hold lives exactly as long as someone
 *   asks for it again each tick. Between daemon ticks lib/stanek.js edits the
 *   published object in place (its own entries only: it withdraws what it wrote
 *   last where the value is still its own, then merges its current holds); the
 *   next tick's replacement supersedes that. Before the daemon exists,
 *   early/driver.js replaces the map every driver tick the same way.
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
  clearStaleState(globalThis, caps.reset?.lastNodeReset);
  resetDonationMemory();

  let decideFailures = 0;

  while (true) {
    // Root the network FIRST so the helpers below have off-home hosts to land
    // on, and buy port openers when affordable to unlock bigger servers.
    await acceptInvites(ns);
    await buyDarkweb(ns);
    // The rooting pass is also the tick's ONE walk of the network: every helper
    // check from here to closeHelperTick (at the bottom of the loop) shares it,
    // and the holds they ask for are published there.
    beginHelperTick(ns, {
      own: self,
      taken: chargeTaken(globalThis.gordStanekState, Date.now(), cfg.ui.staleMs.helper),
    });

    // Backdoors ahead of every RAM-hungry helper: CSEC/avmnite-02h/I.I.I.I/
    // run4theh111z unlock the hacking factions, and the backdoor loop is only
    // ~9GB now that the 32GB finisher is its own script (launched by this same
    // call once the world daemon is ready, unless the node's plan or the
    // HUD's FINISH toggle holds it).
    const nextBN = hooks.plannedNextBN
      ? hooks.plannedNextBN(ns)
      : plannedNextNode(ns, cfg);
    ensureBackdoorHelpers(ns, node, nextBN, hooks.finishCallback);

    // The achievement reader (a 2.6GB one-shot): the campaign's challenge steps
    // are judged by which achievements are held, and until this has published a
    // table for THIS BitNode the plan waits at such a step - the halt sentinel,
    // i.e. no finish - rather than guess. Nothing else launches it.
    const A = cfg.achievements;
    if (A?.enabled && cfg.paths.achievements &&
        achievementsDue(globalThis.gordAchievements, Date.now(), A.refreshMs, caps.reset?.lastNodeReset ?? 0)) {
      ensureHelper(ns, cfg.paths.achievements, { optional: true });
    }

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
    // network. Where there are no sleeves at all (no BN10, no SF10) it is not
    // launched: it would print that and exit, every tick.
    if (caps.sleeves) {
      ensureHelper(ns, cfg.paths.sleeves, {
        optional: hooks.sleevesOptional ?? true,
        args: [node, caps.gang ? 1 : 0],
      });
    }
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
    // (Told the servers are unavailable it exits at once - so there it is not
    // required either, for the same reason as the sleeve manager above.)
    if (cfg.hacknet.enabled) {
      ensureHelper(ns, cfg.paths.hacknet, { optional: !caps.hacknetServer, args: [node, caps.hacknetServer ? 1 : 0] });
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

    const gangEvent = hooks.setupGang ? await hooks.setupGang(ns) : null;
    helperTickYielded(ns);
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
    // Home-RAM spending, after the backdoor helpers claimed their RAM.
    // Arg [0] is the home-RAM money reserve, [1] the node (so econ can resolve
    // its per-node config without paying for getResetInfo itself).
    ensureHelper(ns, cfg.paths.econ, {
      optional: true,
      args: [hooks.econArgs?.[0] ?? cfg.econ.homeRamReserve, node],
    });
    // The early-game hacknet NODE buyer: its own script, so the 4.5GB of
    // ns.hacknet.* is only paid while it is wanted - below
    // econ.hacknetMaxHackingLevel, and never where the RUN's config has
    // econ.hacknetNodes off. `cfg` here is the run's config (a challenge run's
    // overlay included), which is why the switch is thrown here and not in the
    // script: BN9's challenge is zero hacknet spending, and a script that is
    // never started spends nothing. (It stops itself on the same test, against
    // forNode(node) - it cannot afford the 1GB getResetInfo that forReset needs.)
    if (hacknetNodesWanted(cfg.econ, hackingLevel(ns))) {
      ensureHelper(ns, cfg.paths.hacknetNodes, { optional: true, args: [node] });
    }

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
    helperTickYielded(ns); // the decision awaited; see lib/daemon-lib.js
    hooks.afterDecide?.(ns, state);

    // Every helper has had its turn (afterDecide was the last place one is
    // launched from): close the tick and publish what it asks the botnet to keep
    // free, replacing last tick's map whole. Folded in: the RAM the gift's
    // charge workers are still waiting for on hosts the botnet has filled.
    // This is the daemon's only write to gordReservedRam - see the header.
    const holds = closeHelperTick(ns);
    globalThis.gordReservedRam = gift === "accepted"
      ? mergeHolds(holds, chargeHolds(globalThis.gordStanekState, Date.now(), cfg.ui.staleMs.helper))
      : holds;
    // The stamp is this daemon's pulse: the batcher stops honouring a map that
    // has not been rewritten for hacking.reservedRamMaxAgeMs, so a daemon that
    // died does not leave RAM held for helpers nobody will start.
    globalThis.gordReservedRamAt = Date.now();

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
