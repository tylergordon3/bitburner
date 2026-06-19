// ui/dashboard.js

const FINAL_HOST = "w0r1d_d43m0n";

// Servers that need backdoors for faction access / BN progression
const BACKDOOR_CHECKLIST = [
  { server: "CSEC",          label: "CyberSec"    },
  { server: "avmnite-02h",   label: "NiteSec"     },
  { server: "I.I.I.I",      label: "The Black Hand" },
  { server: "run4theh111z",  label: "BitRunners"  },
  { server: "The-Cave",      label: "The Cave" },
  { server: "w0r1d_d43m0n", label: "World Daemon" },
];

// Factions worth joining for aug access — shown as joined ✓ / pending ✗
const FACTION_CHECKLIST = [
  "CyberSec",
  "NiteSec",
  "The Black Hand",
  "BitRunners",
  "Daedalus",
  "Illuminati",
  "The Covenant",
];

// ── Trend state ─────────────────────────────────────────────────────────────
let lastHackLevel = 0;
let lastHackTime  = Date.now();
let hackLevelsPerHour = 0;

let lastFactionRep  = 0;
let lastFactionTime = Date.now();
let factionRepPerHour = 0;

let lastMoney     = 0;
let lastMoneyTime = Date.now();
let moneyPerHour  = 0;

let lastRamTotal = 0;
let lastRamTime  = Date.now();
let ramPerHour   = 0;

// ── Entry point ──────────────────────────────────────────────────────────────
/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.ui.openTail();
  ns.ui.moveTail(20, 40);

  while (true) {
    const player      = ns.getPlayer();
    const money       = player.money;
    const hack        = player.skills.hacking;
    const incomeHour  = getIncomePerHour(ns);
    const ram         = getRamStats(ns);
    const cloud       = getCloudStats(ns);
    const final       = getHackTargetEstimate(ns, FINAL_HOST);
    const state       = globalThis.gordState ?? {};
    const target      = state.target ?? {};
    const goal        = getGoalEstimate(ns, target);
    const moneyRate   = updateMoneyTrend(ns);
    const ramRate     = updateRamTrend(ns, ram.max);
    const augQueue    = getAugQueueInfo(ns);
    const moneyEta    = etaFromRate(target.moneyMissing ?? 0, moneyRate);
    const network     = getNetworkStatus(ns);
    const runDuration = getRunDuration(ns);

    renderDashboard(ns, {
      player, money, hack, incomeHour,
      ram, cloud, final, state, target,
      goal, moneyRate, moneyEta, ramRate,
      augQueue, network, runDuration,
    });

    await ns.sleep(5_000);
  }
}

