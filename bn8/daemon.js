// bn8/daemon.js
//
// BN8 ("Ghost of Wall Street") orchestrator. The shared skeleton is
// lib/daemon-core.js (runDaemon + decideAugFlow); what this file owns is BN8's
// strategy, which follows from its multipliers (bitburner-src BitNode.tsx and
// Prestige.ts, verified 2026-10-03):
//
//   ScriptHackMoneyGain 0 (on ScriptHackMoney 0.3)   a hack still drains the server and
//                                                    still moves its stock; it pays $0
//   CompanyWorkMoney, CrimeMoney, HacknetNodeMoney,
//   ManualHackMoney, CodingContractMoney,
//   InfiltrationMoney, DarknetMoneyMultiplier  0     no other income either
//   CorporationValuation/Softcap/Divisions     0     no corporation
//   GangSoftcap 0, BladeburnerRank 0                 no gang, no Bladeburner
//   FavorToDonateToFaction 0                         every faction SELLS reputation
//   CloudServerSoftcap 4                             big purchased servers are dear
//   $250m at the start and after EVERY install, WSE + TIX API free, shorts and
//   limit/stop orders unlocked; 4S data at the normal price, kept across installs
//
// So money is the stock market and nothing else, and everything else is bought
// with it: lib/stocks.js is the node's engine (launched first, required), and
// this daemon's job is the three things the trader can't do for itself.
//
// 1. THE TREASURY. The trader's capital is the player's money, and every
//    spender in the repo budgets against the cash it can see. Left alone they
//    would spend the capital before it compounded - the purchased-server budget
//    alone takes 10% of visible cash every 15 seconds. So the capital is fenced:
//    this daemon runs an ALLOWANCE (lib/stocks-logic.js allowanceStep - a
//    dividend of the trading profit, CONFIG.stocks.treasury) and publishes it as
//    globalThis.gordStockCashWanted; the trader keeps that much liquid and
//    publishes globalThis.gordMoneyFloor = cash - allowance, which is the one
//    line every spender already respects (buyAugs and its donations, home RAM,
//    sleeve augs, grafts). Only the allowance is ever "spendable" - and it goes
//    to COMPUTE: home RAM and cores (lib/econ.js, econ.homeBeforeFleet - home is
//    the only compute an install keeps) and purchased servers (bought here with
//    lib/pserv.js directly, since maybeBuyInfra pauses under any floor).
//
// 2. THE INSTALL BATCH. Augs are NOT bought during a run: each queued aug makes
//    every later one ~1.9x dearer, and an install takes the whole capital, so
//    buying as the allowance trickled in bought the cheapest first (the worst
//    order) out of a book compounding at ~40%/h. Instead, inside the daemon's
//    tick, afterDecide raises the floor to ALL of the cash just before buyAugs
//    runs (statusLine puts it back after maybeInstall - nothing else runs in
//    between), so buyAugs buys nothing and maybeInstall never installs. When
//    waiting stops paying (lib/bn8-logic.js releaseDecision: the book's growth
//    is worth fewer than minAugsPerHour augs an hour, or the run is old) the
//    batch starts:
//      raise - the trader is asked to hold the whole book in cash (a hoard
//              bigger than net worth: it sells everything, buys nothing, and
//              still fences it all from the other spenders);
//      buy   - the fence opens inside the tick for buyAugs alone, which buys
//              dearest first (nextAugPurchase), donating for reputation; the
//              install (thresholds of 1 in BITNODE[8]) waits in beforeInstall
//              until a tick queues nothing more (prerequisite chains need a
//              second pass), then maybeInstall dumps the rest into NeuroFlux.
//    The run that can reach Daedalus (30 installed, hacking 2500 in sight)
//    holds the batch for the invite, so The Red Pill is bought in it; once The
//    Red Pill is installed there is no next install and nothing is bought.
//
// 3. CASH THAT ONLY HAS TO BE SEEN. Faction invites check liquid money (a city
//    faction's $15-50m, Daedalus's $100b). With the capital in stock that is
//    never there, so the amount goes to the trader as a `hoard`: held in cash,
//    fenced from the spenders, released when the invite lands. Only when net
//    worth covers it comfortably - otherwise we would sit in cash, not growing,
//    waiting for money that isn't coming.
//
// 4. THE PLAYER'S SLOT. Nothing the player can do earns money here (crime pays
//    x0), so the slot earns what money can't buy cheaply: reputation (a
//    donation costs $1m per faction_rep point of reputation - working for it is
//    free), megacorp company reputation (their factions sell most of the hacking
//    multiplier past the hacker factions'), then hacking exp towards the world
//    daemon's level 3000. Grafting (SF10, off-home lib/grafting.js) takes the
//    slot when it is free: an aug without a reset is worth more here than
//    anywhere, since a reset costs the whole capital.
//
// Stock manipulation - the batcher flagging its grows/hacks so they move the
// stocks we hold - is the trader's wish list (gordStockWishes) and
// hacking/manager.js's business; this daemon only keeps both running.
//
// RAM: the same Netscript calls as bn9/daemon.js minus its ns.scan, plus
// lib/company-work.js (7GB: the megacorp grind); lib/stocks-logic.js and
// lib/bn8-logic.js are 0GB. `run tools/self-test.js` prints the exact figure.

