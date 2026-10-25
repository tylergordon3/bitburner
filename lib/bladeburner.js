// lib/bladeburner.js
//
// The Bladeburner ACTION LOOP: picks and runs the player's contracts,
// operations and black ops. Off-home helper, launched by bn6/daemon.js ahead of
// the sleeve manager (see runDaemon's priorityHelpers), because in BN6 this IS
// the player's work - every ns.bladeburner.* call is 4GB, so it can't share
// home with the daemon. Skills, city and the faction join are the slower, lower
// priority lib/blade-upkeep.js, split out so this one is small enough to place
// early. Every decision is the pure lib/bladeburner-logic.js.
//
// ── The one shared resource: the player's work slot ─────────────────────────
// A Bladeburner action and ordinary work (faction work, gym, crime) cancel each
// other unless The Blade's Simulacrum is installed. So the daemon decides who
// owns the slot each tick and publishes it:
//   globalThis.gordBladeControl = { allow, finishAllowed, at }
//     allow         - false while the daemon is using the slot itself. We never
//                     start an action then (that would cancel its work).
//     finishAllowed - the final black op (Operation Daedalus) ends the BitNode,
//                     so it's only started when the FINISH toggle is on AND the
//                     node's plan names a next BitNode - the same two locks
//                     lib/finish-bn.js honours for w0r1d_d43m0n.
//   A missing or stale record (the daemon died) reads as allow=true,
//   finishAllowed=false: Bladeburner is the node's default work, and nothing
//   irreversible happens without a live daemon saying so.
//
// We publish globalThis.gordBladeState every tick: rank, stamina, whether we're
// RESTING (the daemon may lend the slot to faction work then - stamina recovers
// passively either way), what we're doing and why, and the next black op.

// Args: [0] the current BitNode (the daemon passes it; getResetInfo is 1GB), so
// the knobs are forNode(n).bladeburner and BITNODE[n]'s overrides apply here.

import { CONFIG, forNode } from "./config.js";
import { emitEvent } from "./events.js";
import {
  nextRestState, chooseAction, levelStep, blackOpDecision, blackOpBar, fallbackAction, restAction, conservePopulation, gateRaid,
} from "./bladeburner-logic.js";

let B = CONFIG.bladeburner;
// The sleeves' Bladeburner knobs (levelDownBelow): a contract a sleeve runs is
// levelled by that sleeve's chance - see gatherCandidates.
let SB = CONFIG.sleeves.blade;

// ns.enums.BladeburnerActionType values; string literals so checkJs is happy
// casting through any - see [[bitburner-enum-string-casts]].
const T = {
  general: "General",
  contract: "Contracts",
  op: "Operations",
  blackOp: "Black Operations",
};

// Module state. It persists across this process's ticks - and BEYOND the
// process: the game caches a compiled module by its source text
// (NetscriptJSEvaluator's moduleCache), so every later run of this file, on any
// server, after an install or in the next BitNode, gets these same variables
// back as the last run left them. main() therefore resets them.
let resting = false;
let lastBlackOp = /** @type {string | null} */ (null);
let heldAnnounced = false;
// Actions we've switched to manual levelling this process (autolevel off).
const manualLevel = new Set();

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  B = forNode(Number(ns.args[0] ?? 0)).bladeburner;
  SB = forNode(Number(ns.args[0] ?? 0)).sleeves.blade;
  // A new BitNode is a new division whose contracts and operations start with
  // autolevel ON again. With last node's set still full, autolevel was never
  // switched off there, and the game put every action back on its max level
  // after each attempt - under the level control below.
  resting = false;
  lastBlackOp = null;
  heldAnnounced = false;
  manualLevel.clear();
  while (true) {
    try {
      tick(ns);
    } catch (e) {
      // The API throws for anything unavailable (no BN6/7 / SF6/7, or not yet a
      // member) - log it and keep polling rather than dying mid-node.
      ns.print(`tick error: ${String(e)}`);
    }
    await ns.sleep(B.tickMs);
  }
}

/** The daemon's slot decision, with the stale/missing default described above. */
function control() {
  const c = globalThis.gordBladeControl;
  if (!c || Date.now() - (c.at ?? 0) > B.controlStaleMs) {
    return { allow: true, finishAllowed: false, stale: true };
  }
  return { allow: c.allow !== false, finishAllowed: c.finishAllowed === true, stale: false };
}

/**
 * The current city's chaos and estimated population from lib/blade-upkeep.js
 * (which pays for the city getters), each null if its state isn't fresh - and
 * whether the division is there to survey it (Field Analysis wanted).
 */
