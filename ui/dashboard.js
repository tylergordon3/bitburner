// ui/dashboard.js

const FINAL_HOST = "w0r1d_d43m0n";

let lastHackLevel = 0;
let lastHackTime = Date.now();
let hackLevelsPerHour = 0;

let lastFactionRep = 0;
let lastFactionTime = Date.now();
let factionRepPerHour = 0;

let lastMoney = 0;
let lastMoneyTime = Date.now();
let moneyPerHour = 0;

let lastRamTotal = 0;
let lastRamTime = Date.now();
let ramPerHour = 0;

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  ns.ui.openTail();
  ns.ui.moveTail(20, 40);

  while (true) {
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
    const goal = getGoalEstimate(ns, target);

    const moneyRate = updateMoneyTrend(ns);
    const ramRate = updateRamTrend(ns, ram.max);
    const augQueue = getAugQueueInfo(ns);

    const moneyEta = etaFromRate(target.moneyMissing ?? 0, moneyRate);

    const missingHack = Number(final.missing) || 0;

    const bitNodeEta =
      missingHack <= 0
        ? "hack ready"
        : etaFromRate(missingHack, final.rate ?? 0);

    const data = {
      player,
      money,
      hack,
      incomeHour,
      currentWork,
      ram,
      cloud,
      final,
      state,
      target,
      goal,
      moneyRate,
      moneyEta,
      ramRate,
      augQueue,
      bitNodeEta,
    };

    renderDashboardHtml(ns, data);

    await ns.sleep(5_000);
  }
}