import {
  doEarlyBootstrapIfNeeded,
  maybeCreatePrograms,
  maybeAutoTravelForReadyFaction,
  clearFactionWork,
  studyHacking,
} from "../lib/player-actions.js";
import { getNextAugTarget, getMoneyHoardGoal, factionRepStillUseful } from "../lib/aug-targets.js";
import { forNode } from "../lib/config.js";
import { startBestFactionWork, worldDaemonLevel } from "../lib/daemon-lib.js";
import { playerMoney, hackingLevel } from "../lib/ns-utils.js";
import { managePurchasedServers } from "../lib/pserv.js";
import { runDaemon, decidePrelude, decideAugFlow, pursueNextFaction } from "../lib/daemon-core.js";
import { makeCompanyWork } from "../lib/company-work.js";
import { emitEvent } from "../lib/events.js";
import { sourceFileLevel } from "../lib/capabilities.js";
import { liveTrader, treasuryStep } from "../lib/stocks-logic.js";
import {
  augPriceStep, augsPerHour, batchPhase, hoursToLevel, ratePerHour, recordSample, releaseDecision,
} from "../lib/bn8-logic.js";

// Every tunable value comes from lib/config.js, resolved for BitNode 8.
const CFG = forNode(8);
const ST = CFG.stocks;
const TR = ST.treasury;
const RL = TR.release;
const PL = CFG.player;
const SELF = CFG.paths.daemon;                // this daemon's path (post-reset callback)
const FINAL_HOST = CFG.backdoor.finalHost;
const RED_PILL = CFG.augs.redPill;

// ── Treasury ─────────────────────────────────────────────────────────────────

// Module scope is NOT per run: the game caches a script's module until its
// source changes (bitburner-src NetscriptJSEvaluator.ts moduleCache), so these
// survive an aug install exactly as globalThis does. Everything here is
// therefore tied to the install it belongs to (`epoch`, getResetInfo's
// lastAugReset) and dropped when that changes - an install takes the money
// back to $250m, and books that remember the last run's billions pay nothing
// out of it.

/** treasuryStep's book between ticks: the allowance (`purse`) and the running
 *  total of what everything but the trader has spent. */
