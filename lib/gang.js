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
// Tuning knobs live in CONFIG.gang. The gain-formula replicas at the bottom of
// this file deliberately do NOT - they transcribe the game's own
// src/Gang/formulas/formulas.ts and aren't knobs to turn.
//
// Publishes globalThis.gordGangState every tick for ui/dashboard.js.

import { CONFIG } from "./config.js";

const G = CONFIG.gang;

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

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

  while (true) {
    tick(ns, taskStats, equipment);
    await ns.sleep(G.tickMs);
  }
}

/** @param {NS} ns */
function tick(ns, taskStats, equipment) {
  const g = ns.gang;
  const gang = g.getGangInformation();

  recruit(ns);

  const names = g.getMemberNames();
  for (const name of names) maybeAscend(ns, gang, name, names.length);

  // Fetch member info after ascensions so stats/upgrades are current.
  const members = g.getMemberNames().map(n => g.getMemberInformation(n));

  for (const m of members) buyEquipment(ns, m, equipment);

  const territory = manageTerritory(ns, gang, members.length);
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
  }
}

/** @param {NS} ns */
function maybeAscend(ns, gang, name, memberCount) {
  const res = ns.gang.getAscensionResult(name);
  if (!res) return;

  const gain = gang.isHacking
    ? res.hack
    : (res.str + res.def + res.dex + res.agi) / 4;
  if (gain < G.ascendGain) return;

  // Ascending forfeits this member's earned respect. While we're still
  // recruiting, don't let one ascension tank the respect pool we need for
  // the next recruit.
  if (memberCount < G.maxMembers && res.respect > gang.respect * G.ascendRespectFraction) return;

  if (ns.gang.ascendMember(name)) {
    ns.print(`Ascended ${name} (avg gain x${gain.toFixed(2)})`);
  }
}

/** @param {NS} ns */
function buyEquipment(ns, member, equipment) {
  const owned = new Set([...member.upgrades, ...member.augmentations]);
  for (const eq of equipment) {
    if (owned.has(eq.name)) continue;
    const cost = ns.gang.getEquipmentCost(eq.name);
    const cap = ns.getPlayer().money * (eq.isAug ? G.augFraction : G.equipFraction);
    if (cost <= cap) ns.gang.purchaseEquipment(member.name, eq.name);
  }
}

/** @param {NS} ns */
function manageTerritory(ns, gang, memberCount) {
  // getAllGangInformation returns { [faction]: { power, territory } } for every
  // gang including our own, so filter our faction out to get the rivals.
  const all = ns.gang.getAllGangInformation();
  const rivals = Object.entries(all).filter(
    ([name, info]) => name !== gang.faction && info.territory > 0
  );

  // How many members to park on "Territory Warfare" (builds power, no income).
  // Push hard while rivals out-power us; once we clearly dominate, a token
  // crew keeps power growing while everyone else earns.
  let warfareCount = 0;
  if (memberCount >= G.maxMembers && gang.territory < G.territoryDone && rivals.length > 0) {
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

  return { warfareCount, minClash: rivals.length ? minClash : 1, engaged: engage };
}

/** @param {NS} ns */
function assignTasks(ns, gang, members, taskStats, territory) {
  const trainTask = gang.isHacking ? "Train Hacking" : "Train Combat";

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
    plan.set(rest[i].name, "Vigilante Justice");
  }

  for (const m of rest) {
    if (plan.has(m.name)) continue;
    if (statAvg(gang, m) < G.trainMinStat) {
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
 * gain formulas (src/Gang/formulas/formulas.ts) so we don't need Formulas.exe.
 * Tasks whose wanted gain outpaces their respect gain are skipped - the
 * vigilante feedback loop can't keep up with those.
 */
function bestTask(gang, member, taskStats, wantMoney) {
  let best = null;
  let bestScore = 0;

  for (const task of Object.values(taskStats)) {
    if (gang.isHacking ? !task.isHacking : !task.isCombat) continue;
    if (task.baseWanted < 0) continue; // vigilante is assigned separately

    const score = wantMoney ? moneyGain(gang, member, task) : respectGain(gang, member, task);
    if (score <= 0) continue;

    const wanted = wantedGain(gang, member, task);
    if (wanted > 0 && wanted > respectGain(gang, member, task)) continue;

    if (score > bestScore) {
      bestScore = score;
      best = task.name;
    }
  }

  return best;
}

// ── Game-formula replicas ────────────────────────────────────────────────────
//
// Transcribed from Bitburner's src/Gang/formulas/formulas.ts. The magic numbers
// below are the GAME's, not ours - they belong with the formulas rather than in
// lib/config.js, and should only change if the game's own formulas do.

function statAvg(gang, m) {
  return gang.isHacking ? m.hack : (m.str + m.def + m.dex + m.agi) / 4;
}

function wantedPenaltyMult(gang) {
  return gang.respect / (gang.respect + gang.wantedLevel);
}

function statWeight(task, m) {
  return (
    (task.hackWeight / 100) * m.hack +
    (task.strWeight / 100) * m.str +
    (task.defWeight / 100) * m.def +
    (task.dexWeight / 100) * m.dex +
    (task.agiWeight / 100) * m.agi +
    (task.chaWeight / 100) * m.cha
  );
}

function respectGain(gang, m, task) {
  if (task.baseRespect === 0) return 0;
  const sw = statWeight(task, m) - 4 * task.difficulty;
  if (sw <= 0) return 0;
  const terr = Math.max(0.005, Math.pow(gang.territory * 100, task.territory.respect) / 100);
  const softcap = 0.2 * gang.territory + 0.8;
  return Math.pow(11 * task.baseRespect * sw * terr * wantedPenaltyMult(gang), softcap);
}

function moneyGain(gang, m, task) {
  if (task.baseMoney === 0) return 0;
  const sw = statWeight(task, m) - 3.2 * task.difficulty;
  if (sw <= 0) return 0;
  const terr = Math.max(0.005, Math.pow(gang.territory * 100, task.territory.money) / 100);
  return 5 * task.baseMoney * sw * terr * wantedPenaltyMult(gang);
}

function wantedGain(gang, m, task) {
  if (task.baseWanted === 0) return 0;
  const sw = statWeight(task, m) - 3.5 * task.difficulty;
  if (sw <= 0) return 0;
  const terr = Math.max(0.005, Math.pow(gang.territory * 100, task.territory.wanted) / 100);
  if (task.baseWanted < 0) return 0.4 * task.baseWanted * sw * terr;
  return Math.min(100, Math.max((7 * task.baseWanted) / Math.pow(3 * sw * terr, 0.8), 8e-5));
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
    minClash: territory.minClash,
    nextRecruitRespect: gang.respectForNextRecruit,
    taskCounts,
    updatedAt: Date.now(),
  };
}
