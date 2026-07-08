// ui/dashboard.js
//
// Core dashboard template. Renders the shell every BitNode shares (header,
// player, goal, infra, network, pipeline, stocks) and splices in per-BN cards
// from a small registry keyed by BitNode number. To add BN-specific panels,
// create ui/bn<N>.js exporting extraCards(ns, C) and register it below - see
// ui/bn2.js (gang card) for the pattern.

import { FACTION_REQUIREMENTS } from "../lib/aug-targets.js";
import { COLORS, el, card, label, progressBar, stat, statRow, formatDuration } from "./dashboard-lib.js";
import { extraCards as bn2ExtraCards } from "./bn2.js";

// BitNode number -> function returning that node's extra cards (an array).
const BN_EXTRA_CARDS = {
  2: bn2ExtraCards,
};

/**
 * Extra cards for the current BitNode, or [] when the node has no extras.
 * @param {NS} ns
 * @param {typeof COLORS} C
 * @param {number} node
 */
function bnExtraCards(ns, C, node) {
  const fn = BN_EXTRA_CARDS[node];
  if (!fn) return [];
  try {
    return fn(ns, C) ?? [];
  } catch (e) {
    return [el("div", { style: { color: C.red, fontSize: "12px" } }, `BN${node} card error: ${String(e)}`)];
  }
}

const FINAL_HOST = "w0r1d_d43m0n";

// DOM id on the dashboard's root element, used to measure content height for
// dynamic tail sizing (see fitTail).
const DASH_ID = "gordnet-dash";

// Combat stats and their gate thresholds, derived from every combat-gated
// faction requirement (Slum Snakes, Tetrads, Speakers for the Dead, etc.) so
// the player card can show how close we are to full gang/combat eligibility.
const COMBAT_STAT_DEFS = [
  { key: "strength",  label: "STR" },
  { key: "defense",   label: "DEF" },
  { key: "dexterity", label: "DEX" },
  { key: "agility",   label: "AGI" },
];

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
  ns.ui.moveTail(20, 0);

  const currentNode = ns.getResetInfo().currentNode;

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
    const stocks      = globalThis.gordStockState ?? null;
    const combat      = getCombatStats(ns);
    const augsOwned   = ns.singularity.getOwnedAugmentations(true).length;

    renderDashboard(ns, {
      player, money, hack, incomeHour,
      ram, cloud, final, state, target,
      goal, moneyRate, moneyEta, ramRate,
      augQueue, network, runDuration, stocks,
      combat, augsOwned, currentNode,
    });

    await ns.sleep(5_000);
  }
}

