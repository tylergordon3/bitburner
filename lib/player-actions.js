// lib/player-actions.js
//
// Everything that spends the player's own (single-threaded) attention: gym,
// study, crime, travel, faction work. All tuning lives in CONFIG.player and
// CONFIG.programs.

import { CONFIG } from "./config.js";
import { pickBestCrime } from "./crime-logic.js";
import { toggleEnabled } from "./toggles.js";
import { factionRepStillUseful } from "./aug-targets.js";

const PL = CONFIG.player;
const PROG = CONFIG.programs;
const HOME = CONFIG.paths.home;

// Cast to any: config values widen to `string`, which checkJs won't accept for
// Singularity's GymLocationName / UniversityLocationName / UniversityClassType
// unions (the bare string literals these replaced satisfied them structurally).
// See [[bitburner-enum-string-casts]].
const GYM = /** @type {any} */ (PL.gym);
// Powerhouse Gym is in Sector-12; this is where home is.
const GYM_CITY = PL.gymCity; // cast at each travelToCity call site

const COMBAT_STATS = PL.combatStats; // cast per-stat at each gymWorkout call site

const STUDY_LOCATION = /** @type {any} */ (PL.studyLocation);
const STUDY_CLASS = /** @type {any} */ (PL.studyClass);
const EARLY_HACK_TARGET = PL.earlyHackTarget;
const EARLY_MUG_CHANCE = PL.earlyMugChance;

// If it would take longer than this to save up for TOR + BruteSSH, just
// train hacking and create the programs manually instead.
const TOR_COST = PROG.torCost;
const BRUTE_SSH_COST = PROG.bruteSshCost;   // darkweb price
const SLOW_INCOME_THRESHOLD_MS = PL.slowIncomeThresholdMs;

// Hacking level required to create each program via createProgram().
// Listed in priority order - more programs = more rootable servers = more RAM.
const CREATE_PROGRAM_HACK_REQ = PROG.createHackReq;

// Travel cost (always $200k flat in Bitburner).
const TRAVEL_COST = PL.travelCost;

/**
 * True once we own all 5 port openers. Until then, gang/city faction grinding
 * (combat training, travel for non-hacking factions) is deprioritized -
 * finishing the hacking bootstrap comes first.
 * @param {NS} ns
 */
function hasAllPortOpeners(ns) {
  return PROG.portOpeners.every(p => ns.fileExists(p, HOME));
}

// gymWorkout wants the GymType ids ("str", ...), but player.skills and every
// requirement table (CONFIG.factions.requirements, bladeburner.joinStats) are
// keyed by the full skill name. Reading both with the gym id made every stat
// look like 0 of 0 needed, so this never trained anything.
const GYM_TO_SKILL = { str: "strength", def: "defense", dex: "dexterity", agi: "agility" };

/** @param {NS} ns */
export async function trainCombatIfNeeded(ns, targets = {}) {
  const player = ns.getPlayer();

  for (const stat of COMBAT_STATS) {
    const skill = GYM_TO_SKILL[stat] ?? stat;
    const current = player.skills?.[skill] ?? 0;
    const needed = targets[skill] ?? 0;

    if (current < needed) {
      ns.singularity.gymWorkout(
        GYM,
        /** @type {any} */ (stat),
        focusFlag(ns)
      );

      return {
        action: "Training",
        detail: `${stat} ${current}/${needed}`,
        stat,
        current,
        needed,
      };
    }
  }

  return null;
}

/** @param {NS} ns */
export async function commitHomicideIfUseful(ns, reason = "money") {
  const crime = /** @type {any} */ ("Homicide");
  const chance = ns.singularity.getCrimeChance(crime);

  if (chance >= PL.homicideMinChance) {
    ns.singularity.commitCrime(crime, focusFlag(ns));

    return {
      action: "Crime",
      detail: `Homicide for ${reason}`,
      crime: "Homicide",
      chance,
    };
  }

  return null;
}

