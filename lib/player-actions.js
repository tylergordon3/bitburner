// lib/player-actions.js
//
// Everything that spends the player's own (single-threaded) attention: gym,
// study, crime, travel, faction work. All tuning lives in CONFIG.player and
// CONFIG.programs.

import { CONFIG } from "./config.js";

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

/** @param {NS} ns */
export async function trainCombatIfNeeded(ns, targets = {}) {
  const player = ns.getPlayer();

  for (const stat of COMBAT_STATS) {
    const current = player.skills?.[stat] ?? player[stat] ?? 0;
    const needed = targets[stat] ?? 0;

    if (current < needed) {
      // gymWorkout uses "strength"/"defense"/"dexterity"/"agility" - exact match.
      ns.singularity.gymWorkout(
        GYM,
        /** @type {any} */ (stat),
        shouldFocus(ns)
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
    ns.singularity.commitCrime(crime, shouldFocus(ns));

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
 * Try homicide first; fall back to mugging if homicide chance is too low.
 * Returns a status object if we started any crime, null if neither is viable.
 * @param {NS} ns
 * @param {string} [reason]
 */
export async function commitBestCrimeIfUseful(ns, reason = "money") {
  const s = ns.singularity;

  const homicideChance = s.getCrimeChance(/** @type {any} */ ("Homicide"));
  if (homicideChance >= PL.homicideMinChance) {
    s.commitCrime(/** @type {any} */ ("Homicide"), shouldFocus(ns));
    return {
      action: "Crime",
      detail: `Homicide for ${reason} (${Math.round(homicideChance * 100)}%)`,
      crime: "Homicide",
      chance: homicideChance,
    };
  }

  const mugChance = s.getCrimeChance(/** @type {any} */ ("Mug"));
  if (mugChance >= PL.mugMinChance) {
    s.commitCrime(/** @type {any} */ ("Mug"), shouldFocus(ns));
    return {
      action: "Crime",
      detail: `Mug for ${reason} (homicide only ${Math.round(homicideChance * 100)}%)`,
      crime: "Mug",
      chance: mugChance,
    };
  }

  return null;
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
 * Estimates income rate using a rolling snapshot stored in globalThis.
 * Returns $/ms, or 0 if we don't have enough history yet.
 * Also writes the derived rate back to globalThis._incomeRatePerMs so
 * aug-targets.js can read it without duplicating the snapshot logic.
 *
 * Fix #9: Seeds the rate from getMoneySources() on the very first call so
 * aug-targets.js doesn't see Infinity ETAs for the first several ticks after
 * an install, which would cause suboptimal early-run decisions.
 * @param {NS} ns
 */
export function estimateIncomeRate(ns) {
  const now = Date.now();
  const money = ns.getPlayer().money;
  const snap = globalThis._incomeSnap;

  // Seed from getMoneySources on very first call
  if (!globalThis._incomeRatePerMs) {
    try {
      const n = /** @type {any} */ (ns);
      if (n.getMoneySources && n.getResetInfo) {
        const sources = n.getMoneySources();
        const reset   = n.getResetInfo();
        const total   = sources.sinceInstall?.total ?? 0;
        const elapsedMs = Math.max(1, Date.now() - reset.lastAugReset);
        const seededRate = total / elapsedMs;
        if (seededRate > 0) {
          globalThis._incomeRatePerMs = seededRate;
        }
      }
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
      const started = s.createProgram(/** @type {any} */ (prog), shouldFocus(ns));
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
    s.universityCourse(STUDY_LOCATION, STUDY_CLASS, shouldFocus(ns));
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
      shouldFocus(ns)
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
      shouldFocus(ns)
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
    ns.singularity.commitCrime(mug, shouldFocus(ns));
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

  // 1. Crime — always good for money + karma; try homicide then mugging
  const crimeReason = moneyGoal > money ? `$${(moneyGoal / 1e6).toFixed(2)}M for faction` : "idle";
  const crimeResult = await commitBestCrimeIfUseful(ns, crimeReason);
  if (crimeResult) return crimeResult;

  // 2. Bank faction rep in background when we can't focus-crime.
  if (!shouldFocus(ns)) {
    const owned  = new Set(s.getOwnedAugmentations(true));
    const joined = /** @type {string[]} */ (ns.getPlayer().factions ?? []);

    for (const factionName of joined) {
      const faction = /** @type {any} */ (factionName);
      const augs = s.getAugmentationsFromFaction(faction);
      const currentRep = s.getFactionRep(faction);

      const hasRepRoom = augs.some(aug => {
        if (owned.has(aug) && aug !== CONFIG.augs.neuroFlux) return false;
        return s.getAugmentationRepReq(aug) > currentRep;
      });
      if (!hasRepRoom) continue;

      for (const type of PL.factionWorkTypes) {
        if (s.workForFaction(faction, /** @type {any} */ (type), false)) {
          return {
            action: "Faction Rep (idle)",
            detail: `${factionName} (${type}) - banking rep for future augs`,
          };
        }
      }
    }

    // Background study as last resort
    const hacking = ns.getPlayer().skills?.hacking ?? ns.getHackingLevel();
    s.universityCourse(STUDY_LOCATION, STUDY_CLASS, false);
    return {
      action: "Studying (idle)",
      detail: `Growing hacking (${hacking}) for next run`,
    };
  }

  // 3. Focus mode: bank faction rep for NFG or future aug cycles
  const owned  = new Set(s.getOwnedAugmentations(true));
  const joined = /** @type {string[]} */ (ns.getPlayer().factions ?? []);

  for (const factionName of joined) {
    const faction = /** @type {any} */ (factionName);
    const augs = s.getAugmentationsFromFaction(faction);
    const currentRep = s.getFactionRep(faction);

    const hasRepRoom = augs.some(aug => {
      if (owned.has(aug) && aug !== CONFIG.augs.neuroFlux) return false;
      return s.getAugmentationRepReq(aug) > currentRep;
    });
    if (!hasRepRoom) continue;

    for (const type of PL.factionWorkTypes) {
      if (s.workForFaction(faction, /** @type {any} */ (type), shouldFocus(ns))) {
        return {
          action: "Faction Rep (idle)",
          detail: `${factionName} (${type}) - banking rep for NFG / future augs`,
        };
      }
    }
  }

  // 4. Fallback: study with focus
  const hacking = ns.getPlayer().skills?.hacking ?? ns.getHackingLevel();
  s.universityCourse(STUDY_LOCATION, STUDY_CLASS, shouldFocus(ns));
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
  // only when Company Work is the active action, so on ticks the daemon chose
  // something else (e.g. infiltration, which lives in Sector-12) it's cleared and
  // this behaves exactly as before. Undefined on non-company nodes - inert there.
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
 */
export async function maybePursueNextFaction(ns, opportunities, isIdle) {
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
  // if they have augs available." getUnjoinedFactionOpportunities only emits
  // these on opted-in nodes and only while the faction still has an unowned aug.
  // Singularity company work isn't city-locked, so we can grind rep from wherever
  // we are without fighting the auto-travel-home logic; the game auto-invites at
  // the rep gate and acceptInvites() joins, after which the faction's augs flow
  // into the normal aug pipeline. We pick the highest-priority such faction
  // (opportunities are already in FACTION_PRIORITY order).
  const companyOp = opportunities.find(o => o.needsCompany && o.companyRepMissing > 0);
  if (companyOp) {
    // City-locked builds: get to the company's city first. The daemon publishes
    // companyCity as globalThis.gordCompanyCity whenever this is the active action,
    // which stops maybeAutoTravelForReadyFaction from pulling us back home.
    if (CONFIG.factions.companyWorkNeedsCity && player.city !== companyOp.companyCity) {
      if (player.money < TRAVEL_COST) return null;
      s.travelToCity(/** @type {any} */ (companyOp.companyCity));
      return {
        action: "Company Work",
        detail: `-> ${companyOp.companyCity} for ${companyOp.company} rep -> ${companyOp.faction}`,
        faction: companyOp.faction,
        company: companyOp.company,
        companyCity: companyOp.companyCity,
      };
    }

    const field = applyBestCompanyJob(ns, companyOp.company);
    if (s.workForCompany(/** @type {any} */ (companyOp.company), focus)) {
      return {
        action: "Company Work",
        detail: `${companyOp.company} (${field ?? "employed"}) rep ${Math.round(companyOp.companyRepHave).toLocaleString()}/${companyOp.companyRepReq.toLocaleString()} -> ${companyOp.faction}`,
        faction: companyOp.faction,
        company: companyOp.company,
        companyCity: companyOp.companyCity,
      };
    }
  }

  // Note: no separate "return home if stranded" step needed here -
  // maybeAutoTravelForReadyFaction already brings us home unconditionally
  // whenever nothing is ready at our current location.

  return null;
}

/**
 * Make sure we hold the best-paying job we qualify for at `company`, so
 * workForCompany earns rep as fast as possible. Applies to each field in
 * CONFIG.factions.companyFieldPriority and takes the first that yields a position
 * (applyToCompany also auto-promotes us as our stats grow). Returns the field we
 * applied under, or null if we're already at the best position everywhere (or
 * don't yet qualify for any) - workForCompany still runs in that case.
 * @param {NS} ns @param {string} company
 */
function applyBestCompanyJob(ns, company) {
  const s = ns.singularity;
  for (const field of CONFIG.factions.companyFieldPriority) {
    const job = s.applyToCompany(/** @type {any} */ (company), /** @type {any} */ (field));
    if (job) return field;
  }
  return null;
}