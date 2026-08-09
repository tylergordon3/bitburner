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
// ~72GB of ns.sleeve.* calls, far too heavy for home) and left running.
//
// BITNODE[10].sleeves in lib/config.js turns the shop budgets up for exactly this
// reason: everywhere else a sleeve purchase is capped at a slice of cash, but here
// sleeves and memory are the point of the node - a sleeve bought now earns for the
// rest of a run that never resets, and memory is the ONE upgrade that carries into
// every future BitNode - so the manager buys at ~1.1x the price rather than waiting
// for 2x. lib/sleeves.js announces (once) when the shop is bought out; that's the
// cue to finish the node, since this daemon never does it on its own.
//
// The other persistent engines run alongside it: a CORPORATION, and - once karma
// crosses the universal -54,000 gate while we're in a criminal faction - a GANG.
// Neither is BN10-specific (both just need their Source-File), and both are pure
// passive income + faction rep across a long run that never resets, so this daemon
// founds them when they're free to found and keeps their managers alive on
// dedicated, botnet-reserved cloud hosts (ensureCloudManagers).
//
// Because the sleeve spree is a long, one-time shopping trip, this daemon
// deliberately does NOT auto-destroy w0r1d_d43m0n (plannedNextBN returns the halt sentinel):
// backdoor.js still backdoors everything, but you finish manually once the sleeve
// roster is complete (watch the SLEEVE dashboard tab). Pass a node number as
// arg[0] to override and auto-progress.

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
  clearFactionWork,
} from "../lib/player-actions.js";
import {
  getNextAugTarget,
  getAllAugCandidates,
  getUnjoinedFactionOpportunities,
  getMoneyHoardGoal,
} from "../lib/aug-targets.js";
import { forNode } from "../lib/config.js";
// Shared daemon core - see lib/daemon-lib.js for what is shared and what each
// daemon still owns.
import {
  playerMoney,
  hackingLevel,
  ensureHelper,
  ensureBackdoorHelpers,
  ensureGangManager,
  inGangSafe,
  gangFactionName,
  buyAugs,
  maybeInstall,
  maybeBuyInfra,
  startBestFactionWork,
  maybeDoSecondaryFactionWork,
  buyDarkweb,
  rootEverything,
  acceptInvites,
  readLastResetTime,
  writeResetTime,
  consumeResetSummary,
} from "../lib/daemon-lib.js";
// Shared corporation orchestration (all corp-viable nodes) - see lib/corp-daemon.js.
import { maybeSetupCorp, ensureCorpManagers } from "../lib/corp-daemon.js";

// Every tunable value comes from lib/config.js, resolved for BitNode 10 (see
// BITNODE there - BN10 has no multiplier overrides, just its daemon path).
const CFG = forNode(10);
const AUGS = CFG.augs;
const GANG = CFG.gang;
const FACTION_REQUIREMENTS = CFG.factions.requirements;

// Off-home helper scripts (shared by every daemon) that keep this daemon's HOME
// footprint small: each carries the expensive Singularity/Hacknet/Sleeve calls it
// needs, and running them off-home means those never count against the daemon's RAM.
const ECON_SCRIPT = CFG.paths.econ;           // hacknet + home-RAM spending
const SLEEVE_SCRIPT = CFG.paths.sleeves;      // buy sleeves + memory, keep them working
const GRAFT_SCRIPT = CFG.paths.grafting;      // graft augs (no reset) during idle time
const SELF = CFG.paths.daemon;                // this daemon's path (post-reset callback)
// Criminal factions that can found a gang; whichever we're already in gets used.
// Cast to any[] so its elements don't trip checkJs against FactionName - see
// [[bitburner-enum-string-casts]].
const CRIMINAL_FACTIONS = /** @type {any[]} */ (GANG.criminalFactions);

/**
 * Found a gang the moment we're eligible: karma past the gate AND already a member
 * of a criminal faction (acceptInvites joins those on the normal aug path). We
 * never grind toward it here - crime done for money sinks karma over a long run,
 * and this snaps the gang up when it crosses. Returns a status object worth
 * reporting, or null.
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

/**
 * Keep the cloud-hosted managers (gang, corp) alive on their dedicated hosts and
 * publish the botnet reservation so hacking/manager.js and lib/pserv.js leave
 * those hosts alone. Rebuilt fresh each tick so a kill/relaunch heals it.
 *
 * Gang goes first so cloud-gang is reserved before ensureCorpManagers goes looking
 * for off-home RAM. lib/gang.js is ~36GB - without a dedicated host it loses every
 * race against the botnet, which is exactly how a hand-created gang ends up with
 * no manager running at all.
 * @param {NS} ns
 */