let _book = /** @type {any} */ (null);
/** Cash a faction invite needs to see: { amount, until, epoch, faction }. */
let _joinHold = /** @type {{amount: number, until: number, epoch: number, faction?: string} | null} */ (null);
/** Gross wealth (net worth + all spent) and hacking exp, sampled: { epoch, gross, exp }. */
let _hist = /** @type {{epoch: number, gross: {t: number, v: number}[], exp: {t: number, v: number}[]} | null} */ (null);
/** The install batch under way, if any (lib/bn8-logic.js batchPhase). */
let _batch = /** @type {{epoch: number, phase: string, since: number, lastQueued: number, reason: string} | null} */ (null);
/** A batch that queued nothing is not tried again before this: { epoch, at }. */
let _retry = /** @type {{epoch: number, at: number} | null} */ (null);
/** The last release decision, for the status line. */
let _decision = /** @type {{release: boolean, reason: string | null, why: string} | null} */ (null);
/** The floor as it stood before afterDecide fenced the aug buyer off (statusLine restores it). */
let _floorBeforeFence = /** @type {number | null} */ (null);

/** The install this run belongs to. (The daemon pays getResetInfo already.) @param {NS} ns */
function epochOf(ns) {
  return ns.getResetInfo().lastAugReset;
}

/** The trader's published state, if it is alive - and this run's. @param {NS} ns */
function traderState(ns) {
  return liveTrader(globalThis.gordStockState, { now: Date.now(), staleMs: ST.stateStaleMs, epoch: epochOf(ns) });
}

/** This run's batch, if one is under way. @param {NS} ns */
function batchOf(ns) {
  if (_batch && _batch.epoch !== epochOf(ns)) _batch = null; // the last run's
  return _batch;
}

/**
 * The aug picture the release decision needs. getOwnedAugmentations and the
 * player's factions/exp - all calls the daemon pays for already.
 * @param {NS} ns
 */
function augPicture(ns) {
  const s = ns.singularity;
  const installed = s.getOwnedAugmentations(false);
  const owned = s.getOwnedAugmentations(true);
  const player = ns.getPlayer();
  return {
    installedAugs: installed.length,
    finalRun: installed.includes(RED_PILL),
    redPillOwned: owned.includes(RED_PILL),
    daedalusJoined: (player.factions ?? []).includes("Daedalus"),
    hackExp: player.exp?.hacking ?? 0,
    // The level's multiplier: BN8's HackingLevelMultiplier is 1.
    hackMult: player.mults?.hacking ?? 1,
  };
}

/**
 * Start a batch when releaseDecision says so (never in the last run, never
 * while an earlier attempt's retry wait runs), move it from raise to buy, and
 * give it up if a buying tick queued nothing at all.
 * @param {NS} ns @param {number} netWorth @param {any} trader
 */
