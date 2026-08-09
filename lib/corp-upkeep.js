// lib/corp-upkeep.js
//
// Employee upkeep: buy tea and throw a party for every office, every corporation
// cycle, unconditionally. This is the one corp script that is always running and
// never gated on anything - not the investment round, not the buildout handshake,
// not whether the rest of the manager is even alive. Drive the corp by hand and
// this keeps working underneath you.
//
// ── Why this deserves its own always-on script ───────────────────────────────
// Energy and morale are not a side concern; they multiply EVERY output an office
// has. From the manual (10.4):
//
//     ProductionBase = AvgMorale * AvgEnergy * 1e-4
//
// and ProductionBase scales research points, material quality, product stats,
// division raw production and maximum sales volume. An office drifting at 90/90
// instead of 100/100 is producing 81% of what it should across the board, silently
// and forever. The manual's verdict is blunt: buying tea and throwing a party every
// cycle is mandatory, and a script to do it is the first one you should write.
//
// Splitting it out costs ~62GB - getCorporation + getOffice + buyTea + throwParty -
// against the ~200GB of the rest of the operator. That's the point: this is small
// enough to place on almost any host, so the highest-value, lowest-effort corp
// automation stays up even when nothing else fits.
//
// ── Once per CYCLE, not once per state ───────────────────────────────────────
// A corp cycle is five states (START -> PURCHASE -> PRODUCTION -> EXPORT -> SALE),
// and nextUpdate() resolves on every one. Tea is a latch - buyTea sets teaPending
// and START consumes it for a flat +2 energy - so buying it five times in a cycle
// pays five times for one +2. Likewise a party. We therefore act only on the START
// transition: energy and morale have just been recalculated, so we're reading fresh
// values, and whatever we buy lands on the next START.
//
// ── Optimal party cost, solved rather than guessed ───────────────────────────
// Throwing a flat 500k/employee party is the usual approach and it is wrong in both
// directions - wasteful at high morale, inadequate at low. The manual derives the
// exact cost. Morale updates as:
//
//     morale' = (morale * PerfMult + PartyCostPerEmployee / 1e6)
//               * (1 + PartyCostPerEmployee / 1e7)
//
// Setting morale' to the office maximum and solving the resulting quadratic for x =
// PartyCostPerEmployee gives two roots, of which one is always negative:
//
//     x = 500000 * (sqrt((a*k - 10)^2 + 40*b) - a*k - 10)
//
// with a = current morale, b = target morale, k = PerfMult. optimalPartyCost below
// is that expression. Topping up every cycle also exploits a second result from the
// manual: several small parties cost less than one big one for the same total
// recovery, so small per-cycle corrections are strictly cheaper than letting morale
// sag and fixing it later.
//
// Its imports are lib/config.js and lib/corp-lib.js, neither of which costs RAM
// beyond the corp calls this file already makes.

import { CONFIG } from "./config.js";
import { emitEvent } from "./events.js";
import { safe, did } from "./corp-lib.js";

const CO = CONFIG.corp;
const UP = CO.upkeep;

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  if (!ns.corporation.hasCorporation()) {
    ns.tprint("corp-upkeep.js: no corporation yet - exiting (the daemon creates it).");
    return;
  }

  ns.print("corp-upkeep: buying tea + throwing parties every cycle, for every office.");

  while (true) {
    // Resolves once per STATE; act only on the START transition so tea and party
    // are each bought exactly once per cycle. See the header.
    const finished = await ns.corporation.nextUpdate();
    if (finished !== "START") continue;
    try {
      upkeepPass(ns);
    } catch (e) {
      ns.print(`corp-upkeep error: ${String(e)}`);
    }
  }
}

/**
 * One pass over every office in every division.
 *
 * Cities are taken from CONFIG rather than from getDivision().cities: that would
 * cost another 10GB getter for information we can get for free by simply asking for
 * each office and letting the ones we don't occupy throw. On a script whose whole
 * purpose is to be small, that's a 16% saving for no behavioural difference.
 * @param {NS} ns
 */
