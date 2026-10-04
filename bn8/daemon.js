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
//    sleeve augs, grafts). Only the allowance is ever "spendable".
//    Two things that floor would otherwise break, handled here:
//      - maybeBuyInfra pauses servers under ANY floor, so the fleet is bought
//        with lib/pserv.js directly, from the allowance.
//      - maybeInstall never installs over a floor, so when an install is due
//        (the same installReason, read off last tick's aug snapshot) the fence
//        is dropped: the trader liquidates through the usual handshake, buyAugs
//        spends the lot dearest-first, the NeuroFlux dump takes the rest.
//
// 2. CASH THAT ONLY HAS TO BE SEEN. Faction invites check liquid money (a city
//    faction's $15-50m, Daedalus's $100b). With the capital in stock that is
//    never there, so the amount goes to the trader as a `hoard`: held in cash,
//    fenced from the spenders, released when the invite lands. Only when net
//    worth covers it comfortably - otherwise we would sit in cash, not growing,
//    waiting for money that isn't coming.
//
// 3. THE PLAYER'S SLOT. Nothing the player can do earns money here, so the slot
//    earns what money can't buy cheaply: reputation (a donation costs $1m per
//    faction_rep point of reputation - working for it is free), then hacking
//    exp towards the world daemon's level 3000. Grafting (SF10, off-home
//    lib/grafting.js) takes the slot when it is free: an aug without a reset is
//    worth more here than anywhere, since a reset costs the whole capital.
//
// Stock manipulation - the batcher flagging its grows/hacks so they move the
// stocks we hold - is the trader's wish list (gordStockWishes) and
// hacking/manager.js's business; this daemon only keeps both running.
//
// RAM: the same Netscript calls as bn9/daemon.js minus its ns.scan, minus
// lib/company-work.js (7GB); nothing BN8-specific is added - lib/stocks-logic.js
// is 0GB and lib/pserv.js was already reached through maybeBuyInfra.
// `run tools/self-test.js` prints the exact figure in-game.

import {
  doEarlyBootstrapIfNeeded,
  maybeCreatePrograms,
  maybeAutoTravelForReadyFaction,
  clearFactionWork,
  focusFlag,
} from "../lib/player-actions.js";
import { getNextAugTarget, getMoneyHoardGoal, factionRepStillUseful } from "../lib/aug-targets.js";
import { forNode } from "../lib/config.js";
import { playerMoney, hackingLevel, nextBNOverride, installReason, startBestFactionWork } from "../lib/daemon-lib.js";
import { managePurchasedServers } from "../lib/pserv.js";
import { runDaemon, decidePrelude, decideAugFlow, pursueNextFaction } from "../lib/daemon-core.js";
import { allowanceStep } from "../lib/stocks-logic.js";

// Every tunable value comes from lib/config.js, resolved for BitNode 8.
const CFG = forNode(8);
const ST = CFG.stocks;
const TR = ST.treasury;
const PL = CFG.player;
const SELF = CFG.paths.daemon;                // this daemon's path (post-reset callback)
const FINAL_HOST = CFG.backdoor.finalHost;
const STUDY_LOCATION = /** @type {any} */ (PL.studyLocation);
const STUDY_CLASS = /** @type {any} */ (PL.studyClass);

/**
 * The BitNode to enter when lib/finish-bn.js destroys w0r1d_d43m0n: the player's
 * explicit choice (`run bn8/daemon.js 12`, remembered across installs by
 * nextBNOverride), else the halt sentinel 0 - the node is finished by hand and
 * the player picks what comes next. (Leaving this hook out would hand the choice
 * to the campaign plan, lib/daemon-lib.js plannedNextNode, like the other nodes.)
 * @param {NS} ns
 */
function plannedNextBN(ns) {
  return nextBNOverride(ns) ?? 0;
}

// ── Treasury ─────────────────────────────────────────────────────────────────

/** allowanceStep's state between ticks. */
let _purse = /** @type {any} */ (null);
// The trader counts what everyone else spends, but only while it runs, and from
// zero each time it starts. These keep one continuous total across both.
let _outflowBase = 0;
let _traderOutflow = 0;
let _lastCash = /** @type {number | null} */ (null);
/** Cash a faction invite needs to see: { amount, until }. */
let _joinHold = /** @type {{amount: number, until: number} | null} */ (null);

