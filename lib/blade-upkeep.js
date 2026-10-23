// lib/blade-upkeep.js
//
// The slow half of the Bladeburner automation: spend skill points, keep the
// division in the best city, and join the Bladeburners faction once rank allows.
// Off-home, optional, launched by bn6/daemon.js right after lib/bladeburner.js.
// Split from the action loop purely for RAM (every ns.bladeburner.* call is
// 4GB): none of this is urgent, so it can wait for a host while the action loop
// - which the player's work slot depends on - gets placed first.
//
// Publishes globalThis.gordBladeUpkeep: the current city and its chaos (which the
// action loop reads to decide on Diplomacy, instead of paying for the two city
// getters itself), the per-city picture, skill points and levels, and the city
// SURVEY in progress, if any (the action loop and the free sleeves Field-Analyse
// it - see lib/bladeburner-logic.js nextSurveyState).
//
// Args: [0] the current BitNode (the daemon passes it; getResetInfo is 1GB), so
// the knobs are forNode(n).bladeburner - BITNODE[7]'s skill weights live there.

import { CONFIG, forNode } from "./config.js";
import { emitEvent } from "./events.js";
import {
  chooseSkill, chooseSkillForBlackOp, chooseCity, spendableSkillPoints, chooseSurveyCity, nextSurveyState,
} from "./bladeburner-logic.js";

let B = CONFIG.bladeburner;
// Skill purchases arrive a point at a time; roll them up into one journal line
// at most this often instead of one per purchase.
const SKILL_JOURNAL_MS = 10 * 60 * 1_000;

// Module state - which the game's module cache hands to the next run of this
// file (a relaunch, the next BitNode) as this run left it, so main() resets it.
let skillLog = /** @type {Record<string, number>} */ ({});
let skillLogAt = Date.now();
// City surveys: when each city's was last finished, and the one in progress.
let surveyedAt = /** @type {Record<string, number>} */ ({});
let survey = /** @type {null | {city: string, since: number, pop: number, stillSince: number, analysedMs: number, at: number, from: number}} */ (null);

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  B = forNode(Number(ns.args[0] ?? 0)).bladeburner;
  skillLog = {};
  skillLogAt = Date.now();
  surveyedAt = {};
  survey = null;
  while (true) {
    try {
      tick(ns);
    } catch (e) {
      ns.print(`tick error: ${String(e)}`);
    }
    await ns.sleep(B.upkeepTickMs);
  }
}

/** @param {NS} ns */
function tick(ns) {
  const bb = ns.bladeburner;
  if (!bb.inBladeburner()) {
    globalThis.gordBladeUpkeep = { joined: false, updatedAt: Date.now() };
    return;
  }

  const factionJoined = maybeJoinFaction(ns);
  const bought = buySkills(ns);
  const city = manageCity(ns);
  const team = manageTeam(ns);

  const levels = {};
  for (const name of Object.keys(B.skills)) levels[name] = bb.getSkillLevel(/** @type {any} */ (name));

  globalThis.gordBladeUpkeep = {
    joined: true,
    factionJoined,
    city: city.current,
    chaos: city.chaos,
    cities: city.cities,
    skillPoints: bb.getSkillPoints(),
    levels,
    teamSize: team,
    boughtThisTick: bought,
    // The city being surveyed (the division is there): Field Analysis wanted.
    survey: survey ? { city: survey.city, since: survey.since } : null,
    updatedAt: Date.now(),
  };
}

/** lib/bladeburner.js's published state, or null when it isn't fresh. */
function freshBladeState() {
  const st = globalThis.gordBladeState;
  return st && Date.now() - (st.updatedAt ?? 0) <= B.controlStaleMs ? st : null;
}

/**
 * The Bladeburners faction isn't an ordinary invite - it's joined through the
 * division once rank reaches B.factionRank. Its augs are the node's best, and
 * its reputation comes from rank, so this is worth doing the moment we can.
 * @param {NS} ns @returns {boolean} whether we're a member
 */
function maybeJoinFaction(ns) {
  const factions = ns.getPlayer().factions ?? [];
  if (factions.includes(B.faction)) return true;
  if (ns.bladeburner.getRank() < B.factionRank) return false;
  if (!ns.bladeburner.joinBladeburnerFaction()) return false;
  ns.tprint(`Joined the ${B.faction} faction.`);
  emitEvent(`[join] Joined ${B.faction}`, "faction", { factions: [B.faction] });
  return true;
}

/**
 * Spend every skill point we can, one level at a time, on the skill with the
 * lowest cost per unit of configured weight (lib/bladeburner-logic.js chooseSkill)
 * - or, while a rank-ready black op is held back only by its success chance, on
 * the most chance per point for that op (chooseSkillForBlackOp).
 * @param {NS} ns @returns {number} levels bought this pass
 */
