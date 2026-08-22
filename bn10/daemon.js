// bn10/daemon.js
//
// BN10 ("Digital Carbon") orchestrator. The shared skeleton is lib/daemon-core.js
// (runDaemon + decideAugFlow); BN10 has no punishing multiplier overrides - the
// ordinary economy runs like BN4 - so what makes this node different is one
// thing: duplicate SLEEVES.
//
// BN10 is the only place you can BUY extra sleeves and their memory, from The
// Covenant, and the whole value of sleeves is in their number + memory rather
// than in beating the node and moving on. So the plan (per the community wisdom
// this daemon encodes) is: build a THICK income stream the normal way, then buy
// EVERY sleeve The Covenant sells (the last costs ~1e20) and max memory (100) on
// each. That work is delegated to lib/sleeves.js, which the core launches
// off-home (it's ~72GB of ns.sleeve.* calls) - REQUIRED here rather than
// optional, since it is the point of the node.
//
// BITNODE[10].sleeves in lib/config.js turns the shop budgets up for exactly this
// reason: everywhere else a sleeve purchase is capped at a slice of cash, but here
// sleeves and memory are the point of the node - a sleeve bought now earns for the
// rest of a run that never resets, and memory is the ONE upgrade that carries into
// every future BitNode - so the manager buys at ~1.1x the price rather than waiting
// for 2x. lib/sleeves.js announces (once) when the shop is bought out; that's the
// cue to finish the node, since this daemon never does it on its own.
//
// The other persistent engines run alongside it: a CORPORATION (the core's shared
// corp machinery), a GANG once karma crosses the universal -54,000 gate while
// we're in a criminal faction, and GRAFTING (lib/grafting.js, off-home) - augs
// installed WITHOUT a reset, ideal for a long no-reset run, started only when
// decideNextPriority frees the player's work slot (gordGraftAllow) and its own
// cost model says grafting beats idle crime.
//
// Because the sleeve spree is a long, one-time shopping trip, this daemon CANNOT end
// the BitNode - that is the player's call alone, made by backdooring w0r1d_d43m0n by
// hand once the sleeve roster is complete (watch the SLEEVE dashboard tab). Two locks,
// both needed:
//   1. plannedNextBN always returns the halt sentinel, so lib/finish-bn.js is never
//      launched (and it refuses to run here even if launched by hand). No arg override.
//   2. BITNODE[10].backdoor.skipFinalHost keeps lib/backdoor.js off w0r1d_d43m0n for
//      the whole node. Lock 1 alone was not enough: the backdoor helper installs the
//      backdoor the moment hacking level allows, and on the world daemon that backdoor
//      IS the finish - it opens the BitVerse exactly like the terminal command.
// Everything else (CSEC, avmnite-02h, I.I.I.I, run4theh111z, The-Cave) is still
// backdoored normally, so the hacking factions unlock as usual.

import {
  doEarlyBootstrapIfNeeded,
  maybeCreatePrograms,
  maybeAutoTravelForReadyFaction,
  doIdleWork,
  clearFactionWork,
} from "../lib/player-actions.js";
import { getNextAugTarget, getMoneyHoardGoal } from "../lib/aug-targets.js";
import { forNode } from "../lib/config.js";
import { playerMoney, maybeBuyInfra, inGangSafe } from "../lib/daemon-lib.js";
import { runDaemon, decidePrelude, decideAugFlow, pursueNextFaction } from "../lib/daemon-core.js";
// Megacorp faction grinding (factions.pursueCompanyFactions): only this node
// imports it, so only this daemon pays for its Singularity calls.
import { makeCompanyWork } from "../lib/company-work.js";

// Every tunable value comes from lib/config.js, resolved for BitNode 10.
const CFG = forNode(10);
const GANG = CFG.gang;
const SELF = CFG.paths.daemon;                // this daemon's path (post-reset callback)
// Criminal factions that can found a gang; whichever we're already in gets used.
// Cast to any[] so its elements don't trip checkJs against FactionName - see
// [[bitburner-enum-string-casts]].
const CRIMINAL_FACTIONS = /** @type {any[]} */ (GANG.criminalFactions);

/**
 * Found a gang the moment we're eligible: karma past the gate AND already a member
 * of a criminal faction (acceptInvites joins those on the normal aug path). We
 * never grind toward it here - crime done for money sinks karma over a long run,
 * and this snaps the gang up when it crosses. Needs no player attention, so it
 * runs from the core's setupGang hook. Returns a status object worth reporting,
 * or null.
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
 * Always the HALT sentinel (<= 0), which ensureBackdoorHelpers reads as "do everything
 * else, but never launch the finisher". That is the whole BN10 strategy: buying every
 * sleeve + maxing memory only happens in this node and takes a full run, so we stay
 * and shop rather than smashing the node and leaving.
 *
 * There is deliberately NO arg override here (other daemons take one): BN10 ends only
 * when the PLAYER backdoors w0r1d_d43m0n by hand. The other half of that guarantee is
 * BITNODE[10].backdoor.skipFinalHost, which keeps lib/backdoor.js away from the world
 * daemon entirely.
 * @param {NS} ns
 */
