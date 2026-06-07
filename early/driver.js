// early/driver.js
/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const WORKER = "/early/worker.js";
  const HOME_RESERVE = 8; // keep RAM free so you can edit/run things
  const MONEY_BUFFER = 0.85;

  await ns.scp(WORKER, "home");

  while (true) {
    const servers = scanAll(ns);
    for (const s of servers) tryRoot(ns, s);

    const rooted = servers.filter(s =>
      ns.hasRootAccess(s) &&
      ns.getServerMaxMoney(s) > 0 &&
      ns.getServerRequiredHackingLevel(s) <= ns.getHackingLevel()
    );

    const target = rooted
      .sort((a, b) => score(ns, b) - score(ns, a))[0] ?? "n00dles";

    ns.print(`Target: ${target} | $${fmt(ns.getServerMoneyAvailable("home"))}`);

    // Upgrade home RAM ASAP
    if (ns.singularity?.upgradeHomeRam) {
      while (
        ns.getServerMoneyAvailable("home") * MONEY_BUFFER >
        ns.singularity.getUpgradeHomeRamCost?.() &&
        ns.singularity.upgradeHomeRam()
      ) {
        ns.print(`Upgraded home RAM to ${ns.getServerMaxRam("home")}GB`);
      }
    }

    // Deploy worker everywhere
    const runners = ["home", ...servers.filter(s => ns.hasRootAccess(s))];

    for (const host of [...new Set(runners)]) {
      if (host !== "home") await ns.scp(WORKER, host);

      const free = ns.getServerMaxRam(host) - ns.getServerUsedRam(host) - (host === "home" ? HOME_RESERVE : 0);
      const ram = ns.getScriptRam(WORKER);
      const threads = Math.floor(free / ram);

      if (threads > 0) {
        ns.exec(WORKER, host, threads, target);
      }
    }

    await ns.sleep(10_000);
  }
}

function scanAll(ns) {
  const seen = new Set(["home"]);
  const stack = ["home"];

  while (stack.length) {
    const host = stack.pop();
    for (const n of ns.scan(host)) {
      if (!seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }

  return [...seen].filter(s => s !== "home");
}

function tryRoot(ns, host) {
  if (ns.hasRootAccess(host)) return;

  const tools = [
    ["BruteSSH.exe", ns.brutessh],
    ["FTPCrack.exe", ns.ftpcrack],
    ["relaySMTP.exe", ns.relaysmtp],
    ["HTTPWorm.exe", ns.httpworm],
    ["SQLInject.exe", ns.sqlinject],
  ];

  let ports = 0;

  for (const [file, fn] of tools) {
    if (ns.fileExists(file, "home")) {
      try {
        fn(host);
        ports++;
      } catch {}
    }
  }

  if (ports >= ns.getServerNumPortsRequired(host)) {
    try {
      ns.nuke(host);
    } catch {}
  }
}

function score(ns, host) {
  const maxMoney = ns.getServerMaxMoney(host);
  const minSec = ns.getServerMinSecurityLevel(host);
  const growth = ns.getServerGrowth(host);
  const reqHack = ns.getServerRequiredHackingLevel(host);

  return maxMoney * growth / Math.max(1, minSec) / Math.max(1, reqHack);
}

/** @param {number} n */
function fmt(n) {
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}t`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}b`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}m`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}k`;
  return n.toFixed(0);
}