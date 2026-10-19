// lib/sleeves-lite.js
//
// The sleeves' stand-in for when lib/sleeves.js (~72GB of ns.sleeve.*) has no
// host: every sleeve on its best money crime, nothing else. A poor network has
// nothing that size - BN13's first install left a 128GB home and 16GB servers,
// and eight sleeves sat in shock recovery for the rest of the run while the
// player went $35m into debt. Crime is what they should be doing then: shock
// cuts a sleeve's crime EXP, not its money (SleeveCrimeWork scales only the
// exp by shockBonus), and shock keeps falling while they work.
//
// The daemon core launches this only while the full manager is not running,
// and it stops itself the moment the manager publishes fresh state, so the two
// never steer the same sleeve.
//
// Ranking: chance x money per attempt / time, by the 0GB Formulas API
// (ns.formulas.work.*, needs Formulas.exe - SF5 hands it out at every start);
// without the exe every sleeve shoplifts, the crime anyone lands. Where the
// node grinds toward a gang (gang.activeKarmaGrind - the daemon passes the
// karma gate as arg [0]) it ranks by KARMA until the player is past the gate:
// there the sleeves' karma is the grind.
//
// Args: [0] the gang's karma gate while it is being ground toward, else 0.
//
// RAM: 14.2GB = 1.6 base + getSleeve, getTask, setToCommitCrime (4 each)
// + getPlayer (0.5) + fileExists (0.1). Fits a 16GB server.

import { CONFIG } from "./config.js";
import { pickBestCrime } from "./crime-logic.js";

// Base durations (src/Crime/Crimes.ts); the money comes from crimeGains.
const CRIME_MS = {
  Shoplift: 2_000,
  "Rob Store": 60_000,
  Mug: 4_000,
  Larceny: 90_000,
  "Deal Drugs": 10_000,
  Homicide: 3_000,
};
// Karma per success (src/Crime/Crimes.ts).
const CRIME_KARMA = { Shoplift: 0.1, "Rob Store": 0.5, Mug: 0.25, Larceny: 1.5, "Deal Drugs": 0.5, Homicide: 3 };
const MAX_SLEEVES = 8;

/** Is the full manager up? Its state is stamped every tick. */
function managerFresh() {
  const s = globalThis.gordSleeveState;
  return !!s && Date.now() - (s.updatedAt ?? 0) < CONFIG.ui.staleMs.helper;
}

/** @param {NS} ns @param {number} karmaGate - 0 when no gang is being ground toward */
function tick(ns, karmaGate) {
  const formulas = ns.fileExists("Formulas.exe", CONFIG.paths.home);
  const metric = karmaGate < 0 && (ns.getPlayer().karma ?? 0) > karmaGate ? "karma" : "money";
  let assigned = 0;
  for (let i = 0; i < MAX_SLEEVES; i++) {
    let person;
    try {
      person = ns.sleeve.getSleeve(i);
    } catch {
      break; // past the last sleeve
    }
    let crime = "Shoplift";
    if (formulas) {
      const candidates = Object.entries(CRIME_MS).map(([name, timeMs]) => ({
        crime: name,
        chance: ns.formulas.work.crimeSuccessChance(person, /** @type {any} */ (name)),
        money: ns.formulas.work.crimeGains(person, /** @type {any} */ (name)).money,
        karma: CRIME_KARMA[name] ?? 0,
        timeMs,
      }));
      crime = pickBestCrime(candidates, { metric })?.crime ?? crime;
    }
    // Re-issuing a crime restarts the attempt in flight.
    const task = /** @type {any} */ (ns.sleeve.getTask(i));
    if (!(task?.type === "CRIME" && task.crimeType === crime)) {
      ns.sleeve.setToCommitCrime(i, /** @type {any} */ (crime));
    }
    assigned++;
  }
  return assigned;
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  const karmaGate = Math.min(0, Number(ns.args[0]) || 0);
  while (!managerFresh()) {
    try {
      const n = tick(ns, karmaGate);
      if (n === 0) return; // no sleeves in this run
    } catch (e) {
      ns.print(`sleeves-lite tick error: ${String(e)}`);
    }
    await ns.sleep(CONFIG.sleeves.liteTickMs);
  }
  ns.print("lib/sleeves.js is running - handing the sleeves back.");
}