/** @param {NS} ns */
function renderDashboardHtml(ns, data) {
  ns.clearLog();
  try {
    ns.printRaw(
      el(
        "div",
        {
          style: {
            fontFamily: "monospace",
            padding: "12px 18px 12px 12px",
            boxSizing: "border-box",
            width: "100%",
            overflow: "hidden",
          },
        },
        el(
          "div",
          {
            style: {
              fontSize: "20px",
              fontWeight: "bold",
              marginBottom: "10px",
            },
          },
          "GORDNET DASHBOARD"
        ),

        card("Player", [
          row(
            "Money / Income",
            `$${ns.format.number(data.money)} | $${ns.format.number(data.incomeHour)}/hr`
          ),

          row(
            "Hack / Karma",
            `${data.hack} | ${ns.format.number(data.player.karma)}`
          ),

          row(
            "Kills",
            data.player.numPeopleKilled
          ),
        ]),

        card("Current Goal", [
          row("Action", data.state.action ?? "Unknown"),
          row("Detail", data.state.detail ?? "-"),
          row("Need Rep", ns.format.number(data.target.repMissing ?? 0)),
          row("Need Money", `$${ns.format.number(data.target.moneyMissing ?? 0)}`),
          row("Rep Rate / ETA", `${ns.format.number(data.goal.rate)} / hr | ${data.goal.eta}`),
          row("Money ETA", data.moneyEta),
        ]),

        card("Infrastructure", [
        row(
          "RAM",
          `${ns.format.ram(data.ram.used)} used / ${ns.format.ram(data.ram.free)} free / ${ns.format.percent(data.ram.used / Math.max(1, data.ram.max))}`
        ),
        row(
          "Cloud",
          `${data.cloud.count}/${data.cloud.limit} | ${ns.format.ram(data.cloud.ram)}`
        ),
        row("RAM Trend", `${ns.format.ram(data.ramRate)} / hr`),
      ]),

        card("Augmentation Queue", [
          row("Queued", data.augQueue.queued),
          row("Install", data.augQueue.recommendation),
        ]),

        card("Final BitNode Target", [
        row("Target", FINAL_HOST),
        row("Hack", `${data.hack} / ${data.final.required}`),
        row("Remaining", data.final.missing),
        row("Rate / ETA", `${ns.format.number(data.final.rate ?? 0)} lvls/hr | ${data.final.eta}`),
      ]),
      )
    );
  } catch (e) {
    ns.print("Dashboard render error:");
    ns.print(String(e));
    ns.print(e?.stack ?? "");
  }

  ns.ui.resizeTail(720, 900);
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

/** @param {NS} ns */
function getGoalEstimate(ns, target) {
  if (!target?.faction) {
    return {
      rate: 0,
      eta: "unknown",
    };
  }

  const currentRep = ns.singularity.getFactionRep(
    /** @type {any} */ (target.faction)
  );

  const now = Date.now();

  if (lastFactionRep > 0 && now > lastFactionTime) {
    const gained = currentRep - lastFactionRep;
    const hours = (now - lastFactionTime) / 3_600_000;

    if (gained > 0 && hours > 0) {
      const instantRate = gained / hours;

      factionRepPerHour =
        factionRepPerHour === 0
          ? instantRate
          : factionRepPerHour * 0.8 + instantRate * 0.2;
    }
  }

  lastFactionRep = currentRep;
  lastFactionTime = now;

  let eta = "waiting for rep data";

  if (target.repMissing <= 0) {
    eta = "complete";
  } else if (factionRepPerHour > 0) {
    eta = formatDuration(
      (target.repMissing / factionRepPerHour) * 3_600_000
    );
  }

  return {
    rate: factionRepPerHour,
    eta,
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

/** @param {NS} ns */
function updateMoneyTrend(ns) {
  const money = ns.getPlayer().money;
  const now = Date.now();

  if (lastMoney > 0 && now > lastMoneyTime) {
    const gained = money - lastMoney;
    const hours = (now - lastMoneyTime) / 3_600_000;

    if (gained > 0 && hours > 0) {
      const instant = gained / hours;
      moneyPerHour = moneyPerHour === 0 ? instant : moneyPerHour * 0.8 + instant * 0.2;
    }
  }

  lastMoney = money;
  lastMoneyTime = now;

  return moneyPerHour;
}

/** @param {NS} ns */
function updateRamTrend(ns, totalRam) {
  const now = Date.now();

  if (lastRamTotal > 0 && now > lastRamTime) {
    const gained = totalRam - lastRamTotal;
    const hours = (now - lastRamTime) / 3_600_000;

    if (gained > 0 && hours > 0) {
      const instant = gained / hours;
      ramPerHour = ramPerHour === 0 ? instant : ramPerHour * 0.8 + instant * 0.2;
    }
  }

  lastRamTotal = totalRam;
  lastRamTime = now;

  return ramPerHour;
}

/** @param {NS} ns */
function getAugQueueInfo(ns) {
  const ownedWithPurchased = ns.singularity.getOwnedAugmentations(true);
  const ownedInstalled = ns.singularity.getOwnedAugmentations(false);
  const queued = ownedWithPurchased.length - ownedInstalled.length;

  let recommendation = "Keep grinding";

  const hasRedPillQueued =
  ownedWithPurchased.includes("The Red Pill") &&
  !ownedInstalled.includes("The Red Pill");

  if (hasRedPillQueued) {
    recommendation = "Install now: Red Pill queued";
  } else if (queued >= 5) {
    recommendation = "Install soon: queue threshold met";
  }

  return { queued, recommendation };
}

function etaFromRate(remaining, ratePerHour) {
  if (remaining <= 0) return "complete";
  if (!ratePerHour || ratePerHour <= 0) return "waiting for trend data";
  return formatDuration((remaining / ratePerHour) * 3_600_000);
}

function el(type, props = {}, ...children) {
  const React = globalThis.React;

  if (!React?.createElement) {
    throw new Error("React.createElement is not available in this Bitburner environment.");
  }

  return React.createElement(type, props, ...children);
}

function card(title, children) {
  return el(
    "div",
    {
      style: {
        border: "1px solid #555",
        borderRadius: "8px",
        padding: "10px",
        marginBottom: "10px",
        background: "rgba(255,255,255,0.04)",
      },
    },
    el(
      "div",
      {
        style: {
          fontWeight: "bold",
          marginBottom: "8px",
          fontSize: "15px",
        },
      },
      title
    ),
    ...children
  );
}

function row(label, value) {
  return el(
    "div",
    {
      style: {
        display: "grid",
        gridTemplateColumns: "130px minmax(0, 1fr)",
        columnGap: "12px",
        padding: "2px 0",
        width: "100%",
        boxSizing: "border-box",
      },
    },
    el(
      "span",
      {
        style: {
          opacity: 0.75,
          whiteSpace: "nowrap",
        },
      },
      label
    ),
    el(
      "span",
      {
        style: {
          textAlign: "right",
          fontWeight: "bold",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        },
      },
      String(value)
    )
  );
}