/**
 * Commit whichever crime is expected to PAY BEST RIGHT NOW, instead of waiting
 * for homicide to clear a fixed success chance.
 *
 * For each candidate in PL.crimeCandidates we read the live success chance plus
 * the crime's money and duration, and score it as chance x money / time (see
 * lib/crime-logic.js for why that's the right comparison, and where the mug ->
 * homicide crossover actually falls). Best rate wins, subject to two guards: a
 * crime we'd fail more often than PL.crimeMinChance isn't worth the player's slot
 * at all (return null, so the caller trains/studies instead), and we stay on the
 * crime we're already committing while it's within PL.crimeStickyMargin of the
 * best - commitCrime restarts the attempt, so thrashing across a near-tie would
 * just throw away sunk progress.
 *
 * Pass metric "karma" (the BN2/BN5 gang bootstrap) to rank by karma per ms
 * instead: homicide's 3.0 vs mug's 0.25 per attempt puts it ahead much earlier.
 *
 * Returns a status object if we're on a crime, null if none is worth committing.
 * @param {NS} ns
 * @param {string} [reason]
 * @param {{metric?: "money"|"karma"}} [opts]
 */
export async function commitBestCrimeIfUseful(ns, reason = "money", opts = {}) {
  const s = ns.singularity;
  const metric = opts.metric ?? "money";

  // Base money / karma / duration are the game's constants (CONFIG.crimes), so
  // only the live success chance is read from the API - getCrimeStats was 5GB
  // on every daemon for three numbers that never change.
  const candidates = PL.crimeCandidates.map(name => ({
    crime: name,
    chance: s.getCrimeChance(/** @type {any} */ (name)),
    money: CONFIG.crimes.money[name] ?? 0,
    karma: CONFIG.crimes.karma[name] ?? 0,
    timeMs: CONFIG.crimes.timeMs[name] ?? 0,
  }));

  const work = s.getCurrentWork();
  const current = work?.type === "CRIME" ? work.crimeType : null;

  const pick = pickBestCrime(candidates, {
    metric,
    minChance: PL.crimeMinChance,
    current,
    stickyMargin: PL.crimeStickyMargin,
  });
  if (!pick) return null;

  // Already committing it: re-issuing would restart the attempt for nothing.
  if (pick.crime !== current) {
    s.commitCrime(/** @type {any} */ (pick.crime), focusFlag(ns));
  }

  // Why this crime, in one clause: the success chance (only while it's imperfect -
  // a "(100%)" qualifier is noise), how far ahead of the runner-up it is, and
  // (when we're not ranking by money) what we're ranking by instead.
  const pct = Math.round(pick.chance * 100);
  const runnerUp = pick.ranked.find(c => c.crime !== pick.crime);
  const margin = runnerUp && runnerUp.rate > 0
    ? `${(pick.rate / runnerUp.rate).toFixed(2)}x ${runnerUp.crime}${metric === "money" ? "" : ` on ${metric}`}`
    : "";
  const qualifiers = [pct < 100 ? `${pct}%` : "", margin].filter(Boolean).join(", ");

  return {
    action: "Crime",
    detail: `${pick.crime} for ${reason}${qualifiers ? ` (${qualifiers})` : ""}`,
    crime: pick.crime,
    chance: pick.chance,
    rate: pick.rate,
  };
}

/**
 * Publish which faction the player's work slot is currently earning rep for, so
 * off-home helpers can line up behind it: lib/sleeves.js puts any sleeve too weak
 * to crime profitably onto FIELD WORK for this faction, turning dead weight into
 * extra rep on the exact grind we're already doing.
 *
 * Stamped with a timestamp because it's a heartbeat, not a latch: every daemon
 * tick that's still working a faction re-issues the work (and so re-stamps this),
 * so readers can treat a record older than a couple of ticks as stale. That way a
 * daemon that moves on - or dies - can never leave sleeves grinding a faction we
 * abandoned. bnX daemons additionally clear it at the top of each decision tick.
 * @param {string} faction @param {string} type - workForFaction job type
 */
export function recordFactionWork(faction, type) {
  globalThis.gordFactionWork = { faction, type, at: Date.now() };
}

/** Clear the record above (call at the top of a decision tick). */
export function clearFactionWork() {
  globalThis.gordFactionWork = null;
}