function stepBatch(ns, netWorth, trader) {
  const now = Date.now();
  const epoch = epochOf(ns);
  const elapsedMs = now - epoch;
  const pic = augPicture(ns);
  const gross = netWorth + (_book ? _book.outflowBase + _book.traderOutflow : 0);
  if (!_hist || _hist.epoch !== epoch) _hist = { epoch, gross: [], exp: [] };
  const keep = 2 * RL.windowMs;
  _hist.gross = recordSample(_hist.gross, { t: now, v: gross }, keep, 60_000);
  _hist.exp = recordSample(_hist.exp, { t: now, v: pic.hackExp }, keep, 60_000);

  let batch = batchOf(ns);
  if (!batch && !(_retry && _retry.epoch === epoch && now < _retry.at)) {
    const step = augPriceStep(sourceFileLevel(ns.getResetInfo(), 11));
    _decision = releaseDecision({
      elapsedMs,
      netWorth,
      augsPerHour: augsPerHour(_hist.gross, RL.windowMs, step),
      finalRun: pic.finalRun,
      installedAugs: pic.installedAugs,
      daedalusJoined: pic.daedalusJoined,
      redPillOwned: pic.redPillOwned,
      hoursToDaedalus: hoursToLevel({
        level: RL.daedalusHacking, exp: pic.hackExp, mult: pic.hackMult, expPerHour: ratePerHour(_hist.exp, RL.windowMs),
      }),
    }, RL);
    if (_decision.release) {
      batch = _batch = { epoch, phase: "raise", since: now, lastQueued: -1, reason: _decision.reason ?? "" };
      emitEvent(`[*] BN8 install batch (${_decision.reason}): ${_decision.why} - selling the book, then buying dearest first`, "sys");
    }
  }
  if (!batch) return null;

  batch = _batch = /** @type {any} */ (batchPhase(batch, { now, bookValue: trader?.totalValue ?? 0, netWorth }, RL));
  // A buying tick has been and gone and nothing is queued: nothing on offer
  // could be bought. Or the install never came (maybeInstall declined every
  // reason - e.g. the core's Daedalus lock with The Red Pill still out of
  // reach): the cash must not sit fenced for ever. Back to trading either way;
  // what was bought stays queued for the next batch.
  const snap = globalThis.gordAugSnapshot;
  const nothing = now - batch.since > 2 * CFG.daemon.tickMs &&
    !!snap && (snap.updatedAt ?? 0) > batch.since && (snap.queued ?? 0) === 0;
  if (batch.phase === "buy" && (nothing || now - batch.since > 2 * RL.buyTimeoutMs)) {
    emitEvent(`[!] BN8 install batch ${nothing ? "bought nothing" : "never installed"} - back to trading`, "sys");
    _batch = null;
    _retry = { epoch, at: now + RL.retryMs };
    return null;
  }
  return batch;
}

/**
 * One tick of the treasury: advance the allowance, publish it for the trader
 * (with any hoard - during an install batch, the whole book), keep the fence
 * up ourselves while no trader is alive to, and tell the aug buyer what
 * "income" means here.
 * @param {NS} ns @param {number} hoard - cash an invite needs to see
 * @returns {{allowance: number, netWorth: number, batch: any, trader: any}}
 */
export function runTreasury(ns, hoard) {
  const cash = playerMoney(ns);
  const trader = traderState(ns);

  // The books: what everything but the trader has spent (the trader measures
  // it exactly while it runs - it knows its own trades; before it is up, and
  // BN8's first minutes are precisely that, any drop in cash is spending), and
  // the allowance that follows. Started afresh after every install.
  _book = treasuryStep(_book, { epoch: epochOf(ns), cash, trader }, TR);
  const purse = _book.purse;
  const netWorth = _book.netWorth;

  const batch = stepBatch(ns, netWorth, trader);
  // During a batch the trader holds EVERYTHING in cash (a hoard over net worth
  // sells every position and buys none) and the allowance is 0, so its floor
  // is all the cash: nothing but buyAugs, inside our tick, ever sees a dollar.
  // `release` stays false: it would make the trader publish a floor of 0 for
  // every other spender between our ticks.
  const allowance = batch ? 0 : purse.wanted;
  const held = batch ? Math.max(hoard, 2 * netWorth + 1) : hoard;
  globalThis.gordStockCashWanted = { amount: allowance, hoard: held, release: false, updatedAt: Date.now() };
  // The trader republishes the floor after every trade; this is the same line
  // for the ticks it isn't running (the cold start, the first tick after an
  // install, a helper that lost its host).
  if (!trader) globalThis.gordMoneyFloor = Math.max(0, cash - allowance);

  // buyAugs weighs a donation against the time income takes to earn it back.
  // Measured income is zero here (no money source but stock, which
  // estimateIncomeRate rightly doesn't count), so give it what really arrives
  // in the purse - and nothing while a batch buys: whatever fits is bought now.
  const payout = (trader?.tier ?? 0) >= 2 ? TR.payout : TR.payoutPre4S;
  globalThis._incomeRatePerMs = batch ? 0 : Math.max(0, trader?.incomePerMs ?? 0) * payout;

  return { allowance, netWorth, batch, trader };
}