function cityState() {
  const u = globalThis.gordBladeUpkeep;
  if (!u || Date.now() - (u.updatedAt ?? 0) > B.controlStaleMs) return { chaos: null, population: null, survey: null };
  const here = (u.cities ?? []).find(c => c.city === u.city);
  const survey = u.survey && u.survey.city === u.city ? u.survey.city : null;
  return { chaos: u.chaos ?? null, population: here?.population ?? null, survey };
}

/**
 * The sleeves' Bladeburner roster from lib/sleeves.js, or null when it isn't
 * fresh: which sleeve holds which contract, and which sleeves could take one.
 * @returns {{holders: Record<string, number>, free: number[]} | null}
 */
function sleeveRoster() {
  const s = globalThis.gordSleeveState;
  // `bladeActive`: part of the roster works for the division while the rest
  // grinds a gang's karma (lib/sleeves.js bootstrapSleeves).
  if (!s || !(s.mode === "blade" || s.bladeActive) || Date.now() - (s.updatedAt ?? 0) > B.controlStaleMs) return null;
  return { holders: s.bladeHolders ?? {}, free: s.bladeEligible ?? [] };
}

/** @param {NS} ns */
function tick(ns) {
  const bb = ns.bladeburner;
  if (!bb.inBladeburner()) {
    globalThis.gordBladeState = { joined: false, updatedAt: Date.now() };
    return;
  }

  const ctl = control();
  const rank = bb.getRank();
  const [stamina, maxStamina] = bb.getStamina();
  const hp = ns.getPlayer().hp;
  const hpFrac = hp?.max > 0 ? hp.current / hp.max : 1;
  resting = nextRestState(resting, { stamina, maxStamina, hpFrac }, B);

  const cur = bb.getCurrentAction();
  const current = cur && cur.type !== "Idle" ? { type: String(cur.type), name: String(cur.name) } : null;

  const roster = sleeveRoster();
  const candidates = gatherCandidates(ns, current, roster);
  const { chaos, population, survey } = cityState();

  // What the player may run: a contract a sleeve holds is the sleeve's (its
  // level follows the sleeve's chance, and the player taking it too would set
  // it by its own); the population-spending operations only above the floor;
  // Raid only in a calm city. The best of them by expected rank/ms prices a
  // black op's failure (blackOpBar) and steers the skill points (blade-upkeep).
  const usable = gateRaid(conservePopulation(candidates.filter(c => !c.sleeveHeld), population, B), chaos, B);
  const best = chooseAction(usable, { minChance: B.minChance, stickyMargin: 1, current: null }).pick;

  // ── Black ops ────────────────────────────────────────────────────────────
  const next = bb.getNextBlackOp();
  if (lastBlackOp && next?.name !== lastBlackOp) {
    ns.tprint(`Bladeburner: completed ${lastBlackOp}.`);
    emitEvent(`[blade] Completed black op ${lastBlackOp}`, "event");
  }
  lastBlackOp = next?.name ?? null;

  const [boChance, boChanceMax] = next && rank >= next.rank
    ? bb.getActionEstimatedSuccessChance(T.blackOp, next.name)
    : [0, 0];
  const boBar = next
    ? blackOpBar(next.name, best?.rate ?? 0, { minChance: B.blackOpMinChance, floor: B.blackOpFloor, lossHorizonMs: B.blackOpLossHorizonMs })
    : B.blackOpMinChance;
  const bo = blackOpDecision(next, {
    rank,
    chanceMin: boChance,
    chanceMax: boChanceMax,
    finishAllowed: ctl.finishAllowed,
    finalName: B.finalBlackOp,
  }, { minChance: boBar, analysisSpread: B.blackOpAnalysisSpread });

  if (bo.held && !heldAnnounced) {
    heldAnnounced = true;
    ns.tprint(`Bladeburner: ${B.finalBlackOp} is ready, but it ends the BitNode - held until FINISH is on and a next BitNode is planned (or run it yourself).`);
    emitEvent(`[!] ${B.finalBlackOp} ready - held (it ends the BitNode)`, "sys");
  }
  if (!bo.held) heldAnnounced = false;

  // ── What we'd do with the slot ───────────────────────────────────────────
  const recruitChance = resting ? bb.getActionEstimatedSuccessChance(T.general, "Recruitment")[0] : 0;
  const want = decide({ stamina, maxStamina, hpFrac, recruitChance, candidates, usable, current, chaos, survey, next, bo });

  let acting = false;
  if (ctl.allow) {
    acting = true;
    const same = current && current.type === want.type && current.name === want.name;
    if (!same) {
      const ok = bb.startAction(/** @type {any} */ (want.type), /** @type {any} */ (want.name));
      if (!ok) {
        acting = false;
        ns.print(`startAction failed: ${want.type} / ${want.name}`);
      } else if (want.type === T.blackOp) {
        ns.tprint(`Bladeburner: starting black op ${want.name} (${bo.reason}).`);
        emitEvent(`[blade] Starting black op ${want.name}`, "event");
      }
    }
  }

  publishState(ns, { ctl, rank, stamina, maxStamina, hpFrac, current, want, acting, candidates, best, next, boChance, boBar, bo, chaos });
}

