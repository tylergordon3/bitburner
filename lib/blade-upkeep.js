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
// getters itself), the per-city picture, skill points and levels.

import { CONFIG } from "./config.js";
import { emitEvent } from "./events.js";
import { chooseSkill, chooseCity } from "./bladeburner-logic.js";

const B = CONFIG.bladeburner;
// Skill purchases arrive a point at a time; roll them up into one journal line
// at most this often instead of one per purchase.
const SKILL_JOURNAL_MS = 10 * 60 * 1_000;

let skillLog = /** @type {Record<string, number>} */ ({});
let skillLogAt = Date.now();

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
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
    updatedAt: Date.now(),
  };
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
 * lowest cost per unit of configured weight (lib/bladeburner-logic.js chooseSkill).
 * @param {NS} ns @returns {number} levels bought this pass
 */
function buySkills(ns) {
  const bb = ns.bladeburner;
  const names = Object.keys(B.skills);
  let bought = 0;

  for (let i = 0; i < B.maxSkillBuysPerTick; i++) {
    const points = bb.getSkillPoints();
    const skills = names.map(name => {
      const n = /** @type {any} */ (name);
      return { name, level: bb.getSkillLevel(n), cost: bb.getSkillUpgradeCost(n, 1) };
    });
    const pick = chooseSkill(skills, points, B.skills);
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
 * @param {NS} ns
 */
function manageCity(ns) {
  const bb = ns.bladeburner;
  const current = String(bb.getCity());
  const cities = B.cities.map(city => {
    const c = /** @type {any} */ (city);
    return { city, population: bb.getCityEstimatedPopulation(c), chaos: bb.getCityChaos(c) };
  });

  const want = chooseCity(cities, current, { switchMargin: B.citySwitchMargin, maxChaos: B.cityMaxChaos });
  let now = current;
  if (want !== current && bb.switchCity(/** @type {any} */ (want))) {
    now = want;
    ns.print(`Moved the division ${current} -> ${want}.`);
    emitEvent(`[blade] Division moved ${current} -> ${want}`, "travel");
  }

  return { current: now, chaos: cities.find(c => c.city === now)?.chaos ?? null, cities };
}