function plannedNextBN(ns) {
  if (ns.args[0] != null) {
    ns.tprint(`WARN: ignoring next-BitNode arg ${ns.args[0]} - BN10 is manual-finish only (BITNODE[10].backdoor.skipFinalHost). Backdoor w0r1d_d43m0n yourself to leave.`);
  }
  return 0; // halt: the player finishes manually, after the sleeve shopping spree
}

// ── Strategy ─────────────────────────────────────────────────────────────────

/** @param {NS} ns */
async function decideNextPriority(ns) {
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

  const opportunities = decidePrelude(ns);

  const autoTravel = await maybeAutoTravelForReadyFaction(ns, opportunities);
  if (autoTravel) return { ...autoTravel, target: null, infra: null };

  const bootstrap = await doEarlyBootstrapIfNeeded(ns);
  if (bootstrap) return { ...bootstrap, target: null, infra: null };

  const programWork = await maybeCreatePrograms(ns);
  if (programWork) return { ...programWork, target: getNextAugTarget(ns), infra: null };

  const target = getNextAugTarget(ns);

  // Money-gated endgame invites (Daedalus / The Covenant / Illuminati, ...): when
  // we've met every requirement EXCEPT the big cash gate, hold cash instead of
  // spending it away before the invite can fire. gordMoneyFloor is respected by
  // buyAugs, maybeInstall, maybeBuyInfra here and by the sleeve manager off-home.
  // Only considered when there's no ordinary aug target left (i.e. "out of factions").
  const hoard = target ? null : getMoneyHoardGoal(ns);
  globalThis.gordMoneyFloor = hoard ? hoard.money : 0;

  const infra = await maybeBuyInfra(ns, target);

  // A graft already in progress (started off-home by lib/grafting.js) OWNS the
  // player's work slot: yield to it and issue no crime/faction work this tick,
  // which would cancel it and waste the time already sunk. This runs even when an
  // aug target has since appeared - the graft finishes first, then we resume. The
  // "Grafting" action publishes New Tokyo as the stay-city (see afterDecide), so
  // the auto-travel-home loop won't pull us out mid-graft.
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

  // No aug target: BN10's own version of the core's decideNoTarget, with the
  // money hoard, company work and grafting folded in.
  if (!target) {
    // Prefix surfacing the money-hoard, if one is active, so it's visible whatever
    // income activity we run underneath (spending is already blocked by the floor).
    const held = hoard
      ? `[holding $${ns.format.number(hoard.money)} for ${hoard.faction} invite, $${ns.format.number(hoard.moneyMissing)} to go] `
      : "";

    const factionPursuit = await pursueNextFaction(ns, opportunities, true);
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

  return decideAugFlow(ns, { cfg: CFG, target, infra, opportunities, incomeLabel: "Hacking" });
}

/**
 * Publish the company-grind city intent so maybeAutoTravelForReadyFaction won't
 * pull us home while we're deliberately parked in a megacorp's city for its rep
 * (only meaningful when companyWorkNeedsCity is on). Cleared on any other action.
 * Grafting reuses the same stay-city mechanism: while a graft is running (or
 * about to start), keep the player in New Tokyo so maybeAutoTravelForReadyFaction
 * doesn't yank us home and cancel/stall it.
 */
function publishStayCity(ns, state) {
  globalThis.gordCompanyCity = state?.action === "Company Work"
    ? state.companyCity ?? null
    : state?.action === "Grafting"
    ? CFG.grafting.city
    : null;
}

/**
 * Sleeve shopping progress - the thing this whole node is being played for, so
 * the status line gets the roster size, the next sleeve's price and the
 * outstanding memory, plus the gang roster.
 * @param {NS} ns
 */
function statusLine(ns) {
  const sleeves = globalThis.gordSleeveState;
  const sleeveNote = sleeves
    ? ` | Sleeves: ${sleeves.count}` +
      (sleeves.maxed ? " (max)" : ` (next $${ns.format.number(sleeves.nextCost)})`) +
      (sleeves.memoryDone ? " mem MAX" : ` mem -${sleeves.memoryRemainingLevels}`)
    : "";
  const gang = globalThis.gordGangState;
  const gangNote = gang ? ` | Gang: ${gang.members}/${gang.maxMembers} (${gang.faction})` : "";
  return sleeveNote + gangNote;
}

/** @param {NS} ns */
export async function main(ns) {
  await runDaemon(ns, {
    cfg: CFG,
    self: SELF,
    plannedNextBN,
    setupGang: maybeSetupGang,
    decide: decideNextPriority,
    // The BN10 headline act: the sleeve manager is required, not a luxury.
    sleevesOptional: false,
    // The grafting manager (VitaLife, New Tokyo): ~20GB of ns.grafting.*, off-home,
    // self-exits where the grafting API is unavailable.
    extraHelpers: [{ script: CFG.paths.grafting, optional: true }],
    companyWork: makeCompanyWork(CFG),
    afterDecide: publishStayCity,
    statusLine,
  });
}
