// lib/player-actions.js

const GYM = "Powerhouse Gym";
// Powerhouse Gym is in Sector-12; this is where home is.
const GYM_CITY = "Sector-12";

const COMBAT_STATS = ["strength", "defense", "dexterity", "agility"];

const STUDY_LOCATION = "Rothman University";
const STUDY_CLASS = "Algorithms";
const EARLY_HACK_TARGET = 50;
const EARLY_MUG_CHANCE = 0.75;

// If it would take longer than this to save up for TOR + BruteSSH, just
// train hacking and create the programs manually instead.
const TOR_COST = 200_000;
const BRUTE_SSH_COST = 500_000;   // darkweb price
const FTP_CRACK_COST = 1_500_000; // darkweb price
const SLOW_INCOME_THRESHOLD_MS = 10 * 60 * 1_000; // 10 minutes

// Hacking level required to create each program via createProgram().
const CREATE_PROGRAM_HACK_REQ = {
  "BruteSSH.exe": 50,
  "FTPCrack.exe": 100,
};

// Travel cost (always $200k flat in Bitburner).
const TRAVEL_COST = 200_000;

/** @param {NS} ns */
export async function trainCombatIfNeeded(ns, targets = {}) {
  const player = ns.getPlayer();

  for (const stat of COMBAT_STATS) {
    const current = player.skills?.[stat] ?? player[stat] ?? 0;
    const needed = targets[stat] ?? 0;

    if (current < needed) {
      // gymWorkout uses "strength"/"defense"/"dexterity"/"agility" — exact match.
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

  if (chance >= 0.8) {
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

/** @param {NS} ns */
export function shouldFocus(ns) {
  try {
    return !ns.singularity
      .getOwnedAugmentations(true)
      .includes("Neuroreceptor Management Implant");
  } catch {
    return true;
  }
}

/**
 * Estimates income rate using a rolling snapshot stored in globalThis.
 * Returns $/ms, or 0 if we don't have enough history yet.
 * Also writes the derived rate back to globalThis._incomeRatePerMs so
 * aug-targets.js can read it without duplicating the snapshot logic.
 * @param {NS} ns
 */
export function estimateIncomeRate(ns) {
  const now = Date.now();
  const money = ns.getPlayer().money;
  const snap = globalThis._incomeSnap;

  if (!snap || now - snap.time < 5_000) {
    globalThis._incomeSnap = { time: now, money };
    return 0;
  }

  const earned = money - snap.money;
  const rate   = earned > 0 ? earned / (now - snap.time) : 0;

  // Exponential moving average so the rate smooths over time.
  const prev = globalThis._incomeRatePerMs ?? 0;
  globalThis._incomeRatePerMs = prev === 0 ? rate : prev * 0.8 + rate * 0.2;

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
  if (snap && now - snap.time >= 5_000) {
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

  // Work out which of the two programs we still need.
  const needed = Object.entries(CREATE_PROGRAM_HACK_REQ).filter(
    ([prog]) => !ns.fileExists(prog, "home")
  );

  if (needed.length === 0) return null; // already have both, nothing to do

  // If TOR isn't bought yet, check if money is accumulating fast enough.
  const hasTor = ns.hasTorRouter();
  if (!hasTor) {
    const target = TOR_COST + BRUTE_SSH_COST;
    const missing = Math.max(0, target - money);
    if (missing === 0) return null;

    const rate = estimateIncomeRate(ns);
    if (rate > 0 && missing / rate <= SLOW_INCOME_THRESHOLD_MS) {
      return null; // income is fast enough; save up normally
    }
  } else {
    const ftpMissing = !ns.fileExists("FTPCrack.exe", "home");
    if (ftpMissing) {
      const missing = Math.max(0, FTP_CRACK_COST - money);
      if (missing === 0) return null;
      const rate = estimateIncomeRate(ns);
      if (rate > 0 && missing / rate <= SLOW_INCOME_THRESHOLD_MS) return null;
    } else {
      return null;
    }
  }

  for (const [prog, reqLevel] of needed) {
    if (ns.fileExists(prog, "home")) continue;

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

    // gymWorkout accepts "strength" or "defense" (full stat names, not abbreviations)
    const stat = strength <= defense ? "strength" : "defense";

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

  return null;
}

/**
 * Pursue the next unjoined faction if we have nothing better to do.
 *
 * Priority:
 *  1. Travel to a city-gated faction IF we're idle and can afford it.
 *  2. Train combat stats if we're within 50 levels of a useful faction.
 *  3. Return home (Sector-12) if we're in a foreign city with no reason to stay.
 *
 * Only acts when shouldFocus() is false (i.e. hacking runs freely in BG),
 * OR when there is genuinely nothing else to do (passed via `isIdle`).
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

  // ── 1. City-gated factions ─────────────────────────────────────────────────
  // Find the highest-priority city faction we could visit.
  const cityOp = opportunities.find(
    o => o.needsCity && o.canTravel && o.urgency !== "future"
  );

  if (cityOp) {
    const { city, faction } = cityOp;

    if (player.city !== city) {
      // Travel there. After travel, acceptInvites in daemon will fire.
      if (player.money >= TRAVEL_COST) {
        s.travelToCity(/** @type {any} */ (city));
        return {
          action: "Traveling",
          detail: `→ ${city} for ${faction}`,
          city,
          faction,
        };
      }
    } else {
      // Already there — if we got the invite it'll be accepted next loop.
      // If there's combat req, train here.
      if (cityOp.combatReqs) {
        const training = await trainCombatIfNeeded(ns, cityOp.combatReqs);
        if (training) {
          return {
            ...training,
            detail: `${training.detail} (for ${faction})`,
          };
        }
      }

      // Nothing left to do in this city — head home so GYM is accessible.
      if (player.city !== GYM_CITY) {
        if (player.money >= TRAVEL_COST) {
          s.travelToCity(/** @type {any} */ (GYM_CITY));
          return {
            action: "Traveling",
            detail: `← ${GYM_CITY} (home)`,
            city: GYM_CITY,
            faction: null,
          };
        }
      }
    }
  }

  // ── 2. Combat-stat-gated factions ─────────────────────────────────────────
  // Train if we're "close" (within 50 levels) to unlocking a faction.
  const combatOp = opportunities.find(
    o => o.combatReqs && !o.needsCity && (o.urgency === "medium" || o.urgency === "low") && o.isClose
  );

  if (combatOp) {
    // Make sure we're home so Powerhouse Gym is accessible.
    if (player.city !== GYM_CITY && player.money >= TRAVEL_COST) {
      s.travelToCity(/** @type {any} */ (GYM_CITY));
      return {
        action: "Traveling",
        detail: `← ${GYM_CITY} to train for ${combatOp.faction}`,
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

  // ── 3. Return home if stranded ─────────────────────────────────────────────
  if (player.city !== GYM_CITY && isIdle && player.money >= TRAVEL_COST) {
    s.travelToCity(/** @type {any} */ (GYM_CITY));
    return {
      action: "Traveling",
      detail: `← ${GYM_CITY} (returning home)`,
      city: GYM_CITY,
      faction: null,
    };
  }

  return null;
}