/** The trader's published state, if it is alive. */
function traderState() {
  const st = globalThis.gordStockState;
  if (!st || Date.now() - (st.updatedAt ?? 0) > ST.stateStaleMs) return null;
  return (st.tier ?? 0) > 0 && st.netWorth > 0 ? st : null;
}

/**
 * Is an aug install due? The same policy maybeInstall applies a few lines after
 * this daemon's decision (installReason over this node's augs.install), read
 * off the aug snapshot it published last tick. Needed because maybeInstall
 * never fires over a money floor, and here the floor is permanent - so the
 * fence has to come down first.
 * @param {NS} ns
 */
function installDue(ns) {
  const snap = globalThis.gordAugSnapshot;
  if (!snap || Date.now() - (snap.updatedAt ?? 0) > 4 * CFG.daemon.tickMs) return false;
  const installed = new Set(snap.installed ?? []);
  const queued = (snap.owned ?? []).filter(a => !installed.has(a));
  const priority = CFG.augs.installPriority;
  return installReason({
    queued: snap.queued ?? 0,
    redPillQueued: !!snap.redPillQueued,
    hasPriorityAug: priority.some(a => queued.includes(a)),
    allPriorityDone: priority.every(a => installed.has(a)),
    elapsedMs: Date.now() - ns.getResetInfo().lastAugReset,
    favor: null, // augs.install.favorInstall is off here: donations are open from the start
  }, CFG.augs.install) !== null;
}

/**
 * One tick of the treasury: advance the allowance, publish it for the trader
 * (with any hoard, and whether the fence is down for an install), keep the
 * fence up ourselves while no trader is alive to, and tell the aug buyer what
 * "income" means here.
 * @param {NS} ns @param {number} hoard - cash an invite needs to see
 * @returns {{allowance: number, netWorth: number, release: boolean, trader: any}}
 */
function runTreasury(ns, hoard) {
  const cash = playerMoney(ns);
  const trader = traderState();

  // Total spent by everything but the trader. While it runs it measures this
  // exactly (it knows its own trades); before it is up - and BN8's first
  // minutes are precisely that - any drop in cash is spending.
  if (trader) {
    if ((trader.outflow ?? 0) < _traderOutflow) _outflowBase += _traderOutflow; // it restarted
    _traderOutflow = trader.outflow ?? 0;
  } else if (_lastCash !== null && cash < _lastCash) {
    _outflowBase += _lastCash - cash;
  }
  _lastCash = cash;

  const netWorth = trader ? trader.netWorth : cash;
  _purse = allowanceStep(_purse, {
    netWorth,
    outflow: _outflowBase + _traderOutflow,
    has4S: (trader?.tier ?? 0) >= 2,
    // Cash the trader can't place - every worthwhile stock at its share cap -
    // costs nothing to spend. Only once it has been idle long enough to be that
    // rather than cash between two trades.
    idleCash: trader && (trader.idleTicks ?? 0) >= TR.idleTicks ? trader.idleCash ?? 0 : 0,
  }, TR);

  const release = hoard <= 0 && installDue(ns);
  globalThis.gordStockCashWanted = { amount: _purse.wanted, hoard, release, updatedAt: Date.now() };
  // The trader republishes the floor after every trade; this is the same line
  // for the ticks it isn't running (the cold start, a helper that lost its host).
  if (!trader) globalThis.gordMoneyFloor = release ? 0 : Math.max(0, cash - _purse.wanted);

  // buyAugs saves for a dear aug when "income" will cover it within the save
  // horizon, and weighs a donation against the time income takes to earn it
  // back. Measured income is zero here (no money source but stock, which
  // estimateIncomeRate rightly doesn't count), so give it what really arrives
  // in the purse: the allowance's cut of the book's expected earnings.
  // Zero when the fence is down - an install is next, and there is nothing to
  // save for: whatever fits should be bought now.
  const payout = (trader?.tier ?? 0) >= 2 ? TR.payout : TR.payoutPre4S;
  globalThis._incomeRatePerMs = release ? 0 : Math.max(0, trader?.incomePerMs ?? 0) * payout;

  return { allowance: _purse.wanted, netWorth, release, trader };
}