// ── Auto-focus preference (the HUD toggle) ───────────────────────────────────
//
// Focused work pins the game's UI to the work screen, and the daemon re-issues its
// work every tick - so while the bot is focus-working you can't hand-manage the
// corp or the gang for more than a few seconds at a time. The HUD header carries a
// FOCUS button (ui/dashboard.js) that flips globalThis.gordAutoFocus; this module
// owns the flag, since focusFlag() is the single place the whole codebase decides
// what to pass as a work call's `focus` argument.

/**
 * The player's auto-focus preference: true (the default) means the bot may focus,
 * false means every gym/study/crime/faction call goes out unfocused so the UI stays
 * where the player left it. Persistence and the seed-from-disk are lib/toggles.js's
 * job; what's specific here is the onChange effect.
 *
 * setFocus() on the transition matters because a crime the daemon is already
 * committing is deliberately never re-issued (that would forfeit the attempt's sunk
 * progress) - without it, flipping the toggle wouldn't take hold until the crime
 * itself changed, which can be a long wait.
 * @param {NS} ns
 */
export function autoFocusEnabled(ns) {
  return toggleEnabled(ns, {
    key: "gordAutoFocus",
    file: CONFIG.paths.focusFile,
    // Apply it to whatever the player is doing right now, not just the next task.
    onChange: (value) => ns.singularity.setFocus(value),
  });
}

/**
 * True when the player must actively focus to earn full rates on gym/study/
 * crime/faction work.
 *
 * The no-focus perk (Neuroreceptor Management Implant) only takes effect once
 * the aug is actually INSTALLED, not merely purchased-and-queued. So we check
 * getOwnedAugmentations(false) = installed-only. Using `true` (which counts
 * purchased-but-not-installed augs) would drop focus during the window between
 * buying the implant and the next reset, when the perk isn't active yet - we'd
 * background our work and silently earn at the reduced, unfocused rate.
 *
 * This is the CAPABILITY question ("would backgrounding this cost us rate?"), which
 * is what the callers branch on when deciding whether to run a second job in the
 * background. The HUD toggle deliberately does NOT change it - see focusFlag.
 * @param {NS} ns
 */
export function shouldFocus(ns) {
  try {
    return !ns.singularity
      .getOwnedAugmentations(false)
      .includes(PL.noFocusAug);
  } catch {
    return true;
  }
}

/**
 * The value to pass as the `focus` argument of a Singularity work call: focus only
 * when we'd otherwise lose rate (shouldFocus) AND the player hasn't turned
 * auto-focus off in the HUD.
 *
 * Kept separate from shouldFocus on purpose. shouldFocus also gates WHAT work we
 * choose ("we can background this, so bank secondary faction rep too"); folding the
 * toggle into it would quietly rewire those decisions, when all the player asked for
 * was to stop the game hijacking the screen. So the toggle changes exactly one
 * thing: whether the work we'd have done anyway is focused.
 * @param {NS} ns
 */
export function focusFlag(ns) {
  // autoFocusEnabled first: it's the side of the && that reconciles the flag with
  // disk and applies a just-flipped preference, so it must run even when the
  // no-focus aug would short-circuit the answer to false anyway.
  const allowed = autoFocusEnabled(ns);
  return allowed && shouldFocus(ns);
}

// The getMoneySources() categories that are pure INCOME. Spending lands in its
// own categories (servers, augmentations, hacknet_expenses, stock buys, ...), so
// summing these gives money EARNED regardless of what was bought in between -
// which is what an ETA estimate wants. Differencing player.money instead counted
// every aug/server purchase as a tick of zero income and sagged the EMA right
// when the "how long until I can afford this?" sort needed it most.
const INCOME_SOURCES = [
  "hacking", "gang", "crime", "hacknet", "codingcontract", "work", "sleeves",
  "corporation", "casino", "infiltration", "bladeburner",
];

/** @param {NS} ns - money earned since the last install (income categories only), or null. */
function incomeEarned(ns) {
  try {
    const since = /** @type {any} */ (ns).getMoneySources?.()?.sinceInstall;
    if (!since) return null;
    return INCOME_SOURCES.reduce((sum, k) => sum + Math.max(0, since[k] ?? 0), 0);
  } catch {
    return null;
  }
}