function ensureCloudManagers(ns) {
  const reserved = new Set();

  // Gang first: lib/gang.js is ~36GB and loses any race for shared RAM, so its host
  // has to be reserved before the corp goes looking for somewhere to run.
  ensureGangManager(ns, reserved);
  globalThis.gordReservedHosts = reserved;

  // Corp: places corp-steady on the reserved cloud-corp host (adding it to
  // `reserved` + republishing) and rotates the build phases. Self-gates on
  // corp.enabled / hasCorporation, so it's a no-op before the corp exists.
  ensureCorpManagers(ns, reserved);
}

/**
 * The BitNode to enter when lib/finish-bn.js destroys w0r1d_d43m0n. Default is the
 * HALT sentinel (<= 0), which ensureBackdoorHelpers reads as "backdoor everything
 * but DON'T auto-destroy" (it never launches the finisher, and announces once
 * instead). That's the whole BN10 strategy: buying every sleeve + maxing
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
async function decideNextPriority(ns) {
  estimateIncomeRate(ns);
  const currentTarget = globalThis.gordState?.target;
  if (currentTarget?.faction) updateRepRate(ns, currentTarget.faction);

  // Default the player slot to "not free for grafting"; only the genuinely-idle
  // fallback below opts back in. Set every tick so a stale `true` from a prior
  // idle tick can't let the off-home grafting helper steal the slot once we've
  // found real work to do. See lib/grafting.js for the coordination contract.
  globalThis.gordGraftAllow = false;

  // Same idea for the faction grind the sleeve manager shadows: clear it here and
  // let whichever path actually issues faction work this tick re-publish it, so a
  // tick that moves on to crime/grafting can't leave sleeves working a stale
  // faction. See recordFactionWork in lib/player-actions.js.
  clearFactionWork();

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

  // A graft already in progress (started off-home by lib/grafting.js) OWNS the
  // player's work slot: yield to it and issue no crime/faction work this tick,
  // which would cancel it and waste the time already sunk. This runs even when an
  // aug target has since appeared - the graft finishes first, then we resume. The
  // "Grafting" action publishes New Tokyo as the stay-city (see main), so the
  // auto-travel-home loop won't pull us out mid-graft.
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

    // Genuinely out of faction work: the player's work slot is now truly idle, so
    // free it for grafting (the ONLY place we set this true) and let the off-home
    // grafting helper's cost model decide. It reports `worthwhile` when grafting
    // the best affordable aug beats idle crime in money-per-player-time (and we're
    // under the entropy cap); if so, yield the slot to it rather than criming. It
    // travels to New Tokyo and grafts next tick; "Grafting" sets the stay-city so
    // auto-travel won't fight it. During a money hoard the spend floor makes
    // nothing affordable, so `worthwhile` is false and idle crime runs as before.
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

    // Not grafting -> ordinary idle work (crime/study/rep-banking). This still
    // earns toward the hoard while the money floor stops us spending it.
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

  // Combat-stat requirements for current faction
  const statTargets = FACTION_REQUIREMENTS[target.faction] ?? {};
  const training = await trainCombatIfNeeded(ns, statTargets);
  if (training) {
    return { ...training, target, infra };
  }

  // Rep still needed
  if (target.repMissing > 0) {
    // A gang faction's rep accrues passively from gang respect, and workForFaction
    // isn't even offered for it - so spend the player's attention elsewhere and let
    // the gang do the work.
    if (target.faction === gangFactionName(ns)) {
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
        if (target.faction === gangFactionName(ns)) return false; // passive rep, see above
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

    // Focus mode, rep already met - money is the only gate. Crime is the best
    // focused money source; sleeves keep criming in the background too.
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

    // Backdoors FIRST, ahead of every RAM-hungry helper below. CSEC/avmnite-02h/
    // I.I.I.I/run4theh111z are what unlock CyberSec, NiteSec, The Black Hand and
    // BitRunners, and the backdoor loop only needs ~9GB now that the 32GB BitNode
    // finisher is its own script (lib/finish-bn.js, launched by this same call once
    // the world daemon is backdoored). Launched after the botnet it used to lose the
    // race for RAM and never install a single backdoor.
    ensureBackdoorHelpers(ns, plannedNextBN(ns));

    // The BN10 headline act: the sleeve manager (buy every sleeve + max memory +
    // keep them working). It's ~72GB of ns.sleeve.* calls, so it runs off-home
    // like the gang manager; ensureHelper places it on the roomiest rooted host.
    // Launched first so it can claim RAM before the botnet fills the network.
    // Early on there may be no host with room - it simply starts later, once the
    // network (and our cash) have grown enough for sleeves to matter anyway.
    ensureHelper(ns, SLEEVE_SCRIPT);

    // The grafting manager (VitaLife, New Tokyo): a second RAM-heavy off-home
    // helper (~20GB of ns.grafting.*). It permanently installs augs WITHOUT a
    // reset - ideal for BN10's long no-reset run - but only when decideNextPriority
    // frees the player's work slot (gordGraftAllow) and its own cost model says
    // grafting beats idle crime. Self-exits where the grafting API is unavailable.
    ensureHelper(ns, GRAFT_SCRIPT, { optional: true });

    // Gang + corporation, both persistent passive engines here. maybeSetupGang
    // founds a gang the moment karma + a criminal faction line up (and is a no-op
    // if you founded one by hand); maybeSetupCorp does the same for the corp,
    // self-gated on corp.enabled / affordability. ensureCloudManagers then keeps
    // BOTH managers alive on their dedicated, botnet-reserved cloud hosts - the
    // gang first, since lib/gang.js is ~36GB and loses any race for shared RAM.
    const gangEvent = maybeSetupGang(ns);
    const corpEvent = maybeSetupCorp(ns);
    ensureCloudManagers(ns);

    // Botnet income engine, then UI/luxury scripts, all off-home.
    ensureHelper(ns, CFG.paths.manager);
    ensureHelper(ns, CFG.paths.dashboard);
    ensureHelper(ns, CFG.paths.stocks, { optional: true });

    // Coding-contract solver (universal across all nodes): solves .cct files
    // network-wide for money/rep/karma, skipping unknown types. Off-home + optional
    // (waits quietly for RAM), since contracts are rare and non-urgent.
    ensureHelper(ns, CFG.paths.contracts, { optional: true });

    // Hacknet + home-RAM spending, off-home (the backdoor helpers went up first).
    ensureHelper(ns, ECON_SCRIPT, { optional: true });

    globalThis.gordState = await decideNextPriority(ns);
    // Surface a fresh corp/gang creation over the routine priority.
    if (corpEvent) globalThis.gordState = { ...globalThis.gordState, ...corpEvent };
    else if (gangEvent?.action === "Gang Created") globalThis.gordState = { ...globalThis.gordState, ...gangEvent };

    // Publish the company-grind city intent so maybeAutoTravelForReadyFaction won't
    // pull us home while we're deliberately parked in a megacorp's city for its rep
    // (only meaningful when companyWorkNeedsCity is on). Cleared on any other action.
    // Grafting reuses the same stay-city mechanism: while a graft is running (or
    // about to start), keep the player in New Tokyo so maybeAutoTravelForReadyFaction
    // doesn't yank us home and cancel/stall it.
    globalThis.gordCompanyCity = globalThis.gordState?.action === "Company Work"
      ? globalThis.gordState.companyCity ?? null
      : globalThis.gordState?.action === "Grafting"
      ? CFG.grafting.city
      : null;

    const bought = buyAugs(ns);
    if (bought?.length) {
      globalThis.gordState.purchases = bought;
    }

    globalThis.gordAugPipeline = getAllAugCandidates(ns).slice(0, AUGS.pipelineSize);

    maybeInstall(ns, SELF);

    // Sleeve shopping progress - the thing this whole node is being played for, so
    // it gets the roster size, the next sleeve's price and the outstanding memory.
    const sleeves = globalThis.gordSleeveState;
    const sleeveNote = sleeves
      ? ` | Sleeves: ${sleeves.count}` +
        (sleeves.maxed ? " (max)" : ` (next $${ns.format.number(sleeves.nextCost)})`) +
        (sleeves.memoryDone ? " mem MAX" : ` mem -${sleeves.memoryRemainingLevels}`)
      : "";
    const gang = globalThis.gordGangState;
    const gangNote = gang ? ` | Gang: ${gang.members}/${gang.maxMembers} (${gang.faction})` : "";
    ns.print(
      `Money: ${ns.format.number(playerMoney(ns))} | Hack: ${hackingLevel(ns)}${sleeveNote}${gangNote}`
    );
    await ns.sleep(CFG.daemon.tickMs);
  }
}