/**
 * Cash a pending invite needs to see, if net worth covers it with room to
 * spare: the money-gated endgame invites (getMoneyHoardGoal - Daedalus, The
 * Covenant, Illuminati; only once the ordinary aug targets have run out, as in
 * the other nodes) and whatever city faction the idle branch found itself
 * "saving" for last tick.
 * @param {NS} ns @param {any} target
 */
function inviteHoard(ns, target) {
  const netWorth = traderState()?.netWorth ?? playerMoney(ns);
  let amount = 0;
  let faction = "";
  const big = target ? null : getMoneyHoardGoal(ns);
  if (big && netWorth >= big.money * TR.hoardNetWorthMult) {
    amount = big.money;
    faction = big.faction;
  }
  if (_joinHold && Date.now() < _joinHold.until && netWorth >= _joinHold.amount * TR.hoardNetWorthMult) {
    amount = Math.max(amount, _joinHold.amount);
  }
  return { amount, faction };
}

/**
 * Purchased servers, out of the allowance: lib/pserv.js with the fence as its
 * reserve and the infra budget's free-treasury fraction. (maybeBuyInfra would
 * report "Holding Cash" for ever - it reads any money floor as an invite hoard.)
 * They are the botnet's RAM: hacking exp, and the leverage behind every stock
 * the batcher is asked to push. An install deletes them, so none while one is due.
 * @param {NS} ns @param {boolean} release
 */
async function buyServers(ns, release) {
  if (release) return null;
  const fence = globalThis.gordMoneyFloor ?? 0;
  return await managePurchasedServers(ns, fence, CFG.infra.noTarget.spendFraction, CFG.pserv.hardSpendCap);
}

// ── The player's slot ────────────────────────────────────────────────────────

let _worldLevel = 0;
/** The world daemon's hacking requirement (3000 here). @param {NS} ns */
function worldDaemonLevel(ns) {
  if (_worldLevel > 0) return _worldLevel;
  try { _worldLevel = ns.getServerRequiredHackingLevel(FINAL_HOST); } catch { _worldLevel = 0; }
  return _worldLevel;
}

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
  ns.singularity.universityCourse(STUDY_LOCATION, STUDY_CLASS, focusFlag(ns));
  return {
    action: "Studying (idle)",
    detail: `Hacking ${hackingLevel(ns)}${need ? `/${need} for ${FINAL_HOST}` : ""}`,
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
  const hoard = inviteHoard(ns, target);
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

  const infra = await buyServers(ns, purse.release);

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

  // No aug target: BN8's own version of the core's decideNoTarget. The core's
  // falls back to crime, which here earns nothing; this one works for
  // reputation, grafts, then studies.
  if (!target) {
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
 */
function afterDecide(ns, state) {
  globalThis.gordCompanyCity = state?.action === "Grafting" ? CFG.grafting.city : null;
}

/** The book, the allowance and the market cycle. @param {NS} ns */
function statusLine(ns) {
  const t = traderState();
  if (!t) return " | Stocks: trader not running";
  const num = n => ns.format.number(n);
  const mode = t.tier >= 2 ? "4S" : "est";
  const perHour = (t.incomePerMs ?? 0) * 3_600_000;
  const purse = _purse ? ` | Allowance: $${num(Math.max(0, _purse.wanted))}` : "";
  const data = t.tier >= 2 ? "" : ` | 4S payback ${Number.isFinite(t.paybackTicks) ? `${Math.round(t.paybackTicks)} ticks` : "n/a"}`;
  return ` | Net worth: $${num(t.netWorth)} (${t.positions.length} pos, ${mode}, ~$${num(perHour)}/h)` +
    purse + data + ` | Cycle in ~${Math.round(t.ticksToCycle ?? 0)}`;
}

/** @param {NS} ns */
export async function main(ns) {
  await runDaemon(ns, {
    cfg: CFG,
    self: SELF,
    plannedNextBN,
    decide: decideNextPriority,
    // The node's engine goes ahead of everything else that wants off-home RAM,
    // and is worth a warning when nothing has room for it. (The core launches
    // the same script later as an optional helper; by then it is running.)
    priorityHelpers: [{ script: CFG.paths.stocks, optional: false, args: [8] }],
    // Grafting (SF10, lib/grafting.js, off-home): augs without a reset.
    extraHelpers: [{ script: CFG.paths.grafting, optional: true }],
    afterDecide,
    statusLine,
  });
}