/**
 * Estimates income rate using a rolling snapshot stored in globalThis.
 * Returns $/ms, or 0 if we don't have enough history yet.
 * Also writes the derived rate back to globalThis._incomeRatePerMs so
 * aug-targets.js can read it without duplicating the snapshot logic.
 *
 * Measures EARNINGS (getMoneySources income categories, see INCOME_SOURCES)
 * rather than the balance, so purchases don't read as lost income; falls back
 * to the balance where getMoneySources is unavailable. Seeds the rate from the
 * whole run's earnings on the very first call so aug-targets.js doesn't see
 * Infinity ETAs for the first several ticks after an install.
 * @param {NS} ns
 */
export function estimateIncomeRate(ns) {
  const now = Date.now();
  const earnedSoFar = incomeEarned(ns);
  const money = earnedSoFar ?? ns.getPlayer().money;
  const snap = globalThis._incomeSnap;

  // Seed from the run's average on the very first call.
  if (!globalThis._incomeRatePerMs && earnedSoFar !== null) {
    try {
      const reset = ns.getResetInfo();
      const elapsedMs = Math.max(1, now - reset.lastAugReset);
      const seededRate = earnedSoFar / elapsedMs;
      if (seededRate > 0) globalThis._incomeRatePerMs = seededRate;
    } catch {}
  }

  if (!snap || now - snap.time < PL.incomeSnapshotMs) {
    globalThis._incomeSnap = { time: now, money };
    return globalThis._incomeRatePerMs ?? 0;
  }

  const earned = money - snap.money;
  const rate   = earned > 0 ? earned / (now - snap.time) : 0;

  // Exponential moving average so the rate smooths over time.
  const prev = globalThis._incomeRatePerMs ?? 0;
  globalThis._incomeRatePerMs = prev === 0 ? rate : prev * (1 - PL.incomeEmaAlpha) + rate * PL.incomeEmaAlpha;

  globalThis._incomeSnap = { time: now, money };
  return globalThis._incomeRatePerMs;
}

/**
 * Update per-faction rep rate snapshot. Call once per daemon loop tick.
 * Stores { rate (rep/ms) } into globalThis._repSnaps[factionName].
 * @param {NS} ns
 * @param {string} factionName
 */
export function updateRepRate(ns, factionName) {
  if (!factionName) return;
  const snaps = globalThis._repSnaps ?? {};
  const now   = Date.now();
  const rep   = ns.singularity.getFactionRep(/** @type {any} */ (factionName));

  const snap = snaps[factionName];
  if (snap && now - snap.time >= PL.repSnapshotMs) {
    const gained = rep - snap.rep;
    const rate   = gained > 0 ? gained / (now - snap.time) : 0;
    snaps[factionName] = { time: now, rep, rate };
  } else if (!snap) {
    snaps[factionName] = { time: now, rep, rate: 0 };
  }

  globalThis._repSnaps = snaps;
}

/**
 * If darkweb programs aren't available and income is too slow to buy them,
 * switch to creating BruteSSH.exe and FTPCrack.exe manually.
 * Returns a status object if we took action, null otherwise.
 * @param {NS} ns
 */
export async function maybeCreatePrograms(ns) {
  const s = ns.singularity;
  const hacking = ns.getPlayer().skills?.hacking ?? ns.getHackingLevel();
  const money = ns.getPlayer().money;

  // Work out which programs we still need, in priority order.
  const needed = Object.entries(CREATE_PROGRAM_HACK_REQ).filter(
    ([prog]) => !ns.fileExists(prog, HOME)
  );

  if (needed.length === 0) return null;

  // During very early game (no TOR yet), check if income is fast enough
  // to just buy TOR + BruteSSH rather than creating manually.
  const hasTor = ns.hasTorRouter();
  if (!hasTor) {
    const target = TOR_COST + BRUTE_SSH_COST;
    const missing = Math.max(0, target - money);
    if (missing === 0) return null;

    const rate = estimateIncomeRate(ns);
    if (rate > 0 && missing / rate <= SLOW_INCOME_THRESHOLD_MS) {
      return null; // income fast enough - let buyDarkweb handle it
    }
  }

  // Try to create each needed program in hack-level order.
  for (const [prog, reqLevel] of needed) {
    if (ns.fileExists(prog, HOME)) continue;

    // Already creating this one - just report status.
    const busy = ns.singularity.getCurrentWork();
    if (busy?.type === "CREATE_PROGRAM" && busy?.programName === prog) {
      return {
        action: "Creating Program",
        detail: `${prog} (${hacking}/${reqLevel} hack)`,
        prog,
      };
    }

    if (hacking >= reqLevel) {
      const started = s.createProgram(/** @type {any} */ (prog), focusFlag(ns));
      if (started) {
        return {
          action: "Creating Program",
          detail: `${prog} (hack ${hacking} >= ${reqLevel})`,
          prog,
        };
      }
    }

    // Not high enough hack level yet - study toward it.
    // Only block on the first uncreateable program; don't skip ahead.
    s.universityCourse(STUDY_LOCATION, STUDY_CLASS, focusFlag(ns));
    return {
      action: "Studying for Program",
      detail: `Need hack ${reqLevel} for ${prog} (currently ${hacking})`,
      prog,
      reqLevel,
    };
  }

  return null;
}

