// lib/gang.js
//
// Standalone gang manager - BN-agnostic (works for combat and hacking gangs,
// so it's reusable in any bitnode where we have gang access, not just BN2).
//
// The daemon scp's this file (plus the rest of the source tree) to whatever
// server has enough free RAM and exec's it there, since the gang API is too
// RAM-heavy (~35GB) to share a fresh 8GB home with the daemon. Its only import
// is lib/config.js, which has no Netscript calls and so costs nothing.
//
// Tuning knobs live in CONFIG.gang. The gain-formula replicas (lib/gang-logic.js)
// deliberately do NOT - they transcribe the game's own
// src/Gang/formulas/formulas.ts and aren't knobs to turn.
//
// Publishes globalThis.gordGangState every tick for ui/dashboard.js, and records
// discrete milestones (recruits, ascensions, member augs, warfare toggles) to the
// JOURNAL via lib/events.js. Deliberately only the low-frequency events: per-tick
// task reassignment and ordinary equipment buys would drown the log, and the
// dashboard's GANG card already shows that state continuously.

import { CONFIG } from "./config.js";
import { emitEvent } from "./events.js";
import {
  chooseAscension, chooseTrainers, nextTerritoryClock, territoryTickSeen,
  moneyGain, respectGain, wantedGain, inferSoftcap,
} from "./gang-logic.js";

const G = CONFIG.gang;

// Warfare is a toggle, so the journal only wants the EDGES. Module-level: this
// script is a long-lived process, and starting at null means the first tick
// reports the state it found rather than staying silent about it.
let lastEngaged = null;
let territoryDoneLogged = false;
// The territory tick, followed from outside (lib/gang-logic.js nextTerritoryClock):
// the other gangs' power as of the last update, and the clock built from it.
let rivalPower = /** @type {Record<string, number> | null} */ (null);
let clock = { progressMs: 0, synced: false, waitUpdates: 0, preTick: false };
// The BitNode's GangSoftcap, measured off the roster's own reported gains
// (lib/gang-logic.js inferSoftcap); 1 until a member is earning.
let softcap = 1;

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  // Module variables outlive the process: the game caches a compiled module by
  // its source text, so a restart - or the next BitNode's gang - is handed the
  // last run's values. Start every run from a clean slate.
  lastEngaged = null;
  territoryDoneLogged = false;
  rivalPower = null;
  clock = { progressMs: 0, synced: false, waitUpdates: 0, preTick: false };
  softcap = 1;

  if (!ns.gang.inGang()) {
    ns.tprint("gang.js: not in a gang yet - exiting.");
    return;
  }

  // Task/equipment definitions are static - cache them once.
  const taskStats = {};
  for (const t of ns.gang.getTaskNames()) taskStats[t] = ns.gang.getTaskStats(t);

  const equipment = ns.gang.getEquipmentNames().map(name => ({
    name,
    isAug: ns.gang.getEquipmentType(name) === "Augmentation",
  }));

  // One pass per GANG update (ns.gang.nextUpdate, 0GB) rather than per wall-clock
  // interval: the territory clock counts the gang time each update processed, and
  // a task switch only matters at an update anyway.
  let durationMs = G.tickMs;
  while (true) {
    tick(ns, taskStats, equipment, durationMs);
    durationMs = await ns.gang.nextUpdate();
  }
}

