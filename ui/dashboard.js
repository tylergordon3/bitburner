// ui/dashboard.js

const FINAL_HOST = "w0r1d_d43m0n";

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.ui.openTail();

  while (true) {
    ns.clearLog();

    const player = ns.getPlayer();
    const money = player.money;
    const hack = player.skills.hacking;

    const incomeHour = getIncomePerHour(ns);
    const currentWork = ns.singularity.getCurrentWork();
    const ram = getRamStats(ns);
    const cloud = getCloudStats(ns);
    const final = getHackTargetEstimate(ns, FINAL_HOST);

    ns.print("+--------------------------------------------+");
    ns.print("|              GORDNET DASHBOARD             |");
    ns.print("+--------------------------------------------+");
    ns.print("");
    ns.print(`Money:        $${ns.format.number(money)}`);
    ns.print(`Income/hr:    $${ns.format.number(incomeHour)}`);
    ns.print(`Hacking:      ${hack}`);
    ns.print("");
    ns.print("-- Current Action ---------------------------");
    ns.print(formatWork(currentWork));
    ns.print("");
    ns.print("-- RAM Usage --------------------------------");
    ns.print(`Used:         ${ns.format.ram(ram.used)} / ${ns.format.ram(ram.max)}`);
    ns.print(`Free:         ${ns.format.ram(ram.free)}`);
    ns.print(`Usage:        ${ns.format.percent(ram.used / Math.max(1, ram.max))}`);
    ns.print("");
    ns.print("-- Cloud Servers ----------------------------");
    ns.print(`Owned:        ${cloud.count} / ${cloud.limit}`);
    ns.print(`Cloud RAM:    ${ns.format.ram(cloud.ram)}`);
    ns.print("");
    ns.print("-- Final BitNode Target ---------------------");
    ns.print(`Target:       ${FINAL_HOST}`);
    ns.print(`Req Hack:     ${final.required}`);
    ns.print(`Need:         ${final.missing}`);
    ns.print(`ETA:          ${final.eta}`);

    await ns.sleep(5_000);
  }
}

/** @param {NS} ns */
function getIncomePerHour(ns) {
  const sources = ns.getMoneySources?.();
  if (!sources) return 0;

  const total = sources.sinceInstall.total;
  const seconds = Math.max(1, ns.getResetInfo().lastAugReset
    ? (Date.now() - ns.getResetInfo().lastAugReset) / 1000
    : 1
  );

  return total / seconds * 3600;
}

/** @param {NS} ns */
function getRamStats(ns) {
  const hosts = ["home", ...ns.cloud.getServerNames()];

  let used = 0;
  let max = 0;

  for (const host of hosts) {
    used += ns.getServerUsedRam(host);
    max += ns.getServerMaxRam(host);
  }

  return {
    used,
    max,
    free: max - used,
  };
}

/** @param {NS} ns */
function getCloudStats(ns) {
  const servers = ns.cloud.getServerNames();

  return {
    count: servers.length,
    limit: ns.cloud.getServerLimit(),
    ram: servers.reduce((sum, s) => sum + ns.getServerMaxRam(s), 0),
  };
}

/** @param {NS} ns */
function getHackTargetEstimate(ns, host) {
  if (!ns.serverExists(host)) {
    return {
      required: "unknown",
      missing: "unknown",
      eta: "target not found",
    };
  }

  const required = ns.getServerRequiredHackingLevel(host);
  const current = ns.getPlayer().skills.hacking;
  const missing = Math.max(0, required - current);

  // simple rough estimate using recent hack XP rate
  const sources = ns.getTotalScriptExpGain?.();
  const xpPerSec = sources ?? 0;

  return {
    required,
    missing,
    eta: missing <= 0 ? "ready now" : "rough estimate unavailable",
  };
}

function formatWork(work) {
  if (!work) return "Idle";

  if (work.type === "FACTION") {
    return `Faction work: ${work.factionName} / ${work.factionWorkType}`;
  }

  if (work.type === "CLASS") {
    return `Training/studying: ${work.classType} at ${work.location}`;
  }

  if (work.type === "CRIME") {
    return `Crime: ${work.crimeType}`;
  }

  if (work.type === "COMPANY") {
    return `Company work: ${work.companyName}`;
  }

  if (work.type === "CREATE_PROGRAM") {
    return `Creating program: ${work.programName}`;
  }

  return JSON.stringify(work);
}