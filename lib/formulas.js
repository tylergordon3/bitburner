// lib/formulas.js
//
// Thin, RAM-cheap wrapper around Bitburner's Formulas API (ns.formulas.*), with a
// built-in safeguard: every function degrades gracefully when Formulas.exe is not
// present, so callers can prefer the exact formula math and fall back to the
// approximate ns.* analysis functions without any branching of their own.
//
// ── Why the safeguard exists ─────────────────────────────────────────────────
// ns.formulas throws unless `Formulas.exe` sits on home (see
// NetscriptDefinitions.d.ts: "You need Formulas.exe on your home computer to use
// this API"). SF-5 ("start with Formulas.exe") and BN-5 itself both grant the exe,
// so with our SF-5 we normally have it from the start of every node. But it is
// still a FILE, not an unconditional capability: there's a documented edge case
// where it's briefly absent at the very start of BN-5 until a soft reset
// (danielyxie/bitburner#2675), and any node entered without adequate SF-5 won't
// have it. hasFormulas() detects the exe at runtime so callers use the exact path
// when it's present and the approximate fallback when it isn't - a no-op in the
// normal case, insurance in the edge cases.
//
// ── Why these helpers are worth it ───────────────────────────────────────────
// The plain ns analysis functions read the target's CURRENT state:
//   - ns.hackAnalyze  → hack % at the server's current security
//   - ns.growthAnalyze→ grow threads ignoring security entirely (a documented
//                        approximation)
//   - ns.getHackTime  → time at current security
// But an HGW batch is fired at a PREPPED server (min security, max money). The
// Formulas API lets us compute every quantity at that prepped state instead, so
// thread counts and batch timings match what the scripts will actually hit -
// fewer wasted grow threads, tighter batches, better target selection.
//
// ── RAM ──────────────────────────────────────────────────────────────────────
// ns.formulas.* and ns.formulas.mockServer() cost 0GB (the API gates on the exe,
// not on RAM). The only real cost this module adds to an importer is ns.getPlayer
// (0.5GB) and ns.getServerGrowth (0.05GB); the other getters it uses (max money,
// min security, required hacking level) are already paid for by the botnet
// manager, its only importer today.

import { CONFIG } from "./config.js";

const HOME = CONFIG.paths.home;

// ── Formulas.exe detection ────────────────────────────────────────────────────
// The answer is cached, and re-checked on a throttle so fileExists stays out of
// the per-tick hot path - in BOTH directions. A positive result used to be kept
// for good ("once present within a node the exe never disappears"), but this
// cache is not per node: module variables live as long as the page does (the
// game reuses a compiled module for identical source, across installs and
// BitNodes), while the exe does not - an install or a new node wipes home's
// programs, and without SF5 (or with it disabled in the BitNode options)
// nothing puts Formulas.exe back. A stale `true` there means every caller's
// ns.formulas call throws instead of taking its fallback.
let _has = false;
let _checkedAt = 0;
const RECHECK_MS = 5_000;

/** @param {NS} ns @returns {boolean} true while Formulas.exe is on home. */
export function hasFormulas(ns) {
  const now = Date.now();
  // (now < _checkedAt: the clock went backwards - check again.)
  if (now >= _checkedAt && now - _checkedAt < RECHECK_MS) return _has;
  _checkedAt = now;
  _has = ns.fileExists("Formulas.exe", HOME);
  return _has;
}

// ── Player snapshot ───────────────────────────────────────────────────────────
// getPlayer is 0.5GB and its stats barely move within a tick, so cache it behind
// a short TTL: callers never touch the player object, and a whole tick of batch
// sizing + target scoring pays for at most one getPlayer.
let _player = null;
let _playerAt = 0;
const PLAYER_TTL_MS = 200;

/** @param {NS} ns */
function player(ns) {
  const now = Date.now();
  if (!_player || now - _playerAt > PLAYER_TTL_MS) {
    _player = ns.getPlayer();
    _playerAt = now;
  }
  return _player;
}

// ── Prepped-server snapshot ───────────────────────────────────────────────────
// A Server object describing `host` AS IF fully prepped: at minimum security and
// max money - the state a batch is actually fired against. Built off mockServer()
// (a full, correctly-shaped Server) so no field the formulas read is ever
// missing; only the fields that matter are overwritten with the host's real
// values. Callers must have checked hasFormulas() first.
//
// hasAdminRights is one of those fields, and it is the trap here. mockServer()
// returns it FALSE, and the game's hacking-chance formula opens with "unrooted or
// unhackable server -> return 0" - so every hackChance() through this module came
// back exactly 0, silently. Nothing threw; the botnet's target scores were all
// multiplied by zero, no target ever ranked, and the manager sat idle (before it
// said so, it fell back to a hardcoded n00dles - which is what "the botnet only
// ever hacks n00dles" turned out to be). We only ever describe servers we've
// rooted, so this is true by construction for every caller.
/** @param {NS} ns @param {string} host */
function preppedServer(ns, host) {
  const s = ns.formulas.mockServer();
  s.hostname = host;
  s.hasAdminRights = true;                             // see above - NOT the mock's default
  s.moneyMax = ns.getServerMaxMoney(host);
  s.moneyAvailable = s.moneyMax;                       // prepped: full money
  s.minDifficulty = ns.getServerMinSecurityLevel(host);
  s.hackDifficulty = s.minDifficulty;                  // prepped: min security
  s.requiredHackingSkill = ns.getServerRequiredHackingLevel(host);
  s.serverGrowth = ns.getServerGrowth(host);
  return s;
}

// ── Exact hacking math at the prepped state ───────────────────────────────────

/**
 * Fraction of the target's money a single hack thread steals, at min security.
 * Formulas analogue of ns.hackAnalyze, but evaluated at the prepped state a batch
 * actually hits rather than the server's current (possibly elevated) security.
 * @param {NS} ns @param {string} host
 */
export function hackPercent(ns, host) {
  return ns.formulas.hacking.hackPercent(preppedServer(ns, host), player(ns));
}

/**
 * Exact grow threads (1 core) to bring the target from `currentFraction` of max
 * money back to full, at min security - the grow leg of an HGW batch. Formulas
 * analogue of ns.growthAnalyze, but security-aware and exact rather than the
 * approximate multiplier inversion.
 * @param {NS} ns @param {string} host
 * @param {number} currentFraction  money remaining after the hack, as a fraction of max
 * @param {number} [security]       evaluate at this security instead of the minimum -
 *        prep sizing passes the CURRENT security, since its grow legs run before
 *        the weaken that accompanies them lands
 */
export function growThreadsToFull(ns, host, currentFraction, security) {
  const s = preppedServer(ns, host);
  s.moneyAvailable = s.moneyMax * currentFraction;
  if (security !== undefined) s.hackDifficulty = Math.max(s.minDifficulty, security);
  return ns.formulas.hacking.growThreads(s, player(ns), s.moneyMax, 1);
}

/** @param {NS} ns @param {string} host - success chance of a hack at min security. */
export function hackChance(ns, host) {
  return ns.formulas.hacking.hackChance(preppedServer(ns, host), player(ns));
}

/**
 * H/G/W durations at the prepped (min-security) state, which is what a batch's
 * legs run against once prep() has finished - more accurate than ns.get*Time at
 * the server's current security.
 * @param {NS} ns @param {string} host
 */
export function batchTimes(ns, host) {
  const s = preppedServer(ns, host);
  const p = player(ns);
  return {
    hackTime: ns.formulas.hacking.hackTime(s, p),
    growTime: ns.formulas.hacking.growTime(s, p),
    weakenTime: ns.formulas.hacking.weakenTime(s, p),
  };
}
