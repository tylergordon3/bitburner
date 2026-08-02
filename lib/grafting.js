// lib/grafting.js
//
// Standalone augmentation-grafting manager for BN10 ("Digital Carbon"). Same
// shape as lib/sleeves.js: a self-contained loop the daemon scp's + exec's onto
// whatever host has room, since the grafting API is RAM-heavy (ns.grafting.* is
// ~20GB across the 4 methods used here) - far too much to share a lean home with
// the daemon. Its only import is lib/config.js (no Netscript calls, 0 RAM).
//
// WHY GRAFTING MATTERS IN BN10. Grafting (at VitaLife, New Tokyo) installs an
// augmentation WITHOUT a reset - it applies the moment the graft finishes. BN10
// is a long, deliberately NO-reset run (we stay to buy every sleeve + max memory),
// so grafting is the only way to turn augmentations you'd otherwise get on a
// *future* reset into permanent power for THIS run. The cost is Entropy: each
// completed graft is +1, a PERMANENT -2% to every multiplier for the rest of the
// run. So we cap total grafts (CONFIG.grafting.entropyCap) and, crucially, only
// graft when it's actually the best use of the player's time.
//
// THE PLAYER HAS ONE WORK SLOT. Grafting occupies the same single-threaded slot as
// crime / faction work / study, and starting it CANCELS whatever the player was
// doing. So this helper must not fight the daemon for that slot. Coordination is
// via two globalThis flags the daemon sets (globalThis is shared across every
// script in Bitburner):
//   - gordGraftAllow === true  ONLY when the daemon has decided the player slot is
//     genuinely idle this tick (out of aug targets AND faction/company work). We
//     start a new graft only then, so grafting never cancels active progression.
//   - gordMoneyFloor           spend floor during money-gated-invite hoards; our
//     money() subtracts it, so grafting pauses then (nothing is "affordable").
// An in-progress graft is always allowed to finish (the daemon yields to it via
// gordGraftState.active), because cancelling wastes the time already sunk.
//
// THE COST/BENEFIT MODEL (computed every tick, published for transparency):
//   opportunityRate = the player's idle CRIME rate ($/ms) - what the work slot
//                     earns if we DON'T graft. (Botnet + sleeve income continue
//                     regardless, so only the player-slot output is forgone.)
//   value(aug)      = graftPrice(aug) * valueMult * 0.98^entropy
//                     graftPrice scales with the aug's power (cheapest power proxy
//                     available without a faction offering it); the 0.98^entropy
//                     factor discounts a new aug whose multipliers are themselves
//                     already degraded by the entropy we've accrued.
//   graftRate(aug)  = value(aug) / graftTimeMs(aug)   (money-equiv per player-ms)
//   worthwhile      = entropy < cap AND best affordable candidate exists AND
//                     best.graftRate >= opportunityRate * worthwhileThreshold
// In a rich, no-reset BN10 run graftRate dwarfs idle-crime $/ms, so this correctly
// says "graft whatever's affordable" up to the entropy cap - but the same model
// also (a) refuses when crime is genuinely the better slot use and (b) auto-pauses
// during hoards - so the decision is derived, not hard-coded.

import { CONFIG } from "./config.js";
import { chooseBestGraft } from "./grafting-logic.js";
import { pickBestCrime } from "./crime-logic.js";
import { emitEvent } from "./events.js";

const G = CONFIG.grafting;
const PL = CONFIG.player;

// checkJs rejects plain strings where the API wants CrimeType/CityName-style enum
// unions; casting through any is the project convention - see [[bitburner-enum-string-casts]].
const CITY = /** @type {any} */ (G.city);

// In-progress graft we started, kept in module scope (persists across this
// process's ticks): { aug, startAt, estMs }. Lets us report progress without a
// reliable "remaining time" API - getAugmentationGraftTime is only the baseline.
let ongoing = /** @type {{aug: string, startAt: number, estMs: number} | null} */ (null);

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  if (!G.enabled) {
    ns.tprint("grafting.js: disabled in config (CONFIG.grafting.enabled) - exiting.");
    return;
  }

  // getGraftableAugmentations throws if the grafting API is unavailable (no SF10 /
  // not BN10); treat that as "nothing to manage" and exit cleanly rather than
  // crash-loop, exactly like the sleeve manager's API guard.
  if (!graftingApiAvailable(ns)) {
    ns.tprint("grafting.js: grafting API unavailable (need SF10 / BitNode 10) - exiting.");
    return;
  }

  while (true) {
    tick(ns);
    await ns.sleep(G.tickMs);
  }
}