/** @param {NS} ns */
export async function doEarlyBootstrapIfNeeded(ns) {
  const player = ns.getPlayer();
  const hacking = player.skills?.hacking ?? ns.getHackingLevel();

  if (hacking < EARLY_HACK_TARGET) {
    ns.singularity.universityCourse(
      STUDY_LOCATION,
      STUDY_CLASS,
      focusFlag(ns)
    );

    return {
      action: "Studying",
      detail: `Hacking ${hacking}/${EARLY_HACK_TARGET}`,
    };
  }

  const mug = /** @type {any} */ ("Mug");
  const mugChance = ns.singularity.getCrimeChance(mug);

  if (mugChance < EARLY_MUG_CHANCE) {
    const strength = player.skills?.strength ?? 0;
    const defense  = player.skills?.defense  ?? 0;
    const stat = strength <= defense ? "str" : "def";

    ns.singularity.gymWorkout(
      GYM,
      /** @type {any} */ (stat),
      focusFlag(ns)
    );

    return {
      action: "Training",
      detail: `Mug chance ${ns.format.percent(mugChance)} / ${ns.format.percent(EARLY_MUG_CHANCE)} | ${stat}`,
      stat,
      chance: mugChance,
    };
  }

  // Mug chance is sufficient — actively mug until we have TOR + BruteSSH money.
  // This is the fastest way to get to $700k early game.
  const hasTor = ns.hasTorRouter();
  const hasBrute = ns.fileExists("BruteSSH.exe", HOME);
  const moneyTarget = (!hasTor ? TOR_COST : 0) + (!hasBrute ? BRUTE_SSH_COST : 0);

  if (moneyTarget > 0 && player.money < moneyTarget) {
    ns.singularity.commitCrime(mug, focusFlag(ns));
    return {
      action: "Crime",
      detail: `Mugging for TOR/BruteSSH ($${ns.format.number(player.money)} / $${ns.format.number(moneyTarget)})`,
    };
  }

  return null;
}

/**
 * Called when there are no aug targets and no faction pursuit available.
 * Priority chain:
 *  1. Homicide if chance is high — best $/s + karma
 *  2. Bank faction rep (background, no focus needed)
 *  3. Study to grow hacking level / income for next run
 *
 * Pass `moneyGoal` (e.g. a faction join requirement) to keep crime going
 * until we hit it rather than falling back to studying early.
 *
 * @param {NS} ns
 * @param {number} [moneyGoal]
 */
