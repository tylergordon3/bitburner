// lib/hacknet.js
//
// The hacknet SERVER manager (BitNode 9 / SF9), run off-home like the other
// helpers. Where lib/econ.js buys a handful of cheap hacknet NODES early on and
// then loses interest, this is the whole economy of a node where hacking earns
// ~0.1% of normal: the fleet's HASHES sell for money, buy the study/gym
// multipliers that get hacking level to the world daemon's gate, and rebuild a
// target's money and security so the botnet can farm it.
//
// Every decision is the pure lib/hacknet-logic.js (unit-tested); this file is
// the Netscript I/O shell around it:
//
//   FLEET   - each tick, spend up to spendFraction of spendable cash on the
//             best marginal-hashes-per-dollar step (new server / level / RAM /
//             core) that pays back within the horizon; buy CACHE when a hash
//             investment we want is too dear for the capacity we have.
//   HASHES  - sell everything not earmarked; take the investments the daemon's
//             hints make relevant (study while studying, boosts on the botnet's
//             primary target, a coding contract now and then), saving toward
//             the best one when the cache can hold it.
//
// Coordination with the daemon is through globalThis, never imports (importing
// the daemon would pull its Singularity calls into this script's RAM):
//   gordHashHints        - published by bn9/daemon.js each tick:
//                          { cashPriority, studying, training, target, savingMoney }.
//                          Absent (the cold boot, before the daemon runs) => cash
//                          priority: sell every hash, grow the fleet.
//   gordHackState.target - the batcher's primary target, boosted when no hint names one.
//   gordHashDumpRequested / gordHashDumpDone - the pre-install handshake: an aug
//                          install wipes every hash, so the daemon asks for a
//                          sell-off and installs once `done` answers `requested`.
//   gordHacknetState     - published here for the HUD (ui/bn9.js) and the status line.
//
// Args: [0] node number (forNode() config; the daemon pays getResetInfo, this
// doesn't), [1] 1 if hacknet servers are available this run, else 0 (self-exit).

import { forNode } from "./config.js";
import { emitEvent } from "./events.js";
import { spendableMoney } from "./ns-utils.js";
import { hasFormulas } from "./formulas.js";
import {
  HACKNET_SERVER,
  hashGainRate,
  rankUpgrades,
  pickUpgrade,
  planHashSpend,
  activityHints,
} from "./hacknet-logic.js";

const SELL = "Sell for Money";
// What one "Sell for Money" pays (the game's HashUpgrades value); its hash cost
// is read live, so $/hash follows any future change to the price side.
const SELL_VALUE = 1e6;
const UPG = {
  study: "Improve Studying",
  gym: "Improve Gym Training",
  minSec: "Reduce Minimum Security",
  maxMoney: "Increase Maximum Money",
  contract: "Generate Coding Contract",
  corp: "Sell for Corporation Funds",
};
const JOURNAL_FLUSH_MS = 60_000;

/** @param {NS} ns @param {string} name */
function cost(ns, name) {
  return ns.hacknet.hashCost(/** @type {any} */ (name));
}

/** @param {NS} ns @param {string} name */
function level(ns, name) {
  return ns.hacknet.getHashUpgradeLevel(/** @type {any} */ (name));
}

/** @param {NS} ns @param {number} i */
function readServer(ns, i) {
  const st = ns.hacknet.getNodeStats(i);
  return {
    index: i,
    name: st.name,
    level: st.level,
    ram: st.ram,
    cores: st.cores,
    cache: st.cache ?? 0,
    ramUsed: st.ramUsed ?? 0,
    production: st.production,
  };
}

/** @param {NS} ns @param {number} i */
function readCosts(ns, i) {
  const hn = ns.hacknet;
  return { level: hn.getLevelUpgradeCost(i, 1), ram: hn.getRamUpgradeCost(i, 1), cores: hn.getCoreUpgradeCost(i, 1) };
}

/**
 * The hash investments worth buying this tick, from the daemon's hints and the
 * node's state. Priority 1 = the study/gym multipliers (hacking level is the
 * node's gate), 2 = the target boosts, 3 = contracts, 4 = corp funds (opt-in).
 * @param {NS} ns @param {any} S CONFIG.hacknet.spend @param {any} hints
 * @param {number[]} contractTimes @param {number} now
 */
