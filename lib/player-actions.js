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
const SLOW_INCOME_THRESHOLD_MS = 10 * 60 * 1_000; // 10 minutes

// Hacking level required to create each program via createProgram().
// Listed in priority order - more programs = more rootable servers = more RAM.
const CREATE_PROGRAM_HACK_REQ = {
  "BruteSSH.exe":  50,
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

  if (!snap || now - snap.time < 5_000) {
    globalThis._incomeSnap = { time: now, money };
    return globalThis._incomeRatePerMs ?? 0;
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

  // Work out which programs we still need, in priority order.
  const needed = Object.entries(CREATE_PROGRAM_HACK_REQ).filter(
    ([prog]) => !ns.fileExists(prog, "home")
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
    if (ns.fileExists(prog, "home")) continue;

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
  const hasBrute = ns.fileExists("BruteSSH.exe", "home");
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
 *  1. Homicide if chance is high (karma + money)
 *  2. Study Algorithms to keep growing hacking XP and income
 *  3. Work for any joined faction that still has unearned rep (bank NFG rep)
 *
 * @param {NS} ns
 */
export async function doIdleWork(ns) {
  const s = ns.singularity;

  // 1. Crime if homicide chance is good — money + karma both useful
  const homicideResult = await commitHomicideIfUseful(ns, "idle");
  if (homicideResult) return homicideResult;

  // 2. If we can't crime effectively, study to keep hacking scaling
  //    (higher hack level = better money/sec = faster aug saves next run)
  const hacking = ns.getPlayer().skills?.hacking ?? ns.getHackingLevel();
  if (!shouldFocus(ns)) {
    // Background study: doesn't interrupt anything
    s.universityCourse(STUDY_LOCATION, STUDY_CLASS, false);
    return {
      action: "Studying (idle)",
      detail: `Growing hacking (${hacking}) for next run`,
    };
  }

  // 3. Focus mode: bank faction rep for NFG or future aug cycles
  //    Pick the highest-priority joined faction that still has rep headroom.
  const owned  = new Set(s.getOwnedAugmentations(true));
  const joined = /** @type {string[]} */ (ns.getPlayer().factions ?? []);

  for (const factionName of joined) {
    const faction = /** @type {any} */ (factionName);
    const augs = s.getAugmentationsFromFaction(faction);
    const currentRep = s.getFactionRep(faction);

    // Check if any aug (including NFG) still has rep headroom
    const hasRepRoom = augs.some(aug => {
      if (owned.has(aug) && aug !== "NeuroFlux Governor") return false;
      return s.getAugmentationRepReq(aug) > currentRep;
    });

    if (!hasRepRoom) continue;

    const workType = (() => {
      for (const type of ["hacking", "field", "security"]) {
        if (s.workForFaction(faction, /** @type {any} */ (type), shouldFocus(ns))) return type;
      }
      return null;
    })();

    if (workType) {
      return {
        action: "Faction Rep (idle)",
        detail: `${factionName} (${workType}) - banking rep for NFG / future augs`,
      };
    }
  }

  // 4. Fallback: study with focus
  s.universityCourse(STUDY_LOCATION, STUDY_CLASS, shouldFocus(ns));
  return {
    action: "Studying (idle)",
    detail: `Growing hacking (${hacking}) - no faction work available`,
  };
}

 /*
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
          detail: `-> ${city} for ${faction}`,
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
            detail: `<- ${GYM_CITY} (home)`,
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

  // ── 3. Return home if stranded ─────────────────────────────────────────────
  if (player.city !== GYM_CITY && isIdle && player.money >= TRAVEL_COST) {
    s.travelToCity(/** @type {any} */ (GYM_CITY));
    return {
      action: "Traveling",
      detail: `<- ${GYM_CITY} (returning home)`,
      city: GYM_CITY,
      faction: null,
    };
  }

  return null;
}