// ── Render ───────────────────────────────────────────────────────────────────
/** @param {NS} ns */
function renderDashboard(ns, data) {
  ns.clearLog();
  try {
    const { player, money, hack, incomeHour, ram, cloud, final,
            state, target, goal, moneyRate, moneyEta, ramRate,
            augQueue, network } = data;

    // Colours
    const C = {
      green:   "#4ade80",
      yellow:  "#facc15",
      red:     "#f87171",
      blue:    "#60a5fa",
      purple:  "#c084fc",
      dim:     "rgba(255,255,255,0.45)",
      border:  "rgba(255,255,255,0.10)",
      cardBg:  "rgba(255,255,255,0.03)",
    };

    // Derived
    const hackPct     = Math.min(1, hack / Math.max(1, Number(final.required) || hack));
    const ramPct      = ram.max > 0 ? ram.used / ram.max : 0;
    const repPct      = target.repReq  > 0 ? Math.min(1, (target.rep  ?? 0) / target.repReq)  : 1;
    const moneyPct    = target.price   > 0 ? Math.min(1, money / target.price)                 : 1;
    const augInstall  = augQueue.urgency === "high"   ? C.red
                      : augQueue.urgency === "medium" ? C.yellow
                      : C.green;

    const actionColor = state.action?.startsWith("Crime")    ? C.red
                      : state.action?.startsWith("Studying") ? C.blue
                      : state.action?.startsWith("Training") ? C.yellow
                      : state.action?.startsWith("Faction")  ? C.purple
                      : C.green;

    ns.printRaw(
      el("div", {
        style: {
          fontFamily: "'Courier New', monospace",
          fontSize: "14px",
          padding: "10px 14px",
          boxSizing: "border-box",
          width: "100%",
          color: "#e2e8f0",
        },
      },

        // ── Header ──────────────────────────────────────────────────────────
        el("div", {
          style: {
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: "10px",
            borderBottom: `1px solid ${C.border}`,
            paddingBottom: "6px",
          },
        },
          el("span", { style: { fontSize: "17px", fontWeight: "bold", letterSpacing: "2px", color: C.green } },
            "[ GORDNET ]"
          ),
          el("div", { style: { display: "flex", gap: "14px", alignItems: "baseline" } },
            el("span", { style: { fontSize: "13px", color: C.yellow } },
              `run ${data.runDuration}`
            ),
            el("span", { style: { fontSize: "13px", color: C.dim } },
              new Date().toLocaleTimeString()
            ),
          ),
        ),

        // ── Row 1: Player + Goal side-by-side ───────────────────────────────
        el("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginBottom: "8px" } },

          // Player card
          card(C, "PLAYER", [
            statRow(C, "$", `${ns.format.number(money)}`, `+${ns.format.number(incomeHour)}/hr`, C.green),
            statRow(C, "~", `Hack ${hack}`, final.missing <= 0 ? "[OK]" : `${final.eta} to BN`, hack >= (Number(final.required) || hack) ? C.green : C.yellow),
            progressBar(hackPct, C.blue),
            el("div", { style: { display: "flex", justifyContent: "space-between", marginTop: "6px" } },
              stat(C, "Karma",  ns.format.number(data.player.karma)),
              stat(C, "Kills",  data.player.numPeopleKilled),
            ),
          ]),

          // Current Goal card
          card(C, "GOAL", [
            el("div", { style: { display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px" } },
              el("span", {
                style: {
                  background: actionColor + "22",
                  border: `1px solid ${actionColor}55`,
                  color: actionColor,
                  borderRadius: "4px",
                  padding: "1px 6px",
                  fontSize: "13px",
                  fontWeight: "bold",
                },
              }, state.action ?? "Idle"),
            ),
            el("div", { style: { color: C.dim, fontSize: "13px", marginBottom: "8px", wordBreak: "break-word", lineHeight: "1.4" } },
              state.detail ?? "-"
            ),
            target.faction ? el("div", { style: {} },
              label(C, "Rep"),
              progressBar(repPct, C.purple),
              el("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "13px", color: C.dim, marginBottom: "5px" } },
                el("span", {}, `${ns.format.number(target.rep ?? 0)} / ${ns.format.number(target.repReq ?? 0)}`),
                el("span", {}, goal.eta),
              ),
              label(C, "Price"),
              progressBar(moneyPct, C.green),
              el("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "13px", color: C.dim } },
                el("span", {}, `$${ns.format.number(money)} / $${ns.format.number(target.price ?? 0)}`),
                el("span", {}, moneyEta),
              ),
            ) : el("div", { style: { color: C.dim, fontSize: "13px" } }, "No aug target"),
          ]),
        ),

        // ── Row 2: Infrastructure + Augmentations side-by-side ──────────────
        el("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginBottom: "8px" } },

          // Infrastructure card
          card(C, "INFRA", [
            label(C, "RAM"),
            progressBar(ramPct, ramPct > 0.9 ? C.red : ramPct > 0.7 ? C.yellow : C.blue),
            el("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "13px", color: C.dim, marginBottom: "6px" } },
              el("span", {}, `${ns.format.ram(ram.used)} / ${ns.format.ram(ram.max)}`),
              el("span", {}, `+${ns.format.ram(ramRate)}/hr`),
            ),
            el("div", { style: { display: "flex", justifyContent: "space-between" } },
              stat(C, "Cloud", `${cloud.count}/${cloud.limit} servers`),
              stat(C, "Total", ns.format.ram(cloud.ram)),
            ),
          ]),

          // Augmentation Queue card
          card(C, "AUGS", [
            el("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" } },
              el("span", { style: { color: C.dim, fontSize: "13px" } }, "Queued"),
              el("span", {
                style: {
                  background: augInstall + "22",
                  border: `1px solid ${augInstall}55`,
                  color: augInstall,
                  borderRadius: "4px",
                  padding: "1px 8px",
                  fontWeight: "bold",
                },
              }, String(augQueue.queued)),
            ),
            el("div", {
              style: {
                fontSize: "13px",
                color: augInstall,
                padding: "4px 6px",
                background: augInstall + "11",
                borderRadius: "4px",
                borderLeft: `3px solid ${augInstall}`,
              },
            }, augQueue.recommendation),
          ]),
        ),

        // ── Network Checklist ────────────────────────────────────────────────
        card(C, "NETWORK", [
          el("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" } },

            // Backdoors column
            el("div", {},
              el("div", { style: { fontSize: "12px", color: C.dim, letterSpacing: "1px", marginBottom: "4px" } }, "BACKDOORS"),
              ...network.backdoors.map(b =>
                checkRow(C, b.label, b.done,
                  b.done ? "installed" : (!b.exists ? "undiscovered" : !b.rooted ? "no root" : "pending")
                )
              ),
            ),

            // Factions column
            el("div", {},
              el("div", { style: { fontSize: "12px", color: C.dim, letterSpacing: "1px", marginBottom: "4px" } }, "FACTIONS"),
              ...network.factions.map(f =>
                checkRow(C, f.name, f.joined, f.joined ? "joined" : "pending")
              ),
            ),
          ),
        ]),

        // ── Aug Pipeline ─────────────────────────────────────────────────────
        card(C, "AUG PIPELINE", [
          el("div", { style: { fontSize: "12px", color: C.dim, marginBottom: "6px" } },
            "Next augmentations by estimated time-to-purchase"
          ),
          ...(globalThis.gordAugPipeline ?? []).slice(0, 6).map((a, i) => {
            const done      = a.canBuy;
            const repDone   = a.repMissing <= 0;
            const color     = done ? C.green : repDone ? C.yellow : C.dim;
            const etaStr    = done ? "READY"
                            : isFinite(a.estimatedMs) ? formatDuration(a.estimatedMs)
                            : repDone ? `$${ns.format.number(a.moneyMissing)}`
                            : `${ns.format.number(a.repMissing)} rep`;
            return el("div", {
              key: i,
              style: {
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                fontSize: "12px",
                padding: "2px 0",
                borderBottom: i < 5 ? `1px solid ${C.border}` : "none",
              },
            },
              el("span", { style: { color: i === 0 ? C.green : C.dim, fontWeight: i === 0 ? "bold" : "normal" } },
                `${i === 0 ? "> " : "  "}${a.aug}`
              ),
              el("div", { style: { display: "flex", gap: "10px", alignItems: "center" } },
                el("span", { style: { color: C.dim, fontSize: "11px" } }, a.faction),
                el("span", { style: { color, fontWeight: "bold", minWidth: "60px", textAlign: "right" } }, etaStr),
              ),
            );
          }),
        ]),

        // ── Faction Pipeline ─────────────────────────────────────────────────
        card(C, "FACTION PIPELINE", [
          el("div", { style: { fontSize: "12px", color: C.dim, marginBottom: "6px" } },
            "Unjoined factions & what's blocking them"
          ),
          ...(globalThis.gordFactionPipeline ?? []).slice(0, 6).map((op, i) => {
            const urgencyColor = op.urgency === "high"   ? C.red
                               : op.urgency === "medium" ? C.yellow
                               : C.dim;
            const label = op.faction;
            const sub   = op.reason ?? "";
            return el("div", {
              key: i,
              style: {
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                fontSize: "12px",
                padding: "2px 0",
                borderBottom: i < 5 ? `1px solid ${C.border}` : "none",
              },
            },
              el("span", { style: { color: "#e2e8f0" } }, label),
              el("span", { style: { color: urgencyColor, fontSize: "11px", maxWidth: "200px", textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, sub),
            );
          }),
        ]),

      )
    );
  } catch (e) {
    ns.print("Dashboard error: " + String(e));
    ns.print(e?.stack ?? "");
  }

  ns.ui.resizeTail(780, 1200);
}