export async function doIdleWork(ns, moneyGoal = 0) {
  const s = ns.singularity;
  const money = ns.getPlayer().money;

  // 1. Crime - always good for money + karma; best expected rate wins.
  const crimeReason = moneyGoal > money ? `$${(moneyGoal / 1e6).toFixed(2)}M for faction` : "idle";
  const crimeResult = await commitBestCrimeIfUseful(ns, crimeReason);
  if (crimeResult) return crimeResult;

  // 2. Bank faction rep for NFG levels / future aug cycles. focusFlag() already
  //    resolves to false when we can background work (the no-focus implant) or
  //    the HUD has focus off, so one loop covers both the background and the
  //    focused case. NeuroFlux counts here: its rep requirement climbs with every
  //    level, and it's the pre-install money dump, so more NFG rep is never wasted.
  const owned  = new Set(s.getOwnedAugmentations(true));
  const joined = /** @type {string[]} */ (ns.getPlayer().factions ?? []);

  for (const factionName of joined) {
    if (!factionRepStillUseful(ns, factionName, owned, { includeNFG: true, requirePrereqs: false })) continue;

    for (const type of PL.factionWorkTypes) {
      if (s.workForFaction(/** @type {any} */ (factionName), /** @type {any} */ (type), focusFlag(ns))) {
        recordFactionWork(factionName, type);
        return {
          action: "Faction Rep (idle)",
          detail: `${factionName} (${type}) - banking rep for NFG / future augs`,
        };
      }
    }
  }

  // 3. Fallback: study to grow hacking for the next run.
  const hacking = ns.getPlayer().skills?.hacking ?? ns.getHackingLevel();
  s.universityCourse(STUDY_LOCATION, STUDY_CLASS, focusFlag(ns));
  return {
    action: "Studying (idle)",
    detail: `Growing hacking (${hacking}) - no faction work available`,
  };
}

/**
 * Hop to a city and back for any faction that's fully ready to join
 * (money/karma/kills/hacking/combat stats all met - just need to be
 * physically there), and otherwise make sure we're home (Sector-12) any time
 * there's nothing ready wherever we're currently standing (Gym/study only
 * work from there). This is a single cheap $200k trip that costs no game
 * time, so it's meant to be called unconditionally every loop tick,
 * regardless of focus or what else the bot is doing.
 *
 * Respects the same hacking-bootstrap gate as maybePursueNextFaction: until
 * every port-opener program is owned, only hackingFocus factions are
 * considered ready.
 *
 * @param {NS} ns
 * @param {any[]} opportunities - result of getUnjoinedFactionOpportunities(ns)
 */
export async function maybeAutoTravelForReadyFaction(ns, opportunities) {
  const s      = ns.singularity;
  const player = ns.getPlayer();

  if (!hasAllPortOpeners(ns)) {
    opportunities = opportunities.filter(o => o.hackingFocus);
  }

  const pickBest = (candidates) =>
    candidates.find(o => o.hackingFocus) ?? candidates[0] ?? null;

  const readyOp = pickBest(opportunities.filter(o => o.needsCity && o.canTravel));

  if (readyOp && player.city !== readyOp.city && player.money >= TRAVEL_COST) {
    s.travelToCity(/** @type {any} */ (readyOp.city));
    return {
      action: "Traveling",
      detail: `-> ${readyOp.city} for ${readyOp.faction} (ready to join)`,
      city: readyOp.city,
      faction: readyOp.faction,
    };
  }

  // Nothing ready right where we're standing - and there's never a reason for
  // this bot to be away from Sector-12 otherwise (Gym is there), so head back.
  // EXCEPTION: while we're deliberately parked in a company's city grinding its
  // reputation (the daemon publishes globalThis.gordCompanyCity for the run it
  // chose - see the company-work step below), don't yank us out. The flag is set
  // only when Company Work is the active action, so on any other tick it's cleared
  // and this behaves exactly as before. Undefined on non-company nodes - inert there.
  const stayCity = globalThis.gordCompanyCity;
  const somethingReadyHere = opportunities.some(
    o => o.needsCity && o.canTravel && o.city === player.city
  );
  if (!somethingReadyHere && player.city !== GYM_CITY && player.city !== stayCity && player.money >= TRAVEL_COST) {
    s.travelToCity(/** @type {any} */ (GYM_CITY));
    return {
      action: "Traveling",
      detail: `<- ${GYM_CITY} (home)`,
      city: GYM_CITY,
      faction: null,
    };
  }

  return null;
}

 /*
 * Priority:
 *  1. Report what's still blocking a city faction (money/karma/kills/etc) IF
 *     we're idle, so the caller can prioritize earning/training toward it.
 *  2. Train combat stats if we're within 50 levels of a useful faction -
 *     covers both pure combat/gang factions (Slum Snakes) and city+combat
 *     ones (Tetrads, The Dark Army, The Syndicate). Powerhouse Gym only
 *     exists in Sector-12, so training always happens at home first
 *     (maybeAutoTravelForReadyFaction already keeps us there by default).
 *
 * Within each step, hackingFocus opportunities (CyberSec, NiteSec, BitRunners,
 * Tian Di Hui, Netburners, The Black Hand) are preferred over combat/gang
 * factions when both are viable - this is BN4, so hacking programs, hacking
 * augs, and hacking rep come first. Until every port-opener program is owned,
 * gang/combat factions (Slum Snakes, Tetrads, Speakers for the Dead, The Dark
 * Army, The Syndicate) are skipped entirely so they can't compete with
 * finishing the hacking bootstrap.
 *
 * Only acts when shouldFocus() is false (i.e. hacking runs freely in BG), OR
 * when there is genuinely nothing else to do (passed via `isIdle`).
 *
 * @param {NS} ns
 * @param {any[]} opportunities - result of getUnjoinedFactionOpportunities(ns)
 * @param {boolean} isIdle
 * @param {{pursue: (ns: NS, opportunities: any[], player: any) => any} | null} [companyWork]
 *   lib/company-work.js, on nodes that grind megacorp reputation (BN10); its
 *   Singularity calls stay out of this file so other daemons don't pay for them.
 */
