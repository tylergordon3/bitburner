// lib/corp-lib.js
//
// Helpers shared by the corporation scripts (lib/corp-upkeep, corp-steady,
// corp-expand, corp-office, corp-market, corp-invest).
//
// ── Why the corp manager is split across six files ───────────────────────────
// Bitburner prices the corporation API per DISTINCT function reachable from a
// script: every getter is 10GB and every action 20GB. A script's size is therefore
// set by how many different corp calls it can reach, not by how much work it does.
// The old single builder reached ~30 of them and cost ~490GB - so large that it
// could only ever be placed on a top-end host, which is exactly when you least
// have one (early game, small network). Four focused one-shot phases are 120-200GB
// each and the daemon runs them in rotation, so peak footprint is one phase.
//
// That pricing model is also why this module exports only small helpers: a shared
// function costs its importer nothing unless that importer actually reaches it, so
// splitting common code out here is free, while merging the PHASES back together
// would not be.
//
// Nothing here is BitNode-specific; CONFIG.corp is deep-merged per node by
// forNode(), and each phase resolves its own config.

import { CONFIG } from "./config.js";

const CO = CONFIG.corp;

/** Run `fn`, returning undefined instead of throwing. The corp API throws for a
 * great many benign "not yet" cases (no warehouse, no unlock, no such division),
 * so this is the normal way to probe state. */
export function safe(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** Run `fn` for effect; true if it didn't throw. */
export function did(fn) {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

/** @param {NS} ns - the corporation's liquid funds (negative while in debt). */
export function corpFunds(ns) {
  return safe(() => ns.corporation.getCorporation().funds) ?? 0;
}

/**
 * True if spending `cost` still leaves the operating reserve intact.
 *
 * Note this is for SPENDING decisions only. Material purchase orders deliberately
 * bypass it - the manual's whole round-1/2 plan ends with the corp in debt from
 * buying boost materials, which is allowed and free. See buyToTarget.
 * @param {NS} ns
 */
export function affordable(ns, cost) {
  if (!Number.isFinite(cost) || cost < 0) return false;
  const funds = corpFunds(ns);
  return funds - cost >= funds * CO.fundsReserveFraction;
}

/**
 * The division object to work with for a configured industry: the LIVE name of
 * whichever division already runs that industry, or the configured name when there
 * isn't one yet (i.e. when we're about to found it).
 *
 * Matching on industry rather than name is what lets the buildout adopt a division
 * created by hand in the Corporation UI. The BN10 corp's Agriculture division was
 * made manually as "AgriGord"; a name-equality check sees no "Agriculture" division
 * at all and would pay another $40b startingCost for a duplicate beside it.
 * @param {NS} ns @param {{name: string, industry: string}} div
 */
export function resolveDivision(ns, div) {
  const c = ns.corporation;
  for (const name of safe(() => c.getCorporation().divisions) ?? []) {
    if (safe(() => c.getDivision(name).industry) === div.industry) {
      return { name, industry: div.industry };
    }
  }
  return div;
}

/** The live name of the division running `industry`, or null. @param {NS} ns */
export function divisionByIndustry(ns, industry) {
  const c = ns.corporation;
  for (const name of safe(() => c.getCorporation().divisions) ?? []) {
    if (safe(() => c.getDivision(name).industry) === industry) return name;
  }
  return null;
}

/**
 * The current investment round, as published by lib/corp-invest.js (the only phase
 * that pays the 10GB for getInvestmentOffer). Defaults to 1 rather than "past the
 * rounds" so a phase running before invest's first pass behaves conservatively:
 * round 1 gates everything expensive.
 */
export function currentRound() {
  return globalThis.gordCorpRound ?? 1;
}

/**
 * Integer head-counts per role summing exactly to `total`.
 * @param {number} total @param {Record<string, number>} ratios
 * @returns {Record<string, number>}
 */
export function distributeJobs(total, ratios) {
  const roles = Object.keys(ratios);
  /** @type {Record<string, number>} */
  const counts = {};
  let assigned = 0;
  for (const r of roles) {
    counts[r] = Math.floor(total * ratios[r]);
    assigned += counts[r];
  }
  // Hand out the rounding remainder, largest ratio first, so the dominant role
  // (Engineer in every producing split) absorbs it rather than a 0-ratio role.
  const byRatio = [...roles].sort((a, b) => ratios[b] - ratios[a]);
  for (let i = 0; assigned < total; i++, assigned++) {
    counts[byRatio[i % byRatio.length]]++;
  }
  return counts;
}

export function pctStr(have, need) {
  if (!Number.isFinite(need) || need <= 0) return "-";
  return `${Math.min(100, (have / need) * 100).toFixed(0)}%`;
}

// ── Journal aggregation ──────────────────────────────────────────────────────
//
// Discrete milestones (a division founded, a round accepted) go straight to
// emitEvent. The REPEATED spends - an Advert level every cycle, a warehouse level
// every pass - would drown the journal logged raw, so they accumulate here and
// flush as one summary line per interval. The store lives on globalThis because
// the build phases are one-shots: they exit between passes, so module state
// can't carry a tally, but globalThis persists until an install/reload - exactly
// the durability a log throttle wants.

/**
 * Merge `add` (numbers, summed per key) into the named accumulator; then, if
 * anything is pending and at least `ms` has passed since this key last flushed,
 * return the accumulated record and reset it. Returns null while throttled or
 * empty, so callers can simply `if (rec) emitEvent(summariseCounts(...))`.
 *
 * Key convention: "$spend" accumulates money and is rendered as a total by
 * summariseCounts; every other key is a labelled count.
 * @param {string} key @param {number} ms @param {Record<string, number>} add
 * @returns {Record<string, number> | null}
 */
export function accumulateJournal(key, ms, add) {
  const store = globalThis.gordCorpJournalAccum ?? (globalThis.gordCorpJournalAccum = {});
  /** @type {Record<string, number>} */
  const rec = store[key] ?? (store[key] = {});
  for (const [k, v] of Object.entries(add)) {
    if (v > 0) rec[k] = (rec[k] ?? 0) + v;
  }

  const at = globalThis.gordCorpLogAt ?? (globalThis.gordCorpLogAt = {});
  const now = Date.now();
  if (!Object.values(rec).some(v => v > 0)) return null;
  if (now - (at[key] ?? 0) < ms) return null;
  at[key] = now;
  store[key] = {};
  return rec;
}

/**
 * Render an accumulator record as one journal-ready clause: counts as
 * "Label +N", the "$spend" key as a trailing money total. ns is only used for
 * format.number (0GB).
 * @param {NS} ns @param {Record<string, number>} rec
 */
export function summariseCounts(ns, rec) {
  const parts = [];
  let spend = 0;
  for (const [k, v] of Object.entries(rec)) {
    if (k === "$spend") spend = v;
    else if (v > 0) parts.push(`${k} +${v}`);
  }
  return parts.join(", ") + (spend > 0 ? ` ($${ns.format.number(spend)})` : "");
}