function upkeepPass(ns) {
  const c = ns.corporation;
  const corp = safe(() => c.getCorporation());
  if (!corp) return;

  // The debt half of PerfMult's penalty term. The manual's condition is "corp funds
  // negative AND the division is losing money"; the division half would cost a
  // getDivision per division, so we use the corp-wide half alone. It can only
  // over-estimate the penalty, which makes the party very slightly larger than
  // needed - the safe direction, and only while the corp is actually in debt.
  const inDebt = (corp.funds ?? 0) < 0;

  let teas = 0;
  let parties = 0;
  let spend = 0;
  let offices = 0;

  for (const divName of corp.divisions ?? []) {
    for (const city of CO.cities) {
      const office = safe(() => c.getOffice(divName, /** @type {any} */ (city)));
      if (!office || office.numEmployees <= 0) continue;
      offices++;

      // maxEnergy/maxMorale rather than a hardcoded 100: the Go-Juice and Sti.mu
      // researches raise these ceilings, and topping up to a stale 100 would leave
      // the extra headroom - which we paid RP for - permanently unused.
      const maxEnergy = office.maxEnergy ?? 100;
      const maxMorale = office.maxMorale ?? 100;

      if ((office.avgEnergy ?? maxEnergy) < maxEnergy - UP.slack) {
        if (did(() => c.buyTea(divName, /** @type {any} */ (city)))) teas++;
      }

      const morale = office.avgMorale ?? maxMorale;
      if (morale < maxMorale - UP.slack) {
        const cost = optimalPartyCost(morale, maxMorale, perfMult(office, inDebt));
        if (cost > 0) {
          const capped = Math.min(cost, UP.maxPartyCostPerEmployee);
          if (did(() => c.throwParty(divName, /** @type {any} */ (city), capped))) {
            parties++;
            spend += capped * office.numEmployees;
          }
        }
      }
    }
  }

  publishState(ns, { offices, teas, parties, spend });
  rollupJournal(ns, teas, parties, spend);
}

// ── Journal rollup ───────────────────────────────────────────────────────────

// Totals since the last rollup line. Module state is fine: this script is a
// long-lived process (unlike the one-shot build phases).
let _teas = 0;
let _parties = 0;
let _spend = 0;
let _rollupAt = Date.now();

/**
 * One journal line summarising the tea/party spend, at most every
 * journal.upkeepMs. Per-cycle lines would be pure spam (a cycle is 10s), but a
 * periodic rollup shows the upkeep loop is alive and what the max-morale habit
 * actually costs - and stays silent through stretches where every office was
 * already topped up.
 * @param {NS} ns
 */
function rollupJournal(ns, teas, parties, spend) {
  _teas += teas;
  _parties += parties;
  _spend += spend;

  const now = Date.now();
  if (now - _rollupAt < CO.journal.upkeepMs) return;
  if (_teas === 0 && _parties === 0) {
    _rollupAt = now; // quiet period: reset the window, say nothing
    return;
  }

  const mins = Math.round((now - _rollupAt) / 60_000);
  emitEvent(`[corp] Upkeep: ${_teas} teas, ${_parties} parties ($${ns.format.number(_spend)}) in the last ${mins}m`, "corp");
  _teas = 0;
  _parties = 0;
  _spend = 0;
  _rollupAt = now;
}

/**
 * PerfMult - the per-cycle multiplier applied to energy and morale before tea and
 * party are added (manual 10.3):
 *
 *     TotalEmployees < 9        -> 1.002        (small offices drift UP, not down)
 *     otherwise                 -> 1 + InternMultiplier - PenaltyMultiplier
 *     InternMultiplier          = 0.002 * 9 * min(1/9, Interns/Total - 1/9)
 *
 * With no interns that lands on 1 - 0.002 = 0.998, the familiar ~0.2%/cycle decay,
 * and at the well-known 1-intern-in-9 ratio it lands on exactly 1.0 (which is why
 * that ratio is quoted as the no-script alternative to tea and parties).
 *
 * It matters here because it's the `k` in the optimal-cost solve: the party has to
 * pay for the decay this cycle as well as the gap to maximum.
 * @param {any} office @param {boolean} inDebt
 */
function perfMult(office, inDebt) {
  const total = office.numEmployees;
  if (total < UP.decayMinEmployees) return 1.002;
  const interns = office.employeeJobs?.Intern ?? 0;
  const internMult = UP.internCoefficient * Math.min(1 / 9, interns / total - 1 / 9);
  return 1 + internMult - (inDebt ? UP.debtPenalty : 0);
}

/**
 * Cost per employee of a party that lands morale exactly on `target` next cycle.
 * The positive root of the manual's quadratic - see the derivation in the header.
 * Returns 0 when no party is needed (already at or above target).
 *
 * @param {number} current - office.avgMorale now
 * @param {number} target  - office.maxMorale
 * @param {number} k       - PerfMult for this office
 */
export function optimalPartyCost(current, target, k) {
  const ak = current * k;
  const x = 500_000 * (Math.sqrt((ak - 10) ** 2 + 40 * target) - ak - 10);
  return Number.isFinite(x) && x > 0 ? x : 0;
}

/** @param {NS} ns */
function publishState(ns, { offices, teas, parties, spend }) {
  globalThis.gordCorpUpkeep = {
    offices,
    teasThisCycle: teas,
    partiesThisCycle: parties,
    spendThisCycle: spend,
    // "Everything already at max" is the steady state we want to see: it means the
    // per-cycle top-up is keeping ahead of the decay.
    allTopped: offices > 0 && teas === 0 && parties === 0,
    updatedAt: Date.now(),
  };
}