export async function maybePursueNextFaction(ns, opportunities, isIdle, companyWork = null) {
  const s      = ns.singularity;
  const player = ns.getPlayer();
  const focus  = shouldFocus(ns);

  // Only steal focus when truly idle; otherwise only act if we can background.
  if (focus && !isIdle) return null;

  // Programs first: don't let gang/combat factions compete for travel/gym
  // time until the hacking bootstrap (all 5 port openers) is done.
  if (!hasAllPortOpeners(ns)) {
    opportunities = opportunities.filter(o => o.hackingFocus);
  }

  // Among several equally-viable opportunities, prefer hacking-focused ones.
  const pickBest = (candidates) =>
    candidates.find(o => o.hackingFocus) ?? candidates[0] ?? null;

  // ── 1. City factions still blocked (money/karma/kills/hacking/stats) ──────
  // Surface the top blocker as an explicit goal so the caller can prioritize
  // earning/training toward it.
  const blockedOp = pickBest(opportunities.filter(
    o => o.needsCity && !o.canTravel && o.urgency !== "future"
  ));
  if (blockedOp && isIdle) {
    return {
      action: "Saving for Faction",
      detail: blockedOp.reason,
      faction: blockedOp.faction,
      joinMoneyMissing: blockedOp.joinMoneyMissing,
    };
  }

  // ── 2. Combat-stat-gated factions ─────────────────────────────────────────
  // Train if we're "close" (within 50 levels) to unlocking a faction.
  const combatOp = opportunities.find(
    o => o.combatReqs && o.isClose && (o.urgency === "medium" || o.urgency === "low")
  );

  if (combatOp) {
    // Make sure we're home so Powerhouse Gym is accessible.
    if (player.city !== GYM_CITY && player.money >= TRAVEL_COST) {
      s.travelToCity(/** @type {any} */ (GYM_CITY));
      return {
        action: "Traveling",
        detail: `<- ${GYM_CITY} to train for ${combatOp.faction}`,
        city: GYM_CITY,
        faction: combatOp.faction,
      };
    }

    const training = await trainCombatIfNeeded(ns, combatOp.combatReqs);
    if (training) {
      return {
        ...training,
        detail: `${training.detail} (for ${combatOp.faction})`,
      };
    }
  }

  // ── 3. Company (megacorp) factions ────────────────────────────────────────
  // "When we run out of factions, add the corporation factions as a next option
  // if they have augs available." Only nodes that opt in pass lib/company-work.js
  // here; it works the highest-priority company faction still short of its gate.
  if (companyWork) {
    const company = companyWork.pursue(ns, opportunities, player);
    if (company) return company;
  }

  // Note: no separate "return home if stranded" step needed here -
  // maybeAutoTravelForReadyFaction already brings us home unconditionally
  // whenever nothing is ready at our current location.

  return null;
}