// lib/corp-invest.js
//
// Build phase 4 of 4: INVESTMENT - accepting the four funding rounds, and going
// public afterwards. A bounded one-shot run in rotation by lib/corp-daemon.js;
// see lib/corp-lib.js for why the corp manager is split.
//
// This phase is also the ROUND PUBLISHER: it holds the only getInvestmentOffer
// call in the whole manager and stamps globalThis.gordCorpRound / gordCorpOffer
// every pass, which is how every other corp script knows which round it's building
// for without paying 10GB each for the same answer.
//
// ── When a round is accepted ─────────────────────────────────────────────────
// The offer formula (manual 17.3) is Valuation * share * multiplier, and valuation
// is a trailing 10-cycle average dominated by AssetDelta - so accepting early
// costs enormously. The gates:
//
//   Rounds 1-2: capacity built (gordCorpExpandDone), offices staffed
//   (gordCorpOfficeDone), revenue flowing, AND - round 2 only - the RP wait the
//   manual calls mandatory: Agriculture ~700, Chemical ~390
//   (CONFIG.corp.round2ResearchPoints). RP is what makes the materials
//   high-quality, quality is what makes them sell, and sales are what the offer
//   prices. lib/corp-office.js holds everyone on R&D until the same numbers, so
//   the two gates agree.
//
//   Rounds 3-4: the 1P/2P cadence - 1 finished product before round 3's offer,
//   2 before round 4's (CONFIG.corp.productsBeforeRound).
//
//   Escape hatch: a self-funded corp that cannot afford its next buildout step
//   (globalThis.gordCorpCheapestStep, published by lib/corp-expand.js) accepts a
//   standing offer worth investStallOfferMult x its funds rather than grinding
//   forever toward targets it can never reach. The multiple keeps it from being a
//   cheap sellout.
//
// The readiness flags arrive via globalThis rather than imports on purpose:
// importing another corp phase would pull its whole 20GB-per-action closure into
// this one, undoing the phase split.

import { CONFIG } from "./config.js";
import { emitEvent } from "./events.js";
import { safe, did, corpFunds, divisionByIndustry } from "./corp-lib.js";

const CO = CONFIG.corp;
const PRODUCT_CITY = /** @type {any} */ (CO.productCity);

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  if (!ns.corporation.hasCorporation()) return;
  try {
    pass(ns);
  } catch (e) {
    ns.print(`corp-invest error: ${String(e)}`);
  }
  // One-shot: exit so the RAM is only held transiently.
}

/** @param {NS} ns */
function pass(ns) {
  const c = ns.corporation;

  // Publish the round + standing offer for every other corp script. 99 = past all
  // rounds (getInvestmentOffer throws once there are none left).
  const round = safe(() => c.getInvestmentOffer().round) ?? 99;
  globalThis.gordCorpRound = round;
  globalThis.gordCorpOffer = safe(() => c.getInvestmentOffer().funds) ?? 0;

  const corp = safe(() => c.getCorporation());
  if (!corp) return;

  if (round > CO.investmentRounds) {
    maybeGoPublic(ns, corp);
    return;
  }

  // The rescue can fire even at 0 revenue - a corp that produces nothing and
  // bleeds salaries is the strongest rescue case, not an exception to it.
  const rescue = round > 2 && dyingRescue(ns, corp);
  if ((corp.revenue ?? 0) <= 0 && !rescue) return; // nothing to price an offer on yet

  const ready = round <= 2
    ? earlyRoundReady(ns, round) || stalledOnGoodOffer(ns, round)
    : productsReady(ns, round) || rescue;
  if (!ready) {
    logProgress(ns, round);
    return;
  }

  // Read the offer BEFORE accepting - afterwards getInvestmentOffer describes the
  // next round, so the journal would report the wrong figure.
  const funds = safe(() => c.getInvestmentOffer().funds) ?? 0;
  if (did(() => c.acceptInvestmentOffer())) {
    emitEvent(`[corp] Accepted investment round ${round} (+$${ns.format.number(funds)})`, "corp");
  }
}

/**
 * Rounds 1-2: capacity + people built (the other phases' handshakes) and, for
 * round 2, the mandatory RP wait met in both material divisions.
 * @param {NS} ns @param {number} round
 */
function earlyRoundReady(ns, round) {
  if (!globalThis.gordCorpExpandDone || !globalThis.gordCorpOfficeDone) return false;
  return rpGateMet(ns, round);
}

/**
 * True when the round's mandatory RP protocol is met: round 1's 55-RP bank in
 * Agriculture, round 2's per-division numbers. lib/corp-office.js holds all
 * staff on R&D until the same figures, so in practice this is met by the time
 * revenue exists - requiring it here (including in the escape hatch) just makes
 * the protocol impossible to skip.
 */