/**
 * Cash a pending invite needs to see, if net worth covers it with room to
 * spare: the money-gated endgame invites (getMoneyHoardGoal - Daedalus, The
 * Covenant, Illuminati: every one sells an aug we want, and Daedalus The Red
 * Pill) and whatever city faction the idle branch found itself "saving" for
 * last tick. Looked for with or without an aug target - nothing is bought
 * during a run here, so the targets never "run out". The hold outlives the
 * moment the cash is there (getMoneyHoardGoal then has nothing to report) by
 * joinHoldMs, so the invite check gets to see it.
 * @param {NS} ns
 */
function inviteHoard(ns) {
  const netWorth = traderState(ns)?.netWorth ?? playerMoney(ns);
  const epoch = epochOf(ns);
  if (_joinHold && _joinHold.epoch !== epoch) _joinHold = null; // the last run's
  const big = getMoneyHoardGoal(ns);
  if (big && netWorth >= big.money * TR.hoardNetWorthMult) {
    _joinHold = { amount: big.money, until: Date.now() + TR.joinHoldMs, epoch, faction: big.faction };
  }
  if (_joinHold && Date.now() < _joinHold.until && netWorth >= _joinHold.amount * TR.hoardNetWorthMult) {
    return { amount: _joinHold.amount, faction: _joinHold.faction ?? "" };
  }
  return { amount: 0, faction: "" };
}

/**
 * Purchased servers, out of the allowance: lib/pserv.js with the fence as its
 * reserve and the infra budget's free-treasury fraction. (maybeBuyInfra would
 * report "Holding Cash" for ever - it reads any money floor as an invite hoard.)
 * They are the botnet's RAM: hacking exp, and the leverage behind every stock
 * the batcher is asked to push. No flat ceiling here (stocks.treasury.servers), but
 * nothing dearer a GB than its maxCostPerGb - past that, home RAM (lib/econ.js,
 * which an install keeps) is the better buy. An install deletes them, so none
 * while a batch is under way.
 * @param {NS} ns @param {any} batch
 */
async function buyServers(ns, batch) {
  if (batch) return null;
  const fence = globalThis.gordMoneyFloor ?? 0;
  return await managePurchasedServers(ns, fence, CFG.infra.noTarget.spendFraction, TR.servers.hardSpendCap, TR.servers.maxCostPerGb);
}

// ── The player's slot ────────────────────────────────────────────────────────
// (The world daemon's hacking requirement - 3000 here - is lib/daemon-lib.js
// worldDaemonLevel; 0 until the game will say.)

/**
 * Free reputation: work for a joined faction that still has something to sell
 * us (NeuroFlux counts - the pre-install dump buys as many levels as its
 * reputation allows). Every point earned here is $1m / faction_rep the
 * treasury doesn't have to donate.
 * @param {NS} ns
 */
function bankReputation(ns) {
  const owned = new Set(ns.singularity.getOwnedAugmentations(true));
  for (const faction of ns.getPlayer().factions ?? []) {
    if (!factionRepStillUseful(ns, faction, owned, { includeNFG: true, requirePrereqs: false })) continue;
    const type = startBestFactionWork(ns, faction);
    if (type) return { action: "Faction Rep (idle)", detail: `${faction} (${type}) - reputation the treasury won't have to buy` };
  }
  return null;
}

