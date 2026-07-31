// tools/self-test.js
//
// In-game structural validator - run it after a sync, BEFORE `killall; run
// /early/driver.js`, to catch problems a live start would only reveal by failing.
// Since this project can't run `tsc`, this is the practical stand-in:
//
//   getScriptRam(file) performs Bitburner's static RAM analysis, which requires
//   PARSING the file AND resolving its whole import closure. So a script with a
//   syntax error or a missing/renamed import returns 0 - which this test reports
//   as BROKEN. Running it over every .js on home is therefore a real compile +
//   import check for the entire codebase.
//
// It also verifies the files CONFIG.paths references exist, prints each key
// script's RAM cost, checks whether the current node's daemon fits home (i.e.
// whether early/driver.js will hand off yet), and prints the detected API
// capabilities + contract-solver coverage. It makes NO purchases and never resets.
// Idea ported from ame824/autoDoIt (tools/self-test.js).

import { CONFIG, forNode } from "../lib/config.js";
import { allServers } from "../lib/net.js";
import { getCapabilities } from "../lib/capabilities.js";
import { supportedContractTypes } from "../lib/contract-solvers.js";

const HOME = "home";

/** @param {NS} ns @param {string} f */
function safeRam(ns, f) {
  try { return ns.getScriptRam(f, HOME); } catch { return 0; }
}

/** @param {NS} ns */
export async function main(ns) {
  const caps = getCapabilities(ns);
  const node = caps.currentNode;
  const cfg = forNode(node);

  ns.tprint("");
  ns.tprint(`=== GORDNET self-test (BitNode ${node}) ===`);

  // 1. Files that CONFIG.paths references must exist (the daemon imports/execs
  //    these). Exclude legacyStartup - that one is SUPPOSED to be absent.
  const referenced = [...new Set(Object.values(cfg.paths))]
    .filter(v => typeof v === "string" && v.endsWith(".js") && v !== cfg.paths.legacyStartup);
  const missing = referenced.filter(f => !ns.fileExists(f, HOME));
  ns.tprint(`Config-referenced scripts: ${referenced.length - missing.length}/${referenced.length} present`);
  for (const f of missing) ns.tprint(`  MISSING: ${f}`);

  // 2. Compile/import check across EVERY .js on home. getScriptRam === 0 on an
  //    existing file means a parse error or an unresolved import somewhere in its
  //    closure - the single most useful signal we can get without tsc.
  const allJs = ns.ls(HOME, ".js").filter(f => f.endsWith(".js"));
  const broken = allJs.filter(f => ns.fileExists(f, HOME) && safeRam(ns, f) <= 0);
  ns.tprint(`Compile/import check: ${allJs.length - broken.length}/${allJs.length} scripts analysed OK`);
  for (const f of broken) ns.tprint(`  BROKEN (parse/import error): ${f}`);

  // 3. RAM cost of the config-referenced scripts, largest first.
  const sized = referenced
    .filter(f => ns.fileExists(f, HOME))
    .map(f => ({ f, ram: safeRam(ns, f) }))
    .sort((a, b) => b.ram - a.ram);
  ns.tprint("RAM cost (config-referenced scripts, largest first):");
  for (const { f, ram } of sized) ns.tprint(`  ${f.padEnd(26)} ${ns.format.ram(ram)}`);

  // 4. Will early/driver.js hand off? It waits until home holds the node's daemon
  //    plus workerHeadroom. Informational (not a failure - the driver just grows
  //    home until it fits).
  const daemon = cfg.paths.daemon;
  if (daemon && ns.fileExists(daemon, HOME)) {
    const dram = safeRam(ns, daemon);
    const homeMax = ns.getServerMaxRam(HOME);
    const need = dram + CONFIG.driver.workerHeadroom;
    ns.tprint(
      `Daemon ${daemon}: needs ${ns.format.ram(need)} (script ${ns.format.ram(dram)} + headroom), ` +
      `home is ${ns.format.ram(homeMax)} -> ${homeMax >= need ? "FITS (driver hands off)" : "too small yet (driver keeps growing home)"}`
    );
  } else if (daemon) {
    ns.tprint(`Daemon ${daemon} for BitNode ${node} is NOT on home.`);
  } else {
    ns.tprint(`No daemon configured for BitNode ${node} (driver falls back to ${CONFIG.driver.fallbackDaemon}).`);
  }

  // 5. Detected capabilities for this run.
  ns.tprint(
    `APIs: singularity=${caps.singularity} gang=${caps.gang} corp=${caps.corporation} ` +
    `sleeves=${caps.sleeves} grafting=${caps.grafting} bladeburner=${caps.bladeburner}`
  );
  if (caps.singularity) {
    ns.tprint(`Singularity RAM multiplier: ${caps.singularityRamMultiplier}x (1x once SF4.3 is owned).`);
  }

  // 6. Contract coverage + network reachability sanity.
  ns.tprint(`Contract solvers available: ${supportedContractTypes().length} types.`);
  ns.tprint(`Network: ${allServers(ns).length} servers reachable from home.`);

  // 7. Verdict.
  const ok = missing.length === 0 && broken.length === 0;
  ns.tprint(ok
    ? "RESULT: OK - structure valid and imports resolve. Safe to `killall; run /early/driver.js`."
    : "RESULT: FAIL - resolve the MISSING/BROKEN files above and re-sync before starting.");
  ns.tprint("");
}