/**
 * The action for the slot, in priority order: a rest action while resting
 * (restAction), the next black op when it clears its bar (or Field Analysis
 * when only a loose estimate keeps it under), calm a chaotic city, survey the
 * city (lib/blade-upkeep.js), the best contract/operation by expected rank per
 * second, else a fallback.
 * The black op goes ahead of the chaos check because black ops ignore the
 * city altogether (their chaos and population factors are both 1) - but not
 * ahead of the rest, since the stamina penalty does apply to them.
 */
function decide({ stamina, maxStamina, hpFrac, recruitChance, candidates, usable, current, chaos, survey, next, bo }) {
  const spread = Math.max(0, ...candidates.map(c => c.chanceMax - c.chanceMin));
  if (resting) {
    const r = restAction({ hpFrac, chaos, spread, recruitChance }, B);
    return { type: T.general, name: r.name, reason: `resting (stamina ${pct(stamina / maxStamina)}) - ${r.reason}` };
  }
  if (bo.go && next) {
    return { type: T.blackOp, name: next.name, reason: `black op - ${bo.reason}` };
  }
  if (bo.analyse) {
    return { type: T.general, name: "Field Analysis", reason: bo.reason };
  }
  if (chaos != null && chaos > B.chaosDiplomacy) {
    return { type: T.general, name: "Diplomacy", reason: `city chaos ${chaos.toFixed(0)}` };
  }
  if (survey) {
    return { type: T.general, name: "Field Analysis", reason: `surveying ${survey}'s population` };
  }

  // `usable` is filtered in tick(): no sleeve-held contract, the population
  // floor, Raid only in a calm city.
  const { pick } = chooseAction(usable, { minChance: B.minChance, stickyMargin: B.stickyMargin, current });
  if (pick) {
    return { type: pick.type, name: pick.name, reason: `${pct(pick.chanceMin)} at level ${pick.level}` };
  }

  const exhausted = candidates.length > 0 && candidates.every(c => c.count < 1);
  const fb = fallbackAction({ chaos, exhausted, spread }, B);
  return { type: T.general, name: fb.name, reason: fb.reason };
}

/**
 * Read every contract/operation we consider, stepping each one's level toward
 * the success band first (so the numbers we rank on are the post-step ones).
 *
 * The RUNNING action is stepped like any other. It used to be stepped only
 * down, on the theory that a higher level is a worse chance for the attempt
 * already paid for - but an attempt is paid for in TIME, fixed when it starts
 * (startAction), while its success roll and its reward are both taken at
 * completion from the level as it stands then (completeAction). A step up
 * mid-attempt is the higher level's rank for the lower level's time, at a
 * chance levelStep has just checked against raiseChance. And the game restarts
 * a finished contract by itself, so the running action is ALWAYS "current":
 * left out, the best action's level rose only while something else ran - a
 * rest phase (rare once the sleeves' chamber shifts cover the stamina), or a
 * rival action that had out-levelled it in the meantime and took the slot,
 * throwing away the attempt in flight each time the two swapped.
 *
 * Levels are shared: a sleeve on a contract runs it at the level set here. So
 * a contract the player isn't running is levelled by the SLEEVES' chance - the
 * holder's, else the best free sleeve's - in the band levelDownBelow ..
 * raiseChance. Levelled by the player's chance, every level a sleeve earned was
 * raised past its reach at once and it dropped back to infiltrating (a BN14
 * save: Retirement at level 37, no sleeve on it).
 * @param {NS} ns
 * @param {{type: string, name: string} | null} current - the player's running action
 * @param {{holders: Record<string, number>, free: number[]} | null} roster - lib/sleeves.js's
 */