function rpGateMet(ns, round) {
  if (round === 1) {
    const divName = divisionByIndustry(ns, CO.agriDivision.industry);
    if (!divName) return false;
    const rp = safe(() => ns.corporation.getDivision(divName).researchPoints) ?? 0;
    return rp >= CO.round1ResearchPoints;
  }
  if (round !== 2) return true;
  for (const [industry, gate] of Object.entries(CO.round2ResearchPoints)) {
    const divName = divisionByIndustry(ns, industry);
    if (!divName) continue; // division not founded yet - the expand gate covers this
    const rp = safe(() => ns.corporation.getDivision(divName).researchPoints) ?? 0;
    if (rp < gate) return false;
  }
  return true;
}

/**
 * The stalled-corp escape hatch: the buildout can't afford its next step (cost
 * published by lib/corp-expand.js) and the standing offer is transformative.
 *
 * Two guards keep planned debt from gaming it. The manual's rounds 1-2
 * deliberately end in debt from boost-material buys, and with funds < 0 the
 * offer-multiple test is vacuously true (any offer beats 5x a negative number) -
 * this hatch used to accept the round the moment the corp dipped into planned
 * debt, bypassing the RP wait and the whole round-2 Chemical protocol. So:
 * the RP gate is required HERE too (never skippable, hatch or no hatch), and
 * the offer multiple is taken against funds floored at 0. A self-funded corp
 * that banked its RP but ended the buildout in boost debt - the manual's
 * intended end-of-round state - then accepts promptly instead of grinding back
 * to positive funds first.
 * @param {NS} ns @param {number} round
 */
function stalledOnGoodOffer(ns, round) {
  if (!rpGateMet(ns, round)) return false;
  const funds = corpFunds(ns);
  if (!Number.isFinite(funds)) return false;
  const offer = globalThis.gordCorpOffer ?? 0;
  if (offer <= 0 || offer < Math.max(funds, 0) * CO.investStallOfferMult) return false;
  const cheapest = globalThis.gordCorpCheapestStep;
  return cheapest !== undefined && cheapest > funds;
}

/**
 * Rounds 3-4 escape hatch: accept a transformative standing offer when the corp
 * is BLEEDING (negative profit) and cannot afford its next buildout step. The
 * 1P/2P product cadence assumes Tobacco can be founded; a corp that reached
 * round 3 under-built can otherwise sit forever unable to bank the $70b/$20b
 * foundings while salaries and input costs drain it to zero. Accepting "early"
 * sacrifices future valuation, but a corp that can never found its product
 * division has no future valuation to protect. Unlike stalledOnGoodOffer this
 * may fire in debt - a dying corp in the red is the case it exists for - so the
 * offer multiple is taken against funds floored at 0. Requires a FINITE pending
 * step: cheapest === Infinity means the buildout is complete and the corp is
 * just mid-cycle (products developing, boost buys settling) - a transient
 * negative-profit dip there must not sell a round early.
 * @param {NS} ns @param {any} corp
 */
function dyingRescue(ns, corp) {
  if (((corp.revenue ?? 0) - (corp.expenses ?? 0)) >= 0) return false;
  const funds = corpFunds(ns);
  const offer = globalThis.gordCorpOffer ?? 0;
  if (offer <= 0 || offer < Math.max(funds, 0) * CO.investStallOfferMult) return false;
  const cheapest = globalThis.gordCorpCheapestStep;
  return Number.isFinite(cheapest) && cheapest > funds;
}

/** Rounds 3-4: the 1P/2P product cadence. @param {NS} ns @param {number} round */
function productsReady(ns, round) {
  const need = CO.productsBeforeRound[round] ?? 1;
  const divName = divisionByIndustry(ns, CO.tobaccoDivision.industry);
  if (!divName) return false;

  const c = ns.corporation;
  let finished = 0;
  for (const p of safe(() => c.getDivision(divName).products) ?? []) {
    const d = safe(() => c.getProduct(divName, PRODUCT_CITY, p));
    if (d && (d.developmentProgress ?? 0) >= 100) finished++;
  }
  return finished >= need;
}

/**
 * Take the corp public once past the investment rounds, issuing CO.sharesToIssue
 * new shares (0 per the manual's FAQ). This is what actually enables dividends -
 * issueDividends (in corp-steady) is a silent no-op while the corp is private.
 * @param {NS} ns @param {any} corp
 */
function maybeGoPublic(ns, corp) {
  if (!CO.goPublic || corp.public) return;
  if (did(() => ns.corporation.goPublic(CO.sharesToIssue))) {
    emitEvent(`[corp] Went public (issued ${CO.sharesToIssue} shares) - dividends can now be paid`, "corp");
  }
}

/** One line on what's still blocking this round's acceptance. @param {NS} ns */
function logProgress(ns, round) {
  const offer = globalThis.gordCorpOffer ?? 0;
  const blockers = [];
  if (round <= 2) {
    if (!globalThis.gordCorpExpandDone) blockers.push("capacity");
    if (!globalThis.gordCorpOfficeDone) blockers.push("offices");
    if (round === 2 && !rpGateMet(ns, round)) blockers.push("RP wait");
  } else {
    blockers.push(`${CO.productsBeforeRound[round] ?? 1} finished product(s)`);
  }
  ns.print(`[corp-invest] round ${round} | offer $${ns.format.number(offer)} | waiting on: ${blockers.join(", ") || "?"}`);
}