function collectInvestments(ns, S, hints, contractTimes, now) {
  /** @type {import("./hacknet-logic.js").Investment[]} */
  const out = [];
  const act = activityHints(globalThis.gordState?.action);
  const studying = hints.studying ?? act.studying;
  const training = hints.training ?? act.training;

  if (studying && level(ns, UPG.study) < S.studyMaxLevel) {
    out.push({ name: UPG.study, cost: cost(ns, UPG.study), priority: 1 });
  }
  if (training && level(ns, UPG.gym) < S.gymMaxLevel) {
    out.push({ name: UPG.gym, cost: cost(ns, UPG.gym), priority: 1 });
  }

  const target = hints.target ?? globalThis.gordHackState?.target ?? null;
  const boost = { target: null, minSecurity: 0, maxMoney: 0 };
  if (typeof target === "string" && target !== "-" && ns.serverExists(target)) {
    boost.target = target;
    boost.minSecurity = ns.getServerMinSecurityLevel(target);
    boost.maxMoney = ns.getServerMaxMoney(target);
    if (boost.minSecurity > S.boostMinSecurity) {
      out.push({ name: UPG.minSec, target, cost: cost(ns, UPG.minSec), priority: 2 });
    }
    if (boost.maxMoney > 0 && boost.maxMoney < S.boostMaxMoney) {
      out.push({ name: UPG.maxMoney, target, cost: cost(ns, UPG.maxMoney), priority: 2 });
    }
  }

  // Contracts: rate-limited (lib/contracts.js solves them; a flood is pointless)
  // and only while the price is sane - it climbs per contract generated.
  while (contractTimes.length && now - contractTimes[0] > 3_600_000) contractTimes.shift();
  if (contractTimes.length < S.contractsPerHour) {
    const c = cost(ns, UPG.contract);
    if (c <= S.contractMaxCost) out.push({ name: UPG.contract, cost: c, priority: 3 });
  }

  if (S.corpFunds && hints.corp) {
    out.push({ name: UPG.corp, cost: cost(ns, UPG.corp), priority: 4 });
  }

  return { investments: out, boost };
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const node = Number(ns.args[0] ?? 0);
  const available = Number(ns.args[1] ?? 1) !== 0;
  const H = forNode(node).hacknet;
  if (!H.enabled || !available) {
    ns.print(`hacknet servers ${available ? "not enabled for this node" : "unavailable this run"} - exiting.`);
    return;
  }
  const S = H.spend;
  const limits = { ...HACKNET_SERVER, maxServers: Math.min(HACKNET_SERVER.maxServers, H.maxServers) };
  const hn = ns.hacknet;

  /** @type {number[]} */
  const contractTimes = [];
  // Journal throttle: purchases happen every few seconds, so they're summarised
  // once a minute instead of one event each (the journal keeps 100 lines).
  let pending = { buys: /** @type {Record<string, number>} */ ({}), hash: /** @type {Record<string, number>} */ ({}), spent: 0, since: Date.now() };

  while (true) {
    try {
      const now = Date.now();
      const hints = globalThis.gordHashHints ?? { cashPriority: true };

      // ── Snapshot ──────────────────────────────────────────────────────────
      const n = hn.numNodes();
      const servers = [];
      const costs = [];
      let production = 0;
      for (let i = 0; i < n; i++) {
        const s = readServer(ns, i);
        servers.push(s);
        costs.push(readCosts(ns, i));
        production += s.production;
      }
      const hashes = hn.numHashes();
      const capacity = hn.hashCapacity();
      const sellCost = cost(ns, SELL);
      const dollarsPerHash = sellCost > 0 ? SELL_VALUE / sellCost : 0;

      // ── Hashes ────────────────────────────────────────────────────────────
      const dumpRequested = globalThis.gordHashDumpRequested ?? 0;
      const dumping = dumpRequested > (globalThis.gordHashDumpDone ?? 0);
      const cashPriority = dumping || hints.cashPriority === true;

      const { investments, boost } = cashPriority
        ? { investments: [], boost: { target: null, minSecurity: 0, maxMoney: 0 } }
        : collectInvestments(ns, S, hints, contractTimes, now);

      const plan = planHashSpend({
        hashes, capacity, sellCost, investments, cashPriority,
        investMaxCapacityFraction: S.investMaxCapacityFraction,
        sellAboveCapacityFraction: S.sellAboveCapacityFraction,
      });
      for (const a of plan.actions) {
        const name = /** @type {any} */ (a.name);
        const ok = a.name === SELL
          ? hn.spendHashes(name, "", a.count)
          : a.target ? hn.spendHashes(name, a.target) : hn.spendHashes(name);
        if (!ok) { ns.print(`spendHashes(${a.name}${a.target ? `, ${a.target}` : ""}) refused`); continue; }
        if (a.name === UPG.contract) contractTimes.push(now);
        if (a.name !== SELL) {
          const key = a.target ? `${a.name} (${a.target})` : a.name;
          pending.hash[key] = (pending.hash[key] ?? 0) + a.count;
        }
      }
      if (dumping) globalThis.gordHashDumpDone = Date.now();

      // ── Money ─────────────────────────────────────────────────────────────
      const budget = Math.max(0, spendableMoney(ns) - H.reserveMoney) * H.spendFraction;
      const paybackCap = (hints.savingMoney ?? 0) > 0 ? H.savingPaybackMs : H.maxPaybackMs;
      let spent = 0;
      let stopReason = "";

      // Cache first when a wanted investment can't fit the capacity we have:
      // the fleet's output is worthless if it can never be held long enough.
      if (plan.blocked) {
        let best = null;
        for (const s of servers) {
          if (s.cache >= limits.maxCache) continue;
          const c = hn.getCacheUpgradeCost(s.index, 1);
          if (c > 0 && isFinite(c) && (!best || c < best.cost)) best = { index: s.index, cost: c };
        }
        if (best && best.cost <= budget - spent && hn.upgradeCache(best.index, 1)) {
          spent += best.cost;
          pending.buys.cache = (pending.buys.cache ?? 0) + 1;
          servers[best.index] = readServer(ns, best.index);
        }
      }

      const mult = ns.getHacknetMultipliers().production;
      const rate = hasFormulas(ns)
        ? (l, u, r, c) => ns.formulas.hacknetServers.hashGainRate(l, u, r, c, mult)
        : (l, u, r, c) => hashGainRate(l, u, r, c, mult);

      for (let guard = 0; guard < 40; guard++) {
        const ranked = rankUpgrades({ servers, costs, purchaseCost: hn.getPurchaseNodeCost(), rate, limits });
        const { pick, reason } = pickUpgrade(ranked, { budget: budget - spent, dollarsPerHash, maxPaybackMs: paybackCap });
        if (!pick) { stopReason = reason; break; }

        let ok = false;
        if (pick.kind === "server") {
          const idx = hn.purchaseNode();
          ok = idx >= 0;
          if (ok) { servers.push(readServer(ns, idx)); costs.push(readCosts(ns, idx)); }
        } else {
          ok = pick.kind === "level" ? hn.upgradeLevel(pick.index, 1)
            : pick.kind === "ram" ? hn.upgradeRam(pick.index, 1)
            : hn.upgradeCore(pick.index, 1);
          if (ok) { servers[pick.index] = readServer(ns, pick.index); costs[pick.index] = readCosts(ns, pick.index); }
        }
        if (!ok) { stopReason = `${pick.kind} purchase refused`; break; }
        spent += pick.cost;
        pending.buys[pick.kind] = (pending.buys[pick.kind] ?? 0) + 1;
        if (pick.kind === "server") emitEvent(`[+] Hacknet server #${servers.length} bought`, "buy");
      }
      pending.spent += spent;

      // ── Journal ───────────────────────────────────────────────────────────
      if (now - pending.since >= JOURNAL_FLUSH_MS) {
        const buys = Object.entries(pending.buys).filter(([k]) => k !== "server").map(([k, v]) => `+${v} ${k}`);
        if (buys.length) emitEvent(`[+] Hacknet: ${buys.join(", ")} ($${ns.format.number(pending.spent)})`, "buy");
        const hash = Object.entries(pending.hash).map(([k, v]) => `${v}x ${k}`);
        if (hash.length) emitEvent(`[hash] ${hash.join(", ")}`, "buy");
        pending = { buys: {}, hash: {}, spent: 0, since: now };
      }

      // ── Publish ───────────────────────────────────────────────────────────
      globalThis.gordHacknetState = {
        servers: servers.length,
        maxServers: limits.maxServers,
        fleet: servers.map(s => ({ name: s.name, level: s.level, ram: s.ram, cores: s.cores, cache: s.cache, ramUsed: s.ramUsed })),
        hashes: hn.numHashes(),
        capacity: hn.hashCapacity(),
        ratePerSec: production,
        dollarsPerHash,
        incomePerSec: production * dollarsPerHash,
        levels: {
          study: level(ns, UPG.study),
          gym: level(ns, UPG.gym),
          minSec: level(ns, UPG.minSec),
          maxMoney: level(ns, UPG.maxMoney),
          contracts: level(ns, UPG.contract),
        },
        boost,
        saving: plan.saving ? `${plan.saving.name}${plan.saving.target ? ` (${plan.saving.target})` : ""} @ ${plan.saving.cost}` : null,
        blocked: plan.blocked ? `${plan.blocked.name} @ ${plan.blocked.cost}` : null,
        sold: plan.sellCount,
        cashPriority,
        dumping,
        budget,
        spent,
        stopReason,
        paybackCapMs: paybackCap,
        formulas: hasFormulas(ns),
        updatedAt: now,
      };

      ns.print(
        `hashes ${hn.numHashes().toFixed(1)}/${capacity} @ ${production.toFixed(3)}/s (~$${ns.format.number(production * dollarsPerHash)}/s) | ` +
        `fleet ${servers.length}/${limits.maxServers} | sold ${plan.sellCount} | ` +
        `${plan.saving ? `saving for ${plan.saving.name} ` : ""}${plan.blocked ? `blocked: ${plan.blocked.name} ` : ""}| ` +
        `spent $${ns.format.number(spent)} of $${ns.format.number(budget)}${stopReason ? ` (${stopReason})` : ""}`
      );
    } catch (e) {
      ns.print(`hacknet tick error: ${String(e)}`);
    }
    await ns.sleep(H.tickMs);
  }
}
