// ui/dashboard.js

const FINAL_HOST = "w0r1d_d43m0n";

let lastHackLevel = 0;
let lastHackTime = Date.now();
let hackLevelsPerHour = 0;

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  ns.ui.openTail();
  ns.ui.resizeTail(550, 780);
  ns.ui.moveTail(20, 40);

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

    const state = globalThis.gordState ?? {};
    const target = state.target ?? {};

    ns.print("+--------------------------------------------------+");
    ns.print("|                  GORDNET DASHBOARD               |");
    ns.print("+--------------------------------------------------+");
    ns.print("");

    ns.print("-- Player -----------------------------------------");
    ns.print(`Money:       $${ns.format.number(money)}`);
    ns.print(`Income/hr:   $${ns.format.number(incomeHour)}`);
    ns.print(`Hack Level:  ${hack}`);
    ns.print(`Karma:       ${ns.format.number(player.karma)}`);
    ns.print(`Kills:       ${player.numPeopleKilled}`);
    ns.print("");

    ns.print("-- Current Goal -----------------------------------");
    ns.print(`Action:      ${state.action ?? "Unknown"}`);
    ns.print(`Detail:      ${state.detail ?? "-"}`);

    if (target.aug) {
      ns.print(`Faction:     ${target.faction}`);
      ns.print(`Augment:     ${target.aug}`);
      ns.print(`Need Rep:    ${ns.format.number(target.repMissing ?? 0)}`);
      ns.print(`Need Money:  $${ns.format.number(target.moneyMissing ?? 0)}`);
    }

    ns.print("");
    ns.print("-- Current Work -----------------------------------");
    ns.print(formatWork(currentWork));
    ns.print("");

    ns.print("-- Infrastructure ---------------------------------");
    ns.print(`RAM Used:    ${ns.format.ram(ram.used)} / ${ns.format.ram(ram.max)}`);
    ns.print(`RAM Free:    ${ns.format.ram(ram.free)}`);
    ns.print(`RAM Usage:   ${ns.format.percent(ram.used / Math.max(1, ram.max))}`);
    ns.print(`Cloud:       ${cloud.count} / ${cloud.limit}`);
    ns.print(`Cloud RAM:   ${ns.format.ram(cloud.ram)}`);
    ns.print("");

    ns.print("-- Final BitNode Target ---------------------------");
    ns.print(`Target:      ${FINAL_HOST}`);
    ns.print(`Req Hack:    ${final.required}`);
    ns.print(`Current:     ${hack}`);
    ns.print(`Remaining:   ${final.missing}`);
    ns.print(`Hack Rate:   ${ns.format.number(final.rate ?? 0)} lvls/hr`);
    ns.print(`ETA:         ${final.eta}`);

    await ns.sleep(5_000);
  }
}

/** @param {NS} ns */
function getIncomePerHour(ns) {
  const n = /** @type {any} */ (ns);

  if (!n.getMoneySources || !n.getResetInfo) return 0;

  const sources = n.getMoneySources();
  const reset = n.getResetInfo();

  const total = sources.sinceInstall.total;
  const seconds = Math.max(1, (Date.now() - reset.lastAugReset) / 1000);

  return (total / seconds) * 3600;
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
      eta: "not discovered yet",
      rate: 0,
    };
  }

  const required = ns.getServerRequiredHackingLevel(host);
  const current = ns.getPlayer().skills.hacking;
  const missing = Math.max(0, required - current);

  const now = Date.now();

  if (lastHackLevel > 0 && now > lastHackTime) {
    const levelGain = current - lastHackLevel;
    const hours = (now - lastHackTime) / 3_600_000;

    if (levelGain > 0 && hours > 0) {
      const instantRate = levelGain / hours;

      hackLevelsPerHour =
        hackLevelsPerHour === 0
          ? instantRate
          : hackLevelsPerHour * 0.8 + instantRate * 0.2;
    }
  }

  lastHackLevel = current;
  lastHackTime = now;

  let eta = "waiting for level gain data";

  if (missing <= 0) {
    eta = "ready now";
  } else if (hackLevelsPerHour > 0) {
    eta = formatDuration((missing / hackLevelsPerHour) * 3_600_000);
  }

  return {
    required,
    missing,
    eta,
    rate: hackLevelsPerHour,
  };
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";

  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);

  if (day > 0) return `${day}d ${hr % 24}h`;
  if (hr > 0) return `${hr}h ${min % 60}m`;
  if (min > 0) return `${min}m ${sec % 60}s`;
  return `${sec}s`;
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