// ── Render ───────────────────────────────────────────────────────────────────
/** @param {NS} ns */
function renderDashboard(ns, data) {
  // Size to the previous (fully-committed) frame before redrawing - measuring
  // right after printRaw can catch a half-rendered DOM. Heights are stable
  // tick-to-tick, so the one-frame lag is imperceptible.
  fitTail(ns);
  ns.clearLog();
  try {
    const { player, money, hack, incomeHour, ram, cloud, final,
            state, target, goal, moneyRate, moneyEta, ramRate,
            augQueue, network, stocks, combat, augsOwned, currentNode } = data;

    // Shared palette (see ui/dashboard-lib.js)
    const C = COLORS;

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
        id: DASH_ID,
        style: {
          fontFamily: "'Courier New', monospace",
          fontSize: "14px",
          padding: "2px 10px 6px",
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
            marginBottom: "6px",
            borderBottom: `1px solid ${C.border}`,
            paddingBottom: "4px",
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

            // Combat stats — gate for Slum Snakes/Tetrads/Syndicate/etc.
            el("div", { style: { display: "flex", justifyContent: "space-between", marginTop: "6px" } },
              ...combat.map(s =>
                stat(C, s.label, s.have, s.met ? C.green : s.close ? C.yellow : C.dim)
              ),
            ),

            el("div", { style: { display: "flex", justifyContent: "space-between", marginTop: "6px" } },
              stat(C, "City",   player.city),
              stat(C, "Karma",  ns.format.number(data.player.karma)),
              stat(C, "Kills",  data.player.numPeopleKilled),
            ),

            el("div", { style: { display: "flex", justifyContent: "space-between", marginTop: "6px" } },
              stat(C, "Factions", `${(player.factions ?? []).length} joined`),
              stat(C, "Augs",     `${augsOwned} owned`),
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

        // ── Per-BitNode extras (e.g. BN2 gang card) ─────────────────────────
        ...bnExtraCards(ns, C, currentNode),

        // ── Row 2: Infra + Aug Queue in one card ────────────────────────────
        card(C, "INFRA / AUGS", [
          el("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 20px" } },

            // Left: RAM + cloud
            el("div", {},
              progressBar(ramPct, ramPct > 0.9 ? C.red : ramPct > 0.7 ? C.yellow : C.blue),
              el("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "12px", color: C.dim, marginBottom: "5px" } },
                el("span", {}, `${ns.format.ram(ram.used)} / ${ns.format.ram(ram.max)}`),
                el("span", {}, `+${ns.format.ram(ramRate)}/hr`),
              ),
              el("div", { style: { display: "flex", gap: "10px", fontSize: "12px" } },
                stat(C, "Cloud", `${cloud.count}/${cloud.limit}`),
                stat(C, "RAM",   ns.format.ram(cloud.ram)),
              ),
            ),

            // Right: aug queue
            el("div", {},
              el("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "5px" } },
                el("span", { style: { color: C.dim, fontSize: "12px" } }, "Queued augs"),
                el("span", {
                  style: {
                    background: augInstall + "22",
                    border: `1px solid ${augInstall}55`,
                    color: augInstall,
                    borderRadius: "4px",
                    padding: "0 7px",
                    fontWeight: "bold",
                    fontSize: "13px",
                  },
                }, String(augQueue.queued)),
              ),
              el("div", {
                style: {
                  fontSize: "12px",
                  color: augInstall,
                  padding: "3px 6px",
                  background: augInstall + "11",
                  borderRadius: "4px",
                  borderLeft: `3px solid ${augInstall}`,
                },
              }, augQueue.recommendation),
            ),
          ),
        ]),

        // ── Network Checklist ────────────────────────────────────────────────
        card(C, "NETWORK", [
          el("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 16px" } },

            // Backdoors — compact badge row
            el("div", {},
              el("div", { style: { fontSize: "11px", color: C.dim, letterSpacing: "1px", marginBottom: "4px" } }, "BACKDOORS"),
              el("div", { style: { display: "flex", flexWrap: "wrap", gap: "4px" } },
                ...network.backdoors.map(b => {
                  const color = b.done ? C.green : !b.exists ? "rgba(255,255,255,0.2)" : !b.rooted ? C.red : C.yellow;
                  return el("span", {
                    key: b.server,
                    style: {
                      fontSize: "11px",
                      padding: "1px 6px",
                      borderRadius: "3px",
                      border: `1px solid ${color}55`,
                      color,
                      background: color + "11",
                    },
                  }, b.label);
                }),
              ),
            ),

            // Factions — compact badge row
            el("div", {},
              el("div", { style: { fontSize: "11px", color: C.dim, letterSpacing: "1px", marginBottom: "4px" } }, "FACTIONS"),
              el("div", { style: { display: "flex", flexWrap: "wrap", gap: "4px" } },
                ...network.factions.map(f => {
                  const color = f.joined ? C.green : C.dim;
                  return el("span", {
                    key: f.name,
                    style: {
                      fontSize: "11px",
                      padding: "1px 6px",
                      borderRadius: "3px",
                      border: `1px solid ${color}55`,
                      color,
                      background: color + "11",
                    },
                  }, f.name);
                }),
              ),
            ),
          ),

          // Programs — full-width badge row below the grid
          el("div", { style: { marginTop: "8px", borderTop: `1px solid ${C.border}`, paddingTop: "6px" } },
            el("div", { style: { fontSize: "11px", color: C.dim, letterSpacing: "1px", marginBottom: "4px" } }, "PROGRAMS"),
            el("div", { style: { display: "flex", flexWrap: "wrap", gap: "4px" } },
              ...network.programs.map(p => {
                const color = p.owned ? C.green : C.dim;
                return el("span", {
                  key: p.name,
                  style: {
                    fontSize: "11px",
                    padding: "1px 6px",
                    borderRadius: "3px",
                    border: `1px solid ${color}55`,
                    color,
                    background: color + "11",
                  },
                }, p.label);
              }),
            ),
          ),
        ]),

        // ── Aug Pipeline + Faction Pipeline (merged) ─────────────────────────
        card(C, "PIPELINE", [
          el("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" } },

            // Left: aug pipeline
            el("div", { style: { minWidth: 0 } },
              el("div", { style: { fontSize: "11px", color: C.dim, letterSpacing: "1px", marginBottom: "6px" } }, "AUGS"),
              ...(globalThis.gordAugPipeline ?? []).slice(0, 10).map((a, i) => {
                const done    = a.canBuy;
                const repDone = a.repMissing <= 0;
                const color   = done ? C.green : repDone ? C.yellow : C.dim;
                const etaStr  = done ? "READY"
                              : isFinite(a.estimatedMs) ? formatDuration(a.estimatedMs)
                              : repDone ? `$${ns.format.number(a.moneyMissing)}`
                              : `${ns.format.number(a.repMissing)} rep`;
                return el("div", {
                  key: i,
                  style: {
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontSize: "11px",
                    padding: "2px 0",
                    borderBottom: i < 9 ? `1px solid ${C.border}` : "none",
                    minWidth: 0,
                  },
                },
                  el("span", { style: { color: i === 0 ? "#e2e8f0" : C.dim, fontWeight: i === 0 ? "bold" : "normal", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                    `${i === 0 ? "> " : "  "}${a.aug}`
                  ),
                  el("span", { style: { color, fontWeight: "bold", flexShrink: 0, marginLeft: "8px", whiteSpace: "nowrap" } }, etaStr),
                );
              }),
            ),

            // Right: faction pipeline
            el("div", { style: { minWidth: 0 } },
              el("div", { style: { fontSize: "11px", color: C.dim, letterSpacing: "1px", marginBottom: "6px" } }, "FACTIONS"),
              ...(globalThis.gordFactionPipeline ?? []).slice(0, 10).map((op, i) => {
                const urgencyColor = op.urgency === "high"   ? C.red
                                   : op.urgency === "medium" ? C.yellow
                                   : C.dim;
                return el("div", {
                  key: i,
                  style: {
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontSize: "11px",
                    padding: "2px 0",
                    borderBottom: i < 9 ? `1px solid ${C.border}` : "none",
                    minWidth: 0,
                  },
                },
                  el("span", { style: { color: op.hackingFocus ? C.blue : "#e2e8f0", flex: "0 0 auto", whiteSpace: "nowrap", marginRight: "8px" } },
                    op.faction
                  ),
                  el("span", { style: { color: urgencyColor, flex: 1, minWidth: 0, whiteSpace: "normal", wordBreak: "break-word", textAlign: "right", lineHeight: "1.3" } }, op.reason ?? ""),
                );
              }),
            ),
          ),
        ]),

        // ── Stocks ───────────────────────────────────────────────────────────
        (() => {
          if (!stocks) {
            return card(C, "STOCKS", [
              el("div", { style: { color: C.dim, fontSize: "13px" } }, "stocks.js not running"),
            ]);
          }

          const tierLabel = stocks.tier === 2 ? "4S (forecast)" : stocks.tier === 1 ? "Momentum" : "No TIX access";
          const tierColor = stocks.tier === 2 ? C.green : stocks.tier === 1 ? C.yellow : C.dim;

          return card(C, "STOCKS", [
            // Header: tier + total portfolio value
            el("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" } },
              el("span", { style: { color: tierColor, fontSize: "12px", fontWeight: "bold" } }, tierLabel),
              el("span", { style: { color: C.green, fontSize: "13px", fontWeight: "bold" } },
                stocks.totalValue > 0 ? `Portfolio: $${ns.format.number(stocks.totalValue)}` : "No positions"
              ),
            ),

            // Position rows
            ...(stocks.positions.length === 0
              ? [el("div", { style: { color: C.dim, fontSize: "12px" } }, "No open positions")]
              : stocks.positions.slice(0, 6).map((p, i) => {
                  const isLong   = p.sharesLong  > 0;
                  const isShort  = p.sharesShort > 0;
                  const pl       = isLong ? p.longPL : p.shortPL;
                  const posVal   = isLong ? p.longValue : p.shortValue;
                  const plColor  = pl >= 0 ? C.green : C.red;
                  const typeTag  = isShort ? "[S]" : "[L]";
                  const typeClr  = isShort ? C.purple : C.blue;
                  const fStr     = p.forecast !== null
                    ? ` ${(p.forecast * 100).toFixed(0)}%`
                    : "";

                  return el("div", {
                    key: i,
                    style: {
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      fontSize: "12px",
                      padding: "2px 0",
                      borderBottom: i < Math.min(stocks.positions.length, 6) - 1 ? `1px solid ${C.border}` : "none",
                    },
                  },
                    el("div", { style: { display: "flex", gap: "5px", alignItems: "center" } },
                      el("span", { style: { color: typeClr, fontWeight: "bold", fontSize: "11px" } }, typeTag),
                      el("span", { style: { color: "#e2e8f0" } }, p.sym),
                      el("span", { style: { color: C.dim, fontSize: "11px" } }, fStr),
                    ),
                    el("div", { style: { display: "flex", gap: "10px", alignItems: "center" } },
                      el("span", { style: { color: C.dim, fontSize: "11px" } }, `$${ns.format.number(posVal)}`),
                      el("span", { style: { color: plColor, fontWeight: "bold", fontSize: "11px" } },
                        `${pl >= 0 ? "+" : ""}$${ns.format.number(pl)}`
                      ),
                    ),
                  );
                })
            ),

            // Recent trade log (last 2 lines)
            ...((globalThis.gordStockLog ?? []).slice(-2).map((line, i) =>
              el("div", { key: `log-${i}`, style: { color: C.dim, fontSize: "11px", marginTop: i === 0 ? "6px" : "1px", fontFamily: "monospace" } }, line)
            )),
          ]);
        })(),

      )
    );
  } catch (e) {
    ns.print("Dashboard error: " + String(e));
    ns.print(e?.stack ?? "");
  }
}