// ── Data helpers ─────────────────────────────────────────────────────────────

/** @param {NS} ns */
function getNetworkStatus(ns) {
  const joinedSet = /** @type {Set<string>} */ (new Set(ns.getPlayer().factions ?? []));

  const backdoors = BACKDOOR_CHECKLIST.map(({ server, label }) => {
    const exists = ns.serverExists(server);
    const rooted = exists && ns.hasRootAccess(server);
    const done   = exists && ns.getServer(server).backdoorInstalled;
    return { server, label, exists, rooted, done };
  });

  const factions = FACTION_CHECKLIST.map(name => ({
    name,
    joined: joinedSet.has(name),
  }));

  return { backdoors, factions };
}

/** @param {NS} ns */
function getIncomePerHour(ns) {
  const n = /** @type {any} */ (ns);
  if (!n.getMoneySources || !n.getResetInfo) return 0;
  const sources = n.getMoneySources();
  const reset   = n.getResetInfo();
  const total   = sources.sinceInstall.total;
  const seconds = Math.max(1, (Date.now() - reset.lastAugReset) / 1000);
  return (total / seconds) * 3600;
}

/** @param {NS} ns */
function getRunDuration(ns) {
  try {
    const n = /** @type {any} */ (ns);
    if (!n.getResetInfo) return "?";
    const reset = n.getResetInfo();
    return formatDuration(Date.now() - reset.lastAugReset);
  } catch {
    return "?";
  }
}

