// lib/contracts.js
//
// Network-wide coding-contract solver, run OFF-home (like the other helpers) via
// ensureHelper. Coding contracts (.cct files) appear on random servers over time
// and pay money, faction/company reputation, or karma - free progression the
// hacking botnet never touches - and they exist in EVERY BitNode, so every daemon
// launches this. The heavy lifting is pure and lives in lib/contract-solvers.js
// (0-RAM, unit-tested); this file is just the ns.codingcontract I/O plus the
// network walk (lib/net.js). Publishes globalThis.gordContractState each tick.
//
// SAFETY: contracts have a limited number of attempts and self-destruct on
// failure, so we ONLY attempt types we have a solver for (solveContract reports
// unsupported types) and never guess. Each contract is wrapped in try/catch so one
// malformed payload can't take the loop down. Idea + solver set adapted from
// ame824/autoDoIt (special/manage-contracts.js).

import { CONFIG } from "./config.js";
import { allServers } from "./net.js";
import { solveContract, supportedContractTypes } from "./contract-solvers.js";
import { emitEvent } from "./events.js";

const C = CONFIG.contracts;

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  if (!C.enabled) {
    ns.tprint("contracts.js: disabled in config (CONFIG.contracts.enabled) - exiting.");
    return;
  }

  // Cumulative tallies across the whole run, surfaced on the dashboard.
  let solvedTotal = 0;
  let failedTotal = 0;
  const unsupportedSeen = new Set();
  let lastReward = "";

  while (true) {
    let found = 0;
    let solvedThisTick = 0;

    for (const host of allServers(ns)) {
      let files;
      try { files = ns.ls(host, ".cct"); }
      catch { continue; }

      for (const file of files) {
        found++;
        try {
          const type = String(ns.codingcontract.getContractType(file, host));
          const { supported, answer } = solveContract(type, ns.codingcontract.getData(file, host));

          if (!supported) {
            // Unknown/future type: leave it untouched (don't burn an attempt) and
            // remember it so the dashboard can show what we're skipping.
            unsupportedSeen.add(type);
            continue;
          }

          // ns.codingcontract.attempt wants primitives/arrays; the Square Root
          // solver returns a BigInt that can exceed Number range, so stringify it.
          const payload = typeof answer === "bigint" ? answer.toString() : answer;
          const reward = ns.codingcontract.attempt(/** @type {any} */ (payload), file, host);

          if (reward) {
            solvedTotal++;
            solvedThisTick++;
            // The game's reward string carries full-precision numbers (e.g. the
            // gained faction reputation); round any long decimal to 2 places.
            const rewardText = trimRewardDecimals(reward);
            lastReward = rewardText;
            ns.print(`Solved ${type} on ${host}: ${rewardText}`);
            // Reward strings can be long (faction lists); keep the journal line tidy.
            const shortReward = rewardText.length > 60 ? `${rewardText.slice(0, 57)}...` : rewardText;
            emitEvent(`[C] Solved, ${shortReward}`, "buy");
          } else {
            failedTotal++;
            ns.tprint(`WARN: contract failed - ${type} on ${host} (${file}). Solver may be wrong for this input.`);
          }
        } catch (e) {
          // Malformed contract / transient API error - skip it, try again next scan.
          ns.print(`contract error on ${host}/${file}: ${String(e)}`);
        }
      }
    }

    globalThis.gordContractState = {
      found,
      solvedTotal,
      failedTotal,
      solvedThisTick,
      unsupported: [...unsupportedSeen],
      supportedCount: supportedContractTypes().length,
      lastReward,
      updatedAt: Date.now(),
    };

    await ns.sleep(C.tickMs);
  }
}

/**
 * Round any long-decimal number inside a contract reward string to 2 places, so
 * "Gained 12345.678901 reputation for CyberSec" reads "Gained 12,345.68 reputation
 * for CyberSec". Only touches numbers with 3+ decimal digits, so suffixed figures
 * ($1.5m, 0.55) and integers are left alone. Commas are re-added for readability.
 * @param {string} text
 */
function trimRewardDecimals(text) {
  return String(text).replace(/\d[\d,]*\.\d{3,}/g, (match) => {
    const n = Number(match.replace(/,/g, ""));
    return Number.isFinite(n)
      ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : match;
  });
}