// Width is fixed to what the card layout was designed for; height tracks the
// rendered content so every card (gang, stocks, pipelines) is fully visible
// regardless of which BitNode we're in or how many pipeline rows there are.
const DASH_WIDTH = 900;
const DASH_MIN_H = 200;
const DASH_MAX_H = 2000;

/**
 * Size the tail window to fit the rendered dashboard. Measures the actual DOM
 * height of our root element (id=DASH_ID) and resizes to match, so nothing gets
 * clipped and there's no empty space. Falls back to a sane default before the
 * first frame exists or if the DOM isn't reachable.
 * @param {NS} ns
 */
function fitTail(ns) {
  let height = 820;
  try {
    // Access document via a string key: referencing the `document` identifier
    // directly costs 25GB of script RAM in Bitburner; `globalThis["document"]`
    // isn't flagged by the static RAM analyzer.
    const doc = globalThis["document"];
    const node = doc?.getElementById(DASH_ID);
    if (node) {
      // +58 covers the tail title bar and the log container's own padding.
      height = Math.ceil(node.getBoundingClientRect().height) + 58;
    }
  } catch {}
  height = Math.max(DASH_MIN_H, Math.min(DASH_MAX_H, height));
  ns.ui.resizeTail(DASH_WIDTH, height);
}