/** @param {NS} ns */
function getRamStats(ns) {
  const hosts = ["home", ...ns.cloud.getServerNames()];
  let used = 0, max = 0;
  for (const h of hosts) {
    used += ns.getServerUsedRam(h);
    max  += ns.getServerMaxRam(h);
  }
  return { used, max, free: max - used };
}

/** @param {NS} ns */
function getCloudStats(ns) {
  const servers = ns.cloud.getServerNames();
  return {
    count: servers.length,
    limit: ns.cloud.getServerLimit(),
    ram:   servers.reduce((s, n) => s + ns.getServerMaxRam(n), 0),
  };
}

/** @param {NS} ns */
function getHackTargetEstimate(ns, host) {
  if (!ns.serverExists(host)) {
    return { required: "?", missing: "?", eta: "not discovered", rate: 0 };
  }

  const required = ns.getServerRequiredHackingLevel(host);
  const current  = ns.getPlayer().skills.hacking;
  const missing  = Math.max(0, required - current);
  const now      = Date.now();

  if (lastHackLevel > 0 && now > lastHackTime) {
    const gain  = current - lastHackLevel;
    const hours = (now - lastHackTime) / 3_600_000;
    if (gain > 0 && hours > 0) {
      const instant = gain / hours;
      hackLevelsPerHour = hackLevelsPerHour === 0
        ? instant
        : hackLevelsPerHour * 0.8 + instant * 0.2;
    }
  }
  lastHackLevel = current;
  lastHackTime  = now;

  const eta = missing <= 0           ? "ready now"
            : hackLevelsPerHour > 0  ? formatDuration((missing / hackLevelsPerHour) * 3_600_000)
            : "-";

  return { required, missing, eta, rate: hackLevelsPerHour };
}

/** @param {NS} ns */
function getGoalEstimate(ns, target) {
  if (!target?.faction) return { rate: 0, eta: "-" };

  const currentRep = ns.singularity.getFactionRep(/** @type {any} */ (target.faction));
  const now        = Date.now();

  if (lastFactionRep > 0 && now > lastFactionTime) {
    const gained = currentRep - lastFactionRep;
    const hours  = (now - lastFactionTime) / 3_600_000;
    if (gained > 0 && hours > 0) {
      const instant = gained / hours;
      factionRepPerHour = factionRepPerHour === 0
        ? instant
        : factionRepPerHour * 0.8 + instant * 0.2;
    }
  }
  lastFactionRep  = currentRep;
  lastFactionTime = now;

  const eta = (target.repMissing ?? 0) <= 0  ? "complete"
            : factionRepPerHour > 0           ? formatDuration((target.repMissing / factionRepPerHour) * 3_600_000)
            : "-";

  return { rate: factionRepPerHour, eta };
}

/** @param {NS} ns */
function updateMoneyTrend(ns) {
  const money = ns.getPlayer().money;
  const now   = Date.now();
  if (lastMoney > 0 && now > lastMoneyTime) {
    const gained = money - lastMoney;
    const hours  = (now - lastMoneyTime) / 3_600_000;
    if (gained > 0 && hours > 0) {
      const instant = gained / hours;
      moneyPerHour = moneyPerHour === 0 ? instant : moneyPerHour * 0.8 + instant * 0.2;
    }
  }
  lastMoney     = money;
  lastMoneyTime = now;
  return moneyPerHour;
}

