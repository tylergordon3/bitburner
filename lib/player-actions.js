// lib/player-actions.js

const GYM = "Powerhouse Gym";

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

/** @param {NS} ns */
export async function trainCombatIfNeeded(ns, targets = {}) {
  const player = ns.getPlayer();

  for (const stat of COMBAT_STATS) {
    const current = player.skills?.[stat] ?? player[stat] ?? 0;
    const needed = targets[stat] ?? 0;

    if (current < needed) {
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
 * @param {NS} ns
 */
function estimateIncomeRate(ns) {
  const now = Date.now();
  const money = ns.getPlayer().money;
  const snap = globalThis._incomeSnap;

  // Always refresh snapshot; but only compute a rate once we have one.
  globalThis._incomeSnap = { time: now, money };

  if (!snap || now - snap.time < 5_000) return 0; // need at least 5 s of data
  const earned = money - snap.money;
  if (earned <= 0) return 0;
  return earned / (now - snap.time);
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
  // If we can afford TOR + BruteSSH within the threshold, let buyDarkweb handle it.
  const hasTor = ns.hasTorRouter();
  if (!hasTor) {
    const target = TOR_COST + BRUTE_SSH_COST;
    const missing = Math.max(0, target - money);
    if (missing === 0) return null; // can buy right now, let normal flow handle it

    const rate = estimateIncomeRate(ns);
    if (rate > 0 && missing / rate <= SLOW_INCOME_THRESHOLD_MS) {
      return null; // income is fast enough; save up normally
    }
    // Income is too slow (or unknown). Fall through to create programs.
  } else {
    // Have TOR. If FTPCrack is missing but affordable, let buyDarkweb handle it.
    const ftpMissing = !ns.fileExists("FTPCrack.exe", "home");
    if (ftpMissing) {
      const missing = Math.max(0, FTP_CRACK_COST - money);
      if (missing === 0) return null;
      const rate = estimateIncomeRate(ns);
      if (rate > 0 && missing / rate <= SLOW_INCOME_THRESHOLD_MS) return null;
    } else {
      return null; // have TOR and FTPCrack — nothing left to do here
    }
  }

  // Find the first program we can create (or train toward).
  for (const [prog, reqLevel] of needed) {
    if (ns.fileExists(prog, "home")) continue;

    // Already creating this program? Don't restart.
    const busy = ns.singularity.getCurrentWork();
    if (busy?.type === "CREATE_PROGRAM" && busy?.programName === prog) {
      return {
        action: "Creating Program",
        detail: `${prog} (${hacking}/${reqLevel} hack)`,
        prog,
      };
    }

    if (hacking >= reqLevel) {
      // Start creation (non-blocking; the game runs it in the background).
      const started = s.createProgram(/** @type {any} */ (prog), shouldFocus(ns));
      if (started) {
        return {
          action: "Creating Program",
          detail: `${prog} (hack ${hacking} >= ${reqLevel})`,
          prog,
        };
      }
    }

    // Hack level too low — study until we hit the requirement.
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
    const defense = player.skills?.defense ?? 0;

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

  return null;
}