/** @param {NS} ns */
function graftingApiAvailable(ns) {
  try {
    ns.grafting.getGraftableAugmentations();
    return true;
  } catch {
    return false;
  }
}

/** @param {NS} ns */
function tick(ns) {
  const player = ns.getPlayer();
  const entropy = player.entropy ?? 0;

  // Are we currently grafting? getCurrentWork reports the live task; trust it over
  // our own `ongoing` bookkeeping (a graft can finish or be cancelled by the game).
  const work = /** @type {any} */ (ns.singularity.getCurrentWork());
  const active = work?.type === "GRAFTING";
  const activeAug = active ? work.augmentation : null;

  // A graft we were tracking just finished (was grafting, now isn't).
  if (!active && ongoing) {
    ns.tprint(`Grafting complete: ${ongoing.aug} (Entropy now ${entropy}).`);
    emitEvent(`[graft] Grafted ${ongoing.aug} (Entropy now ${entropy})`, "buy", { augs: [ongoing.aug] });
    ongoing = null;
  }
  // Keep `ongoing` in sync if the game is grafting something we didn't record.
  if (active && (!ongoing || ongoing.aug !== activeAug)) {
    ongoing = { aug: activeAug, startAt: Date.now(), estMs: graftTimeSafe(ns, activeAug) };
  }

  // Evaluate candidates + the cost/benefit decision every tick (for the dashboard
  // and for the daemon to read), regardless of whether we can act right now.
  const opportunityRate = idleCrimeRate(ns);
  const evalResult = evaluate(ns, entropy, opportunityRate);

  // Start a new graft only when the daemon has explicitly freed the player slot,
  // we're not already grafting, and the model says it's worthwhile.
  if (!active && globalThis.gordGraftAllow === true && evalResult.worthwhile && evalResult.best) {
    maybeStartGraft(ns, evalResult.best);
  }

  publishState(ns, { entropy, active, activeAug, opportunityRate, ...evalResult });
}

/** @param {NS} ns @param {string} aug */
function graftTimeSafe(ns, aug) {
  try { return ns.grafting.getAugmentationGraftTime(aug); }
  catch { return 0; }
}

/**
 * Spendable cash = money above gordMoneyFloor. The daemon raises the floor while
 * hoarding for a money-gated faction invite; during those windows nothing is
 * "affordable" here, so grafting pauses instead of spending the cash the invite
 * needs us to hold - same contract lib/sleeves.js honours.
 * @param {NS} ns
 */
function money(ns) {
  const floor = globalThis.gordMoneyFloor ?? 0;
  return Math.max(0, (ns.getPlayer().money ?? 0) - floor);
}

/**
 * The player's idle-crime rate ($/ms) - the opportunity cost of spending the work
 * slot on grafting instead. Runs the SAME expected-$/ms check player-actions uses
 * to choose the crime (lib/crime-logic.js over CONFIG.player.crimeCandidates), so
 * the baseline we compare grafting against is the crime the daemon would actually
 * be committing, not an assumed one.
 * @param {NS} ns
 */