/** @param {NS} ns */
function updateRamTrend(ns, totalRam) {
  const now = Date.now();
  if (lastRamTotal > 0 && now > lastRamTime) {
    const gained = totalRam - lastRamTotal;
    const hours  = (now - lastRamTime) / 3_600_000;
    if (gained > 0 && hours > 0) {
      const instant = gained / hours;
      ramPerHour = ramPerHour === 0 ? instant : ramPerHour * 0.8 + instant * 0.2;
    }
  }
  lastRamTotal = totalRam;
  lastRamTime  = now;
  return ramPerHour;
}

/** @param {NS} ns */
function getAugQueueInfo(ns) {
  const withPurchased = ns.singularity.getOwnedAugmentations(true);
  const installed     = ns.singularity.getOwnedAugmentations(false);
  const queued        = withPurchased.length - installed.length;

  const hasRedPill = withPurchased.includes("The Red Pill") && !installed.includes("The Red Pill");

  const urgency        = hasRedPill ? "high" : queued >= 5 ? "medium" : "low";
  const recommendation = hasRedPill         ? "[!!] Install now - Red Pill queued!"
                       : queued >= 5        ? "[!]  Install soon - threshold met"
                       : queued > 0         ? "Keep grinding"
                       : "Nothing queued";

  return { queued, recommendation, urgency };
}

function etaFromRate(remaining, ratePerHour) {
  if (remaining <= 0) return "complete";
  if (!ratePerHour || ratePerHour <= 0) return "-";
  return formatDuration((remaining / ratePerHour) * 3_600_000);
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hr  = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  if (day > 0) return `${day}d ${hr % 24}h`;
  if (hr  > 0) return `${hr}h ${min % 60}m`;
  if (min > 0) return `${min}m ${sec % 60}s`;
  return `${sec}s`;
}

// ── UI primitives ─────────────────────────────────────────────────────────────

function el(type, props = {}, ...children) {
  const React = globalThis.React;
  if (!React?.createElement) throw new Error("React not available");
  return React.createElement(type, props, ...children);
}

function card(C, title, children) {
  return el("div", {
    style: {
      border: `1px solid ${C.border}`,
      borderRadius: "6px",
      padding: "10px 12px",
      marginBottom: "8px",
      background: C.cardBg,
    },
  },
    el("div", {
      style: {
        fontWeight: "bold",
        fontSize: "13px",
        letterSpacing: "1px",
        color: C.dim,
        marginBottom: "7px",
        textTransform: "uppercase",
      },
    }, title),
    ...children,
  );
}

function label(C, text) {
  return el("div", {
    style: { fontSize: "12px", color: C.dim, marginBottom: "3px", letterSpacing: "0.5px" },
  }, text);
}

function progressBar(pct, color) {
  const filled = Math.round(Math.max(0, Math.min(1, pct)) * 20);
  const empty  = 20 - filled;
  return el("div", {
    style: {
      height: "6px",
      borderRadius: "2px",
      background: "rgba(255,255,255,0.08)",
      marginBottom: "3px",
      overflow: "hidden",
    },
  },
    el("div", {
      style: {
        width: `${Math.round(pct * 100)}%`,
        height: "100%",
        background: color,
        borderRadius: "2px",
        transition: "width 0.3s",
      },
    }),
  );
}

function statRow(C, icon, primary, secondary, color) {
  return el("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "baseline",
      marginBottom: "4px",
    },
  },
    el("span", { style: { color: C.dim, fontSize: "13px" } }, `${icon} ${primary}`),
    el("span", { style: { color, fontSize: "13px", fontWeight: "bold" } }, secondary),
  );
}

function stat(C, label_, value) {
  return el("div", { style: { fontSize: "13px" } },
    el("span", { style: { color: C.dim } }, `${label_} `),
    el("span", { style: { fontWeight: "bold" } }, String(value)),
  );
}

function checkRow(C, label_, done, subtext) {
  const color = done ? C.green : C.dim;
  return el("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: "5px",
      padding: "2px 0",
      fontSize: "13px",
    },
  },
    el("span", { style: { color, fontWeight: "bold", width: "12px", flexShrink: 0 } }, done ? "[+]" : "[ ]"),
    el("span", { style: { color: done ? "#e2e8f0" : C.dim, flexGrow: 1 } }, label_),
    el("span", { style: { color: done ? C.green : "rgba(255,255,255,0.25)", fontSize: "12px" } }, subtext),
  );
}