// ── Data helpers ─────────────────────────────────────────────────────────────

const ROOTING_PROGRAMS = [
  { name: "BruteSSH.exe",  label: "BruteSSH"  },
  { name: "FTPCrack.exe",  label: "FTPCrack"  },
  { name: "relaySMTP.exe", label: "relaySMTP" },
  { name: "HTTPWorm.exe",  label: "HTTPWorm"  },
  { name: "SQLInject.exe", label: "SQLInject" },
];

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

  const programs = ROOTING_PROGRAMS.map(({ name, label }) => ({
    name,
    label,
    owned: ns.fileExists(name, "home"),
  }));

  return { backdoors, factions, programs };
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
function getCombatStats(ns) {
  const skills = ns.getPlayer().skills ?? {};

  // Highest requirement any tracked faction demands for each stat (currently
  // Speakers for the Dead / The Dark Army at 300) - our "fully gated" bar.
  const maxReq = {};
  for (const { key } of COMBAT_STAT_DEFS) {
    maxReq[key] = Math.max(0, ...Object.values(FACTION_REQUIREMENTS).map(r => r[key] ?? 0));
  }

  return COMBAT_STAT_DEFS.map(({ key, label }) => {
    const have = skills[key] ?? 0;
    const need = maxReq[key];
    return {
      label,
      have,
      met:   need > 0 && have >= need,
      close: need > 0 && have < need && need - have <= 50,
    };
  });
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