function buySkills(ns) {
  const bb = ns.bladeburner;
  const names = Object.keys(B.skills);
  let bought = 0;

  // Opt-in: bladeburner.skillPointBank keeps that many points unspent once the
  // black ops no longer need skills (the action loop says so) - see
  // spendableSkillPoints. Unset, every point is spent as before.
  const bank = /** @type {any} */ (B).skillPointBank;
  const st = freshBladeState();
  const settled = !!st && (st.finalHeld === true || st.allBlackOpsDone === true);
  const op = st?.nextBlackOp;
  const chanceBound = !!op && !st.finalHeld && st.rank >= op.rank && (op.chance ?? 0) < B.blackOpMinChance;

  for (let i = 0; i < B.maxSkillBuysPerTick; i++) {
    const points = spendableSkillPoints(bb.getSkillPoints(), bank, settled);
    const skills = names.map(name => {
      const n = /** @type {any} */ (name);
      return { name, level: bb.getSkillLevel(n), cost: bb.getSkillUpgradeCost(n, 1) };
    });
    // While chance-bound, points saved toward the next chance level are not
    // spent on anything else in the meantime.
    const pick = chanceBound
      ? chooseSkillForBlackOp(skills, points, B.skills, op.name)
      : chooseSkill(skills, points, B.skills);
    if (!pick) break;
    if (!bb.upgradeSkill(/** @type {any} */ (pick.name), 1)) break;
    bought++;
    skillLog[pick.name] = (skillLog[pick.name] ?? 0) + 1;
  }

  const now = Date.now();
  if (now - skillLogAt >= SKILL_JOURNAL_MS && Object.keys(skillLog).length) {
    const summary = Object.entries(skillLog).map(([k, v]) => `+${v} ${k}`).join(", ");
    emitEvent(`[blade] Skills: ${summary}`, "buy");
    skillLog = {};
    skillLogAt = now;
  }
  return bought;
}

/**
 * Send the whole team on the next black op: (team + 1)^0.05 success, which is
 * what nudges a borderline black op over its bar. Ordinary operations are left
 * solo - a successful one still loses up to half the team, and the team only
 * grows through Recruitment (the action loop's rest phases).
 * @param {NS} ns @returns {number} team size
 */
function manageTeam(ns) {
  const bb = ns.bladeburner;
  const team = bb.getTeamSize();
  const next = bb.getNextBlackOp();
  if (B.teamOnBlackOps && next && team > 0) {
    const type = /** @type {any} */ ("Black Operations");
    if (bb.getTeamSize(type, next.name) !== team) bb.setTeamSize(type, next.name, team);
  }
  return team;
}

/**
 * Operate from the most populous calm city (chooseCity). switchCity is free and
 * doesn't interrupt the running action.
 *
 * But the populations it compares are ESTIMATES, and only the current city's
 * ever improves - so every surveyIntervalMs each calm city is surveyed first:
 * the division moves there and Field Analysis (the action loop, the free
 * sleeves) runs until the estimate stops moving (lib/bladeburner-logic.js
 * nextSurveyState). Only with no survey due does chooseCity decide. Not
 * started while the action loop is down or on a black op - nobody would be
 * analysing.
 * @param {NS} ns
 */
function manageCity(ns) {
  const bb = ns.bladeburner;
  const current = String(bb.getCity());
  const cities = B.cities.map(city => {
    const c = /** @type {any} */ (city);
    return { city, population: bb.getCityEstimatedPopulation(c), chaos: bb.getCityChaos(c) };
  });
  const now = Date.now();
  const st = freshBladeState();

  if (survey) {
    const here = cities.find(c => c.city === survey?.city);
    const analysing = !!st?.acting && st.want?.type === "General" && st.want?.name === "Field Analysis";
    const step = nextSurveyState(survey, { now, population: here?.population ?? 0, analysing }, {
      tolerance: B.surveyTolerance, stableMs: B.surveyStableMs, maxAnalysisMs: B.surveyMaxAnalysisMs, maxMs: B.surveyMaxMs,
    });
    survey = step.state;
    if (step.done || !here || here.chaos > B.cityMaxChaos) {
      surveyedAt[survey.city] = now;
      const fmt = n => ns.format.number(n);
      ns.print(`Surveyed ${survey.city}: estimated population ${fmt(survey.from)} -> ${fmt(here?.population ?? 0)}.`);
      if (Math.abs((here?.population ?? 0) - survey.from) > survey.from * 0.1) {
        emitEvent(`[blade] Surveyed ${survey.city}: population estimate ${fmt(survey.from)} -> ${fmt(here?.population ?? 0)}`, "event");
      }
      survey = null;
    } else {
      return { current: moveTo(ns, current, survey.city, "survey"), chaos: here.chaos, cities };
    }
  } else if (st && st.want?.type !== "Black Operations") {
    const target = chooseSurveyCity(cities, surveyedAt, current, {
      now, intervalMs: B.surveyIntervalMs, maxChaos: B.cityMaxChaos,
    });
    const c = target ? cities.find(x => x.city === target) : null;
    if (c) {
      survey = { city: c.city, since: now, pop: c.population, stillSince: now, analysedMs: 0, at: now, from: c.population };
      return { current: moveTo(ns, current, c.city, "survey"), chaos: c.chaos, cities };
    }
  }

  const want = chooseCity(cities, current, { switchMargin: B.citySwitchMargin, maxChaos: B.cityMaxChaos });
  const at = moveTo(ns, current, want, "move");
  return { current: at, chaos: cities.find(c => c.city === at)?.chaos ?? null, cities };
}

/**
 * Switch the division to `want` if it isn't there. Returns where it is now.
 * @param {NS} ns @param {string} current @param {string} want @param {"survey" | "move"} why
 */
function moveTo(ns, current, want, why) {
  if (want === current) return current;
  if (!ns.bladeburner.switchCity(/** @type {any} */ (want))) return current;
  ns.print(`Moved the division ${current} -> ${want}${why === "survey" ? " (survey)" : ""}.`);
  // Survey hops come and go; only a real move is worth a journal line.
  if (why === "move") emitEvent(`[blade] Division moved ${current} -> ${want}`, "travel");
  return want;
}