function gatherCandidates(ns, current, roster) {
  const bb = ns.bladeburner;
  const out = [];
  const groups = [[T.contract, B.contracts], [T.op, B.operations]];
  const playerBand = { minChance: B.minChance, raiseChance: B.raiseChance };
  const sleeveBand = { minChance: SB.levelDownBelow, raiseChance: B.raiseChance };

  for (const [type, names] of groups) {
    for (const name of names) {
      const t = /** @type {any} */ (type);
      const n = /** @type {any} */ (name);
      const count = bb.getActionCountRemaining(t, n);

      if (!manualLevel.has(`${type}/${name}`)) {
        bb.setActionAutolevel(t, n, false);
        manualLevel.add(`${type}/${name}`);
      }

      let [chanceMin, chanceMax] = bb.getActionEstimatedSuccessChance(t, n);
      let level = bb.getActionCurrentLevel(t, n);
      const maxLevel = bb.getActionMaxLevel(t, n);

      // Whose chance sets the level: the player's, unless it's a contract the
      // player isn't on and the sleeve roster is up.
      const playerOn = current?.type === type && current?.name === name;
      const holder = type === T.contract && !playerOn ? roster?.holders[name] : undefined;
      const takers = holder !== undefined ? [holder]
        : type === T.contract && !playerOn && roster ? roster.free
        : [];
      const steer = takers.length
        ? Math.max(...takers.map(i => bb.getActionEstimatedSuccessChance(t, n, i)[0]))
        : chanceMin;

      // A chance of exactly 0 is an action that can't run here (Raid in a city
      // with no Synthoid community left), not one levelled too high: keep its
      // level for the next city.
      const step = chanceMax > 0
        ? levelStep({ level, maxLevel, chanceMin: steer }, takers.length ? sleeveBand : playerBand)
        : null;
      if (step !== null) {
        bb.setActionLevel(t, n, step);
        level = step;
        [chanceMin, chanceMax] = bb.getActionEstimatedSuccessChance(t, n);
      }

      out.push({
        type,
        name,
        count,
        chanceMin,
        chanceMax,
        level,
        maxLevel,
        sleeveHeld: holder !== undefined,
        rankGain: bb.getActionRankGain(t, n),
        timeMs: bb.getActionTime(t, n),
      });
    }
  }
  return out;
}

/** @param {NS} ns */
function publishState(ns, d) {
  const names = ns.bladeburner.getBlackOpNames();
  const done = d.next ? Math.max(0, names.indexOf(d.next.name)) : names.length;

  globalThis.gordBladeState = {
    joined: true,
    rank: d.rank,
    stamina: d.stamina,
    maxStamina: d.maxStamina,
    hpFrac: d.hpFrac,
    resting,
    // Does the action loop have the slot this tick (vs the daemon lending it out)?
    allowed: d.ctl.allow,
    controlStale: d.ctl.stale,
    acting: d.acting,
    action: d.acting ? { type: d.want.type, name: d.want.name } : d.current,
    want: d.want,
    chaos: d.chaos,
    blackOps: { done, total: names.length },
    // `bar` is the chance this op is attempted at (blackOpBar) - the sleeves'
    // support decision and the upkeep's chance-bound skill choice use it too.
    nextBlackOp: d.next ? { name: d.next.name, rank: d.next.rank, chance: d.boChance, bar: d.boBar } : null,
    blackOpReason: d.bo.reason,
    // The contract/operation the division earns its rank on (best expected
    // rank/ms among those the player may run) - lib/blade-upkeep.js buys skill
    // levels by what they add to it.
    best: d.best
      ? { type: d.best.type, name: d.best.name, level: d.best.level, maxLevel: d.best.maxLevel, chanceMin: d.best.chanceMin, rate: d.best.rate }
      : null,
    finalHeld: !!d.bo.held,
    allBlackOpsDone: !!d.bo.done,
    // Attempts remaining per contract, for the sleeve manager's Bladeburner mode
    // (lib/sleeves.js reads these instead of paying 4GB for the getter itself).
    contractCounts: Object.fromEntries(d.candidates.filter(c => c.type === T.contract).map(c => [c.name, c.count])),
    // ...and per contract AND operation, so it can tell whether attempts are
    // short enough to be worth infiltrating for (needInfiltration).
    actionCounts: Object.fromEntries(d.candidates.map(c => [c.name, c.count])),
    // Top few candidates for the HUD, best expected rank/s first.
    candidates: d.candidates
      .map(c => ({ name: c.name, type: c.type, level: c.level, count: c.count, chance: c.chanceMin, rankPerMin: c.timeMs > 0 ? (c.chanceMin * c.rankGain * 60_000) / c.timeMs : 0 }))
      .sort((a, b) => b.rankPerMin - a.rankPerMin)
      .slice(0, 6),
    bonusMs: ns.bladeburner.getBonusTime(),
    updatedAt: Date.now(),
  };
}

function pct(x) {
  return `${Math.round((x ?? 0) * 100)}%`;
}