/** @param {NS} ns */
function tick(ns, taskStats, equipment, durationMs) {
  const g = ns.gang;
  let gang = g.getGangInformation();

  recruit(ns);

  // An ascension takes the member's earned respect out of the gang's (and with
  // it moves the wanted penalty), so the snapshot is re-read after one.
  if (maybeAscend(ns, gang, g.getMemberNames().map(n => g.getMemberInformation(n)))) {
    gang = g.getGangInformation();
  }

  // Fetch member info after ascensions so stats/upgrades are current.
  const members = g.getMemberNames().map(n => g.getMemberInformation(n));

  // Any earning member's reported gain gives the node's softcap exactly.
  for (const m of members) {
    const cap = inferSoftcap(gang, m, taskStats[m.task]);
    if (cap !== null) { softcap = cap; break; }
  }

  // Equipment prices don't depend on the member, and the cash cap is one number
  // per tick: read both once here instead of per member x per item (which was
  // ~360 getPlayer/getEquipmentCost calls every 2s on a full roster).
  // Cash ABOVE the daemon's money floor (it hoards for money-gated invites, and
  // gear bought through the hoard cancels the invite it is waiting on), and a
  // budget for the whole tick: the per-item caps alone let a dozen freshly
  // ascended members re-buy ~30 items each in one pass - well over half the
  // treasury at once.
  const spendable = Math.max(0, ns.getPlayer().money - (globalThis.gordMoneyFloor ?? 0));
  const shop = {
    money: spendable,
    budget: spendable * G.equipTickFraction,
    cost: new Map(equipment.map(e => [e.name, g.getEquipmentCost(e.name)])),
  };
  for (const m of members) buyEquipment(ns, m, equipment, shop);

  const territory = manageTerritory(ns, gang, members.length, durationMs);
  const plan = assignTasks(ns, gang, members, taskStats, territory);

  publishState(gang, members, territory, plan);
}

/** @param {NS} ns */
function recruit(ns) {
  const taken = new Set(ns.gang.getMemberNames());
  let i = 0;
  while (ns.gang.canRecruitMember()) {
    while (taken.has(`${G.memberPrefix}-${i}`)) i++;
    const name = `${G.memberPrefix}-${i}`;
    if (!ns.gang.recruitMember(name)) break;
    taken.add(name);
    emitEvent(`[gang] Recruited ${name} (${taken.size}/${G.maxMembers})`, "gang");
  }
}

/**
 * Ascend at most one member per update: the one furthest past its own threshold,
 * which falls as its multiplier grows (lib/gang-logic.js chooseAscension).
 * @param {NS} ns @param {any} gang @param {any[]} members
 * @returns {boolean} whether a member was ascended
 */
function maybeAscend(ns, gang, members) {
  const candidates = [];
  for (const m of members) {
    const res = ns.gang.getAscensionResult(m.name);
    if (!res) continue;
    candidates.push({
      name: m.name,
      ascMult: ascMult(gang, m),
      gain: gang.isHacking ? res.hack : (res.str + res.def + res.dex + res.agi) / 4,
      respect: res.respect,
    });
  }

  const pick = chooseAscension(candidates, {
    table: /** @type {[number, number][]} */ (G.ascendThresholds),
    rosterFull: members.length >= G.maxMembers,
    gangRespect: gang.respect,
    respectFraction: G.ascendRespectFraction,
  });
  if (!pick) return false;

  if (!ns.gang.ascendMember(pick.name)) return false;
  ns.print(`Ascended ${pick.name} (avg gain x${pick.gain.toFixed(2)}, bar x${pick.threshold.toFixed(2)})`);
  emitEvent(`[gang] Ascended ${pick.name} (stat multiplier x${pick.gain.toFixed(2)})`, "gang");
  return true;
}

/**
 * @param {NS} ns
 * @param {{money: number, budget: number, cost: Map<string, number>}} shop  this
 *   tick's spendable cash, its total equipment budget and per-item prices (shared
 *   across members; money and budget are decremented as we buy)
 */
function buyEquipment(ns, member, equipment, shop) {
  const owned = new Set([...member.upgrades, ...member.augmentations]);
  for (const eq of equipment) {
    if (owned.has(eq.name)) continue;
    const cost = shop.cost.get(eq.name) ?? Infinity;
    const cap = shop.money * (eq.isAug ? G.augFraction : G.equipFraction);
    if (cost > cap || cost > shop.budget) continue;
    if (!ns.gang.purchaseEquipment(member.name, eq.name)) continue;
    shop.money -= cost;
    shop.budget -= cost;
    // Augmentations only. Ordinary weapons/armour/vehicles run to dozens of buys
    // per member and would bury everything else in the journal; member augs are
    // the expensive, permanent ones worth a line.
    if (eq.isAug) {
      emitEvent(`[gang] ${member.name} aug: ${eq.name} ($${ns.format.number(cost)})`, "gang",
        { augs: [eq.name] });
    }
  }
}