function idleCrimeRate(ns) {
  const s = ns.singularity;
  try {
    const candidates = PL.crimeCandidates.map(name => {
      const crime = /** @type {any} */ (name);
      const stats = s.getCrimeStats(crime);
      return { crime: name, chance: s.getCrimeChance(crime), money: stats.money, timeMs: stats.time };
    });
    const pick = pickBestCrime(candidates, { minChance: PL.crimeMinChance });
    return pick?.rate ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Score every graftable aug and pick the best worthwhile candidate under the
 * entropy cap + affordability. Returns { best, options, worthwhile, reason }.
 * `options` is a compact, dashboard-friendly list (top few by value-rate).
 * @param {NS} ns @param {number} entropy @param {number} opportunityRate
 */
function evaluate(ns, entropy, opportunityRate) {
  const s = ns.singularity;
  const gr = ns.grafting;

  // Gather the raw candidate data from the game (the only ns-touching part); the
  // scoring + graft-vs-crime decision is the pure chooseBestGraft (grafting-logic.js).
  const owned = new Set(s.getOwnedAugmentations(true));
  const installed = new Set(s.getOwnedAugmentations(false));
  const budget = money(ns) * G.buyMaxSpendFraction;

  const candidates = [];
  for (const aug of gr.getGraftableAugmentations()) {
    if (aug === CONFIG.augs.neuroFlux) continue; // not meaningfully graftable
    if (owned.has(aug)) continue;                // already have it (owned or queued)

    // Prereqs must already be satisfied (getGraftableAugmentations doesn't check).
    const prereqs = s.getAugmentationPrereq(aug);
    if (!prereqs.every(a => owned.has(a) || installed.has(a))) continue;

    const price = gr.getAugmentationGraftPrice(aug);
    const timeMs = gr.getAugmentationGraftTime(aug);
    if (!(timeMs > 0)) continue;

    candidates.push({ aug, price, timeMs, affordable: price <= budget });
  }

  const { best, ranked, worthwhile, capped } = chooseBestGraft(candidates, {
    entropy,
    entropyCap: G.entropyCap,
    opportunityRate,
    worthwhileThreshold: G.worthwhileThreshold,
    valueMult: G.valueMult,
  });

  // Top handful by value-rate for the dashboard, affordable or not.
  const options = ranked.slice(0, 5)
    .map(c => ({ aug: c.aug, price: c.price, timeMs: c.timeMs, affordable: c.affordable }));

  let reason;
  if (capped) reason = `entropy cap reached (${entropy}/${G.entropyCap})`;
  else if (!ranked.length) reason = "no graftable augs available";
  else if (!best) reason = "none affordable within spend budget";
  else if (!worthwhile) reason = `crime worth more ($${fmtRate(opportunityRate)} vs $${fmtRate(best.graftRate)}/ms)`;
  else reason = `best value-rate: ${best.aug}`;

  return { best, options, worthwhile, reason };
}

/**
 * Travel to New Tokyo (if needed) and start grafting the chosen aug. Grafting can
 * only be STARTED in New Tokyo; once running, the daemon's stay-city keeps us here.
 * @param {NS} ns @param {{aug: string, price: number, timeMs: number}} best
 */
function maybeStartGraft(ns, best) {
  const s = ns.singularity;
  const player = ns.getPlayer();

  if (player.city !== G.city) {
    if (money(ns) < G.travelCost) return; // can't afford the trip yet - try next tick
    s.travelToCity(CITY);
    // travelToCity is instant; fall through and graft the same tick if it worked.
    if (ns.getPlayer().city !== G.city) return;
    emitEvent(`[travel] Moved to ${G.city} to graft`, "travel");
  }

  const focus = !s.getOwnedAugmentations(false).includes(G.noFocusAug);
  const ok = ns.grafting.graftAugmentation(best.aug, focus);
  if (ok) {
    ongoing = { aug: best.aug, startAt: Date.now(), estMs: best.timeMs };
    ns.tprint(
      `Grafting ${best.aug} for $${ns.format.number(best.price)} ` +
      `(~${ns.format.time(best.timeMs)}${focus ? ", focused" : ", background"}).`
    );
  }
}

// ── Dashboard state ──────────────────────────────────────────────────────────

/** @param {NS} ns */
function publishState(ns, d) {
  // Progress of the active graft, from our own start bookkeeping (best-effort:
  // real duration is faster than the baseline estimate with high intelligence).
  let progress = 0, etaMs = 0;
  if (d.active && ongoing && ongoing.estMs > 0) {
    const elapsed = Date.now() - ongoing.startAt;
    progress = Math.min(0.999, elapsed / ongoing.estMs);
    etaMs = Math.max(0, ongoing.estMs - elapsed);
  }

  globalThis.gordGraftState = {
    active: d.active,
    aug: d.activeAug ?? (d.active && ongoing ? ongoing.aug : null),
    progress,
    etaMs,
    entropy: d.entropy,
    entropyCap: G.entropyCap,
    capped: d.entropy >= G.entropyCap,
    worthwhile: d.worthwhile,
    reason: d.reason,
    best: d.best ? { aug: d.best.aug, price: d.best.price, timeMs: d.best.timeMs, graftRate: d.best.graftRate } : null,
    opportunityRate: d.opportunityRate,
    options: d.options,
    updatedAt: Date.now(),
  };
}

/** @param {number} rate - $/ms */
function fmtRate(rate) {
  if (!isFinite(rate) || rate <= 0) return "0";
  if (rate >= 1e6) return `${(rate / 1e6).toFixed(1)}M`;
  if (rate >= 1e3) return `${(rate / 1e3).toFixed(1)}k`;
  return rate.toFixed(0);
}