/** Study: hacking exp towards the world daemon's gate. @param {NS} ns */
function study(ns) {
  const need = worldDaemonLevel(ns);
  const note = studyHacking(ns);
  return {
    action: "Studying (idle)",
    detail: `Hacking ${hackingLevel(ns)}${need ? `/${need} for ${FINAL_HOST}` : ""}${note}`,
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
  const target = getNextAugTarget(ns);

  // The treasury goes before anything that spends: the fence has to be up
  // before the first of them looks at the cash.
  const hoard = inviteHoard(ns);
  const purse = runTreasury(ns, hoard.amount);

  const autoTravel = await maybeAutoTravelForReadyFaction(ns, opportunities);
  if (autoTravel) return { ...autoTravel, target: null, infra: null };

  // The early bootstrap's first half only: study to the starting hacking level.
  // Its second half mugs for TOR/BruteSSH money - which pays nothing here, and
  // with $250m in hand the darkweb purchases went through on the first tick.
  if (hackingLevel(ns) < PL.earlyHackTarget) {
    const bootstrap = await doEarlyBootstrapIfNeeded(ns);
    if (bootstrap) return { ...bootstrap, target: null, infra: null };
  }

  const programWork = await maybeCreatePrograms(ns);
  if (programWork) return { ...programWork, target, infra: null };

  const infra = await buyServers(ns, purse.batch);

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

  // No aug target - or one whose reputation is already there, which the core's
  // decideAugFlow would "save" for with crime (x0 here: CrimeMoney 0) when
  // nothing is bought during a run anyway (the install batch buys it). BN8's
  // own version of the core's decideNoTarget: faction travel/training and the
  // megacorp company grind (pursueNextFaction, with lib/company-work.js
  // wired in), reputation still worth banking, grafts, then study.
  if (!target || !(target.repMissing > 0)) {
    const held = hoard.amount > 0
      ? `[holding $${ns.format.number(hoard.amount)} liquid${hoard.faction ? ` for the ${hoard.faction} invite` : " for a faction invite"}] `
      : "";

    const pursuit = await pursueNextFaction(ns, opportunities, true);
    if (pursuit) {
      // Blocked on a faction's join money: that is cash to be SEEN, so ask the
      // trader to hold it (next tick, through inviteHoard) and carry on below.
      if (pursuit.action === "Saving for Faction") {
        if (pursuit.joinMoneyMissing > 0) {
          _joinHold = {
            amount: playerMoney(ns) + pursuit.joinMoneyMissing + PL.travelCost,
            until: Date.now() + TR.joinHoldMs,
            epoch: epochOf(ns),
          };
        }
      } else {
        // Travel / training actually use the slot - return them.
        return { ...pursuit, detail: held + pursuit.detail, target: null, infra };
      }
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

    const idle = bankReputation(ns) ?? study(ns);
    const why = pursuit ? ` | ${pursuit.detail}` : "";
    return { ...idle, detail: held + idle.detail + why, target: null, infra };
  }

  return decideAugFlow(ns, { cfg: CFG, target, infra, opportunities, incomeLabel: "Trading" });
}

/**
 * After the decision: keep the player in New Tokyo while a graft runs (or is
 * about to), so the auto-travel-home loop doesn't yank us out of VitaLife.
 *
 * And the aug fence. runDaemon calls buyAugs and then maybeInstall right after
 * this, with no await in between, and statusLine right after them - so what
 * the floor is from here to statusLine is what those two alone see. Outside a
 * batch's buying phase it is ALL of the cash: buyAugs buys nothing (and
 * donates nothing), and maybeInstall, which never installs over a floor, does
 * nothing. In the buying phase it is 0: buyAugs spends the raised book dearest
 * first and the install can follow. statusLine puts back what the trader had
 * published, so the allowance's spenders never see either.
 * @param {NS} ns @param {any} state
 */
export function afterDecide(ns, state) {
  globalThis.gordCompanyCity = state?.action === "Grafting" ? CFG.grafting.city : null;
  _floorBeforeFence = globalThis.gordMoneyFloor ?? 0;
  const buying = batchOf(ns)?.phase === "buy";
  // (At least $1: a floor of 0 is what "no fence" means to maybeInstall.)
  globalThis.gordMoneyFloor = buying ? 0 : Math.max(1, playerMoney(ns));
}

/**
 * maybeInstall's last word before the reset: only inside this node's batch
 * (it cannot get here otherwise - the floor is never 0 outside one), and only
 * once a buying tick has queued nothing more than the one before it. The
 * options buyAugs sees are fixed per tick, so an aug whose prerequisite was
 * bought this tick is only on offer the next; one more tick, and a whole
 * chain is in. buyTimeoutMs bounds it.
 * @param {NS} ns
 */
export function beforeInstall(ns) {
  const batch = batchOf(ns);
  if (!batch || batch.phase !== "buy") return false;
  const queued = globalThis.gordAugSnapshot?.queued ?? 0;
  if (queued !== batch.lastQueued && Date.now() - batch.since < RL.buyTimeoutMs) {
    batch.lastQueued = queued;
    return false;
  }
  emitEvent(`[*] BN8 install batch: installing ${queued} aug(s)`, "sys");
  return true;
}

/**
 * The book, the allowance and the market cycle. (Exported, with runTreasury,
 * afterDecide and beforeInstall, for tests/bn8-daemon.test.mjs.)
 * @param {NS} ns
 */
export function statusLine(ns) {
  // The aug fence comes down (see afterDecide): back to the trader's floor - or,
  // in a batch, to all of the cash (the trader's own figure there, as it holds
  // the whole book with no allowance). The install stamp maybeInstall left for
  // the trader goes too while the batch is still buying: the book is sold
  // already, and a live stamp makes the trader publish a floor of 0 for every
  // spender until our next tick. Past buyTimeoutMs it stays, so the core's own
  // liquidation handshake can finish anything the hoard didn't.
  const batch = batchOf(ns);
  globalThis.gordMoneyFloor = batch ? Math.max(1, playerMoney(ns)) : (_floorBeforeFence ?? globalThis.gordMoneyFloor);
  _floorBeforeFence = null;
  if (batch?.phase === "buy" && Date.now() - batch.since < RL.buyTimeoutMs) globalThis.gordInstallRequested = 0;

  const num = n => ns.format.number(n);
  const install = batch
    ? ` | Install batch: ${batch.phase === "raise" ? "selling the book" : "buying augs"} (${batch.reason})`
    : _decision ? ` | Install: ${_decision.why}` : "";
  const t = traderState(ns);
  if (!t) return " | Stocks: trader not running" + install;
  const mode = t.tier >= 2 ? "4S" : "est";
  const perHour = (t.incomePerMs ?? 0) * 3_600_000;
  const purse = _book?.purse && !batch ? ` | Allowance: $${num(Math.max(0, _book.purse.wanted))}` : "";
  const data = t.tier >= 2 ? "" : ` | 4S payback ${Number.isFinite(t.paybackTicks) ? `${Math.round(t.paybackTicks)} ticks` : "n/a"}`;
  return ` | Net worth: $${num(t.netWorth)} (${t.positions.length} pos, ${mode}, ~$${num(perHour)}/h)` +
    purse + data + ` | Cycle in ~${Math.round(t.ticksToCycle ?? 0)}` + install;
}

/** @param {NS} ns */
export async function main(ns) {
  await runDaemon(ns, {
    cfg: CFG,
    self: SELF,
    // What comes after BN8 is the campaign plan's choice (lib/daemon-lib.js
    // plannedNextNode), like every other node; `run bn8/daemon.js 12` overrides it.
    decide: decideNextPriority,
    // The node's engine goes ahead of everything else that wants off-home RAM,
    // and is worth a warning when nothing has room for it. (The core launches
    // the same script later as an optional helper; by then it is running.)
    priorityHelpers: [{ script: CFG.paths.stocks, optional: false, args: [8] }],
    // Grafting (SF10, lib/grafting.js, off-home): augs without a reset.
    extraHelpers: [{ script: CFG.paths.grafting, optional: true }],
    // The megacorp factions' company grind (factions.pursueCompanyFactions).
    companyWork: makeCompanyWork(CFG),
    afterDecide,
    beforeInstall,
    statusLine,
  });
}