/** @param {NS} ns */
function manageTerritory(ns, gang, memberCount, durationMs) {
  // getAllGangInformation returns { [faction]: { power, territory } } for every
  // gang including our own, so filter our faction out to get the rivals.
  const all = ns.gang.getAllGangInformation();
  const rivals = Object.entries(all).filter(
    ([name, info]) => name !== gang.faction && info.territory > 0
  );

  // Follow the territory tick. Power is credited only AT the tick, from members
  // on "Territory Warfare" at that instant, so the whole roster goes there for
  // the one update that contains it (preTick) and earns for the other nine.
  const power = Object.fromEntries(Object.entries(all).filter(([name]) => name !== gang.faction).map(([name, info]) => [name, info.power]));
  clock = nextTerritoryClock(clock, { durationMs, tickSeen: territoryTickSeen(rivalPower, power) });
  rivalPower = power;

  const fighting = gang.territory < G.territoryDone && rivals.length > 0;
  let warfareCount = 0;
  if (fighting && clock.synced) {
    warfareCount = clock.preTick ? memberCount : 0;
  } else if (fighting && memberCount >= G.maxMembers) {
    // Not in step with the tick yet (the first cycle after a start, or bonus
    // time just changed the cadence): the old standing crew, so power keeps
    // growing meanwhile.
    const maxRivalPower = Math.max(...rivals.map(([, info]) => info.power));
    warfareCount = gang.power < maxRivalPower * G.rivalPowerMult
      ? Math.floor(memberCount / 2)
      : G.tokenWarfareCount;
  }

  let minClash = 1;
  for (const [name] of rivals) {
    minClash = Math.min(minClash, ns.gang.getChanceToWinClash(name));
  }

  let engage = false;
  if (gang.territory < G.territoryDone && rivals.length > 0) {
    engage = gang.territoryWarfareEngaged
      ? minClash >= G.warfareDisengage
      : minClash >= G.warfareEngage;
  }
  if (engage !== gang.territoryWarfareEngaged) ns.gang.setTerritoryWarfare(engage);

  // Journal the EDGES only - this is evaluated every tick, and the win chance
  // drifts constantly. The clash odds are the reason for the flip, so carry them.
  if (engage !== lastEngaged) {
    const odds = `${(minClash * 100).toFixed(0)}%`;
    emitEvent(engage
      ? `[gang] Territory warfare ON (clash win chance ${odds})`
      : `[gang] Territory warfare OFF (clash win chance ${odds})`, "gang");
    lastEngaged = engage;
  }
  if (!territoryDoneLogged && gang.territory >= G.territoryDone) {
    territoryDoneLogged = true;
    emitEvent(`[gang] Territory at ${(gang.territory * 100).toFixed(0)}% - warfare done`, "gang");
  }

  return { warfareCount, minClash: rivals.length ? minClash : 1, engaged: engage, tickSynced: clock.synced, preTick: clock.preTick };
}

/** @param {NS} ns */
function assignTasks(ns, gang, members, taskStats, territory) {
  const trainTask = gang.isHacking ? "Train Hacking" : "Train Combat";
  // Lowers the wanted level; a hacking gang's own version uses the stat its
  // members actually have (Vigilante Justice is 80% combat-weighted).
  const calmTask = gang.isHacking ? "Ethical Hacking" : "Vigilante Justice";

  // Respect phase until the roster is full (respect drives recruits AND gang
  // faction rep); money phase afterwards - money tasks still earn respect.
  const wantMoney = members.length >= G.maxMembers;

  // Wanted-level feedback loop: the worse the penalty, the more members go
  // on Vigilante Justice this tick. Self-corrects within a few ticks.
  let vigilantes = 0;
  if (gang.wantedLevel > G.wantedLevelFloor) {
    if (gang.wantedPenalty < G.wantedPenaltyBad) vigilantes = Math.ceil(members.length / 2);
    else if (gang.wantedPenalty < G.wantedPenaltyMild) vigilantes = Math.ceil(members.length / 4);
  }

  const sorted = [...members].sort((a, b) => statAvg(gang, b) - statAvg(gang, a));
  const plan = new Map();

  // Strongest members hold territory; skip fragile ones while clashes are live.
  for (const m of sorted) {
    if (plan.size >= territory.warfareCount) break;
    if (statAvg(gang, m) < G.warfareMinStat) break;
    if (territory.engaged && m.def < G.warfareMinDef) continue;
    plan.set(m.name, "Territory Warfare");
  }

  // Weakest earners take vigilante duty - they'd contribute the least anyway.
  const rest = sorted.filter(m => !plan.has(m.name));
  for (let i = rest.length - 1; i >= 0 && vigilantes > 0; i--, vigilantes--) {
    plan.set(rest[i].name, calmTask);
  }

  const trainers = chooseTrainers(
    members.map(m => ({ name: m.name, stat: statAvg(gang, m), ascMult: ascMult(gang, m) })),
    {
      trainMinStat: G.trainMinStat,
      trainUntilAscMult: G.trainUntilAscMult,
      maxTrainFraction: G.maxTrainFraction,
      rosterFull: members.length >= G.maxMembers,
    },
  );

  for (const m of rest) {
    if (plan.has(m.name)) continue;
    if (trainers.has(m.name)) {
      plan.set(m.name, trainTask);
      continue;
    }
    plan.set(m.name, bestTask(gang, m, taskStats, wantMoney) ?? trainTask);
  }

  for (const m of members) {
    const task = plan.get(m.name);
    if (task && m.task !== task) ns.gang.setMemberTask(m.name, task);
  }

  return plan;
}

/**
 * Pick the highest-yield task for a member, using replicas of the game's own
 * gain formulas (lib/gang-logic.js) so we don't need Formulas.exe.
 * Tasks whose wanted gain outpaces their respect gain are skipped - the
 * vigilante feedback loop can't keep up with those.
 */
function bestTask(gang, member, taskStats, wantMoney) {
  let best = null;
  let bestScore = 0;

  for (const task of Object.values(taskStats)) {
    if (gang.isHacking ? !task.isHacking : !task.isCombat) continue;
    if (task.baseWanted < 0) continue; // vigilante is assigned separately

    const score = wantMoney ? moneyGain(gang, member, task, softcap) : respectGain(gang, member, task, softcap);
    if (score <= 0) continue;

    const wanted = wantedGain(gang, member, task);
    if (wanted > 0 && wanted > respectGain(gang, member, task, softcap)) continue;

    if (score > bestScore) {
      bestScore = score;
      best = task.name;
    }
  }

  return best;
}

// ── Member stats ─────────────────────────────────────────────────────────────
// (The game's gain formulas - money, respect, wanted - are in lib/gang-logic.js.)

/** The member's ascension multiplier in the stat its gang runs on. */
function ascMult(gang, m) {
  return gang.isHacking
    ? m.hack_asc_mult ?? 1
    : ((m.str_asc_mult ?? 1) + (m.def_asc_mult ?? 1) + (m.dex_asc_mult ?? 1) + (m.agi_asc_mult ?? 1)) / 4;
}

function statAvg(gang, m) {
  return gang.isHacking ? m.hack : (m.str + m.def + m.dex + m.agi) / 4;
}

// ── Dashboard state ──────────────────────────────────────────────────────────

function publishState(gang, members, territory, plan) {
  const taskCounts = {};
  for (const task of plan.values()) taskCounts[task] = (taskCounts[task] ?? 0) + 1;

  globalThis.gordGangState = {
    faction: gang.faction,
    isHacking: gang.isHacking,
    members: members.length,
    maxMembers: G.maxMembers,
    respect: gang.respect,
    // gain rates are per game cycle (200ms) -> convert to per second
    respectRate: gang.respectGainRate * 5,
    moneyRate: gang.moneyGainRate * 5,
    wantedLevel: gang.wantedLevel,
    wantedPenalty: gang.wantedPenalty,
    territory: gang.territory,
    power: gang.power,
    warfare: territory.engaged,
    // Whether the manager is in step with the territory tick (members then go
    // on Territory Warfare only for the update that contains it).
    tickSynced: territory.tickSynced,
    minClash: territory.minClash,
    nextRecruitRespect: gang.respectForNextRecruit,
    taskCounts,
    updatedAt: Date.now(),
  };
}
