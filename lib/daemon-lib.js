// lib/daemon-lib.js
//
// Shared core for the per-BitNode daemons (bn2/bn3/bn4/bn5/bn10). Everything in
// here was, at some point, copy-pasted into every daemon; hoisting it means a fix
// lands in all five at once instead of in whichever one you remembered.
//
// What lives here is the machinery that is genuinely identical everywhere: rooting
// and darkweb purchases, accepting invites, placing off-home helpers, the gang
// manager's placement, faction work, buying augs, the install policy, and the
// purchased-server budget. What each daemon still owns is the part that actually
// differs - decideNextPriority (the node's strategy), maybeSetupGang (BN2's -9
// shortcut vs BN5's active karma grind vs everyone else's passive snap-up),
// plannedNextBN, and main()'s wiring.
//
// Where a node used to differ only by an ACCIDENT of when the code was copied, the
// merged version takes the most capable variant - so every node now records its
// faction work for the sleeve manager, skips its gang's faction when banking
// secondary rep, and has RAM held for the gang manager (as, since, for every
// required helper that finds no room - see "Room for a required helper").
//
// RAM note: importing these instead of inlining them does NOT change a daemon's
// RAM cost (Bitburner sums Netscript calls across the whole import closure either
// way). The RAM savings come from the off-home helper scripts (lib/backdoor.js,
// lib/econ.js, lib/sleeves.js, ...) that each daemon exec's, not from this file.

import { allServers, root } from "./net.js";
import { shouldJoinCityFaction, factionRepStillUseful, favorAfterInstall } from "./aug-targets.js";
import { managePurchasedServers } from "./pserv.js";
import { shouldFocus, focusFlag, recordFactionWork } from "./player-actions.js";
import { CONFIG } from "./config.js";
import { emitEvent } from "./events.js";
import { toggleEnabled } from "./toggles.js";
import { playerMoney, hackingLevel, inGangSafe, freeRam } from "./ns-utils.js";
import { hasFormulas } from "./formulas.js";
import { campaignStep, heldAchievements } from "./capabilities.js";

// Re-exported so the daemons and lib/daemon-core.js keep one import for the
// daemon building blocks.
export { playerMoney, hackingLevel, inGangSafe, freeRam };

const HOME = CONFIG.paths.home;
// CONFIG (not forNode) is correct for infra and for the aug NAMES read off AUGS
// (neuroFlux, redPill, installPriority): no BITNODE entry overrides those. The
// install POLICY is different - BITNODE[7] and [9] override augs.install - so
// maybeInstall takes it from the daemon's forNode() config instead of from here.
// tests/config-captures.test.mjs fails if a module-scope CONFIG capture is used
// to read a key some BITNODE entry overrides.
const AUGS = CONFIG.augs;
const INFRA = CONFIG.infra;

/** Last time ensureHelper warned about each script it couldn't place. */
const _helperWarnedAt = new Map();

// ── The daemon tick's one view of the network ────────────────────────────────
//
// Every helper check used to walk the network itself (allServers: one ns.scan
// per server) and then ask hasRootAccess + scriptRunning of every host - twenty
// odd checks a tick, each a few hundred ns calls, all in one burst. The daemon
// now opens a TICK (beginHelperTick, which is also the rooting pass), and every
// check until closeHelperTick shares its walk, its list of rooted hosts and its
// answers to "is script X running anywhere".
//
// What a tick holds, and why none of it can go stale in a way that matters:
//   - the walk and the rooted list are this tick's (a host rooted or bought
//     later in the tick is simply first used on the next one - except a
//     manager's dedicated host, which placeManager adds by hand);
//   - "X runs on host H" is remembered for the tick, and is kept current by the
//     launches and kills made through this file. "X runs nowhere" is forgotten
//     whenever the daemon yields (helperTickYielded), since anything may have
//     started it meanwhile;
//   - free RAM is never remembered: it is read at each placement.
// A caller with no tick open (a test, a tool) gets a throwaway one per call,
// which is exactly the old behaviour.
//
// Module state outlives the process (the game caches a module by its source),
// so the open tick is keyed by the `ns` object that opened it - a tick left
// behind by a daemon that died mid-loop is never used by the next one - and
// _seenOn is only ever a HINT about where to look first, confirmed by a live
// scriptRunning against a host from this tick's walk before it is believed.

/** @param {string} script - a CONFIG.paths name or an ns.ps one; same key either way */
const bare = script => String(script).replace(/^\/+/, "");

// "Does it fit" is asked of sums and differences of two-decimal GB figures, and
// a hold makes the EXACT fit the normal case rather than a coincidence: the
// batcher leaves precisely what was asked for. Without a tolerance, 64 - 43.98
// = 20.019999999999996 would never hold a 20.02GB helper. Far inside the game's
// own slack (exec accepts up to 0.001GB over).
const RAM_EPSILON = 1e-6;

/** Where each helper was last seen running: the first host asked next time. */
const _seenOn = new Map();

/**
 * @typedef {{script: string, host: string, gb: number, since: number}} HelperHold
 *   RAM asked of the botnet for a required helper that found no room: `gb` kept
 *   free of new legs on `host`, asked for on that host since `since`.
 * @typedef {object} HelperTick
 * @property {NS} ns
 * @property {boolean} open       false for the throwaway tick of a lone call
 * @property {string[]} rooted    every rooted host, in walk order, home first
 * @property {Set<string>} known  the same, as a set
 * @property {Map<string, string | null>} at    script -> host it runs on / null
 * @property {Map<string, number>} sizes        host -> max RAM (read once)
 * @property {Map<string, number>} costs        script -> RAM (read once)
 * @property {HelperHold[]} wants               this tick's holds, in priority order
 * @property {Set<string>} visited              scripts looked at this tick
 * @property {Map<string, HelperHold>} carried  last tick's holds, by script
 * @property {Map<string, string>} placedBefore last tick's script -> host
 * @property {string | null} own                the daemon's own script (pinned on home)
 * @property {Record<string, number>} taken      host -> GB someone else holds for good
 */

/** The open tick, and what the last one left for the next. */
let _tick = /** @type {HelperTick | null} */ (null);
let _carry = /** @type {{ns: any, holds: Map<string, HelperHold>, placed: Map<string, string>} | null} */ (null);

/** @param {NS} ns @param {string[]} rooted @param {boolean} open @returns {HelperTick} */
function newTick(ns, rooted, open) {
  const mine = open && _carry?.ns === ns ? _carry : null;
  return {
    ns, open, rooted, known: new Set(rooted),
    at: new Map(), sizes: new Map(), costs: new Map(),
    wants: [], visited: new Set(),
    carried: mine?.holds ?? new Map(),
    placedBefore: mine?.placed ?? new Map(),
    own: null, taken: {},
  };
}

/** The tick this call belongs to: the daemon's open one, else a throwaway. @param {NS} ns */
function tickFor(ns) {
  if (_tick && _tick.ns === ns) return _tick;
  return newTick(ns, allServers(ns).filter(h => ns.hasRootAccess(h)), false);
}

/**
 * Open the daemon tick: ONE walk of the network, rooting what can be rooted on
 * the way (this is rootEverything), shared by every helper check until
 * closeHelperTick. See the block comment above.
 * @param {NS} ns
 * @param {{own?: string, taken?: Record<string, number>}} [opts]
 *   own - the daemon's script: its RAM on home will never drain, so it is not
 *         counted as room a hold could free
 *   taken - host -> GB that will not drain either, for reasons this file cannot
 *         see (Stanek's charge workers: they never land, and on a host in
 *         their plan they take whatever comes free until the plan is full)
 */
export function beginHelperTick(ns, opts = {}) {
  _tick = newTick(ns, rootEverything(ns), true);
  _tick.own = opts.own ?? null;
  _tick.taken = opts.taken ?? {};
}

/**
 * The daemon yielded (an await that really waits): other scripts ran, so "X is
 * running nowhere" may no longer be true. What we saw running is kept - at
 * worst a helper that died in the gap is relaunched a tick later.
 * @param {NS} ns
 */
export function helperTickYielded(ns) {
  if (_tick?.ns !== ns) return;
  for (const [script, host] of _tick.at) if (host === null) _tick.at.delete(script);
}

/**
 * Close the tick and return what it asks the botnet to keep free: host -> GB,
 * the sum of this tick's holds for required helpers and managers that found no
 * room. The caller publishes it (globalThis.gordReservedRam) - see runDaemon
 * for who else writes that map. The holds are also kept for the next tick,
 * where they keep optional helpers out of the room until its owner is looked
 * at again.
 * @param {NS} ns @returns {Record<string, number>}
 */
export function closeHelperTick(ns) {
  const out = /** @type {Record<string, number>} */ ({});
  const t = _tick;
  if (!t || t.ns !== ns) return out; // not this process's tick to close
  _tick = null;
  for (const w of t.wants) out[w.host] = (out[w.host] ?? 0) + w.gb;
  const placed = new Map();
  for (const [script, host] of t.at) if (host !== null) placed.set(script, host);
  _carry = { ns, holds: new Map(t.wants.map(w => [w.script, w])), placed };
  return out;
}

/**
 * The host `script` is running on, or null. One scriptRunning when it is where
 * it was last seen; one per rooted host when it is not running at all.
 * @param {HelperTick} t @param {string} script @returns {string | null}
 */
function runningOn(t, script) {
  const key = bare(script);
  const known = t.at.get(key);
  if (known !== undefined) return known;
  const hint = _seenOn.get(key);
  let host = null;
  if (hint !== undefined && t.known.has(hint) && t.ns.scriptRunning(script, hint)) host = hint;
  else host = t.rooted.find(h => h !== hint && t.ns.scriptRunning(script, h)) ?? null;
  noteRunning(t, key, host);
  return host;
}

/**
 * Is `script` running on any rooted host? For callers that only need the yes
 * or no: inside the daemon's tick this shares its walk and its answers (a
 * script launched or found earlier in the tick costs no ns call at all).
 * @param {NS} ns @param {string} script
 */
export function helperRunning(ns, script) {
  return runningOn(tickFor(ns), script) !== null;
}

/** @param {HelperTick} t @param {string} key @param {string | null} host */
function noteRunning(t, key, host) {
  t.at.set(key, host);
  if (host === null) _seenOn.delete(key);
  else _seenOn.set(key, host);
}

/**
 * A script's RAM, read once a tick. Asked by its absolute name whichever
 * spelling came in: the tick's keys have no leading slash, and a name without
 * one is the game's to resolve against the calling script's own folder.
 * @param {HelperTick} t @param {string} script
 */
function scriptCost(t, script) {
  const key = bare(script);
  let gb = t.costs.get(key);
  if (gb === undefined) t.costs.set(key, gb = t.ns.getScriptRam(`/${key}`, HOME));
  return gb;
}

/** @param {HelperTick} t @param {string} host */
function hostSize(t, host) {
  let gb = t.sizes.get(host);
  if (gb === undefined) t.sizes.set(host, gb = t.ns.getServerMaxRam(host));
  return gb;
}

/**
 * Rooted, non-reserved, non-home hosts with any RAM, roomiest first - the
 * candidate list every off-home placement starts from - with the free RAM that
 * ordered them (read here, now: nothing else runs before the launch).
 * @param {HelperTick} t @param {Set<string>} reserved @param {string[]} [exclude]
 * @returns {{host: string, free: number}[]}
 */
function offHomeHosts(t, reserved, exclude = []) {
  const out = [];
  for (const host of t.rooted) {
    if (host === HOME || exclude.includes(host) || reserved.has(host)) continue;
    const max = t.ns.getServerMaxRam(host);
    if (max > 0) out.push({ host, free: max - t.ns.getServerUsedRam(host) });
  }
  return out.sort((a, b) => b.free - a.free);
}

/**
 * Launch `script` on the first of `candidates` with room for it (home keeps
 * CONFIG.helpers.homeHeadroom free for the daemon's own work), leaving alone
 * whatever is held there for a helper that outranks it (heldAgainst). Returns
 * the host it started on (or null), and - when it started nowhere - the host
 * that HAD the room but where the game refused the launch, if there was one:
 * RAM is not what that helper is waiting for, so none is held for it.
 * Shared by ensureHelper and placeManager.
 *
 * Copies every source file, not just the entry script: Bitburner resolves a
 * script's imports from the host it runs on, so the whole module closure has to
 * be present. Files cost no RAM, so shipping them all is simplest/safest.
 * @param {HelperTick} t @param {string} script @param {number} ram
 * @param {{host: string, free?: number}[]} candidates - free: already read this instant
 * @param {any[]} args @param {boolean} optional
 * @returns {{host: string | null, refusedOn: string | null}}
 */
function launchOnFirstFit(t, script, ram, candidates, args, optional) {
  const ns = t.ns;
  const key = bare(script);
  const carried = [...t.carried.values()].filter(w => !t.visited.has(w.script));
  let refusedOn = null;
  for (const { host, free } of candidates) {
    const headroom = host === HOME ? CONFIG.helpers.homeHeadroom : 0;
    const held = heldAgainst(key, host, optional, t.wants, carried);
    if ((free ?? freeRam(ns, host)) - headroom - held < ram - RAM_EPSILON) continue;
    if (host !== HOME) ns.scp(ns.ls(HOME, ".js"), host, HOME);
    if (ns.exec(script, host, 1, ...args)) {
      ns.print(`Started ${script} on ${host}`);
      noteRunning(t, key, host);
      return { host, refusedOn: null };
    }
    refusedOn ??= host;
  }
  return { host: null, refusedOn };
}

// ── Room for a required helper that found none ───────────────────────────────
//
// The batcher (hacking/manager.js) fills every free GB on every host, and
// replaces its legs as fast as they land, so a helper that did not fit on the
// tick it was first wanted - a gang formed mid-run, the 32GB finisher, anything
// restarted after a sync - could wait for a gap indefinitely. A REQUIRED helper
// (optional: false) or manager (placeManager) now asks for its room instead: a
// hold of its size on one host, which the daemon publishes in
// globalThis.gordReservedRam; the batcher stops launching new legs into that
// much of the host (reservedRamFor), the legs already there land, and the
// helper is placed on a later tick. This is what early/driver.js already did
// for its boot scripts (holdHost), carried into the daemon phase.
//
// The rules, all decided by the pure functions below:
//   - Rebuilt from nothing every tick. A hold exists only while its helper was
//     looked at THIS tick and found no room; placed, no longer wanted, or the
//     daemon gone, and it is not asked for again.
//   - One host per helper, and the same one every tick (or it would never
//     drain): the manager's dedicated host if it has one, else the smallest
//     host that can hold it, home last. Only on a host that could actually
//     free that much - what the daemon and the helpers already running there
//     occupy never lands. If the room still has not come after
//     helpers.holds.moveOnMs (something we cannot see is sitting there), the
//     next host in the same order gets its turn.
//   - Bounded: the first helper in the launch order that needs one always gets
//     its hold (never more than it will occupy once placed); further holds are
//     added only while all of them together stay within
//     helpers.holds.maxFraction of the RAM that could be freed at all. Past
//     that the helpers further down the order wait for the ones ahead to be
//     placed - runDaemon's launch order is the priority order.
//   - A helper bigger than every host gets no hold (there is nothing to drain
//     toward), just the warning.
//   - Nobody may launch into room held for a helper that outranks it: every
//     helper leaves this tick's holds alone (they were asked for by helpers
//     earlier in the order), and an OPTIONAL one also leaves last tick's holds
//     alone until their owners have been looked at again.

/**
 * How much of `host`'s free RAM is spoken for by helpers that outrank `script`.
 * Pure.
 * @param {string} script @param {string} host @param {boolean} optional
 * @param {{script: string, host: string, gb: number}[]} wants - this tick's holds so far
 * @param {{script: string, host: string, gb: number}[]} carried - last tick's holds whose
 *   owners have not been looked at yet this tick; they bind optional helpers only
 *   (a required one outranks every required helper still to come)
 */
export function heldAgainst(script, host, optional, wants, carried) {
  let gb = 0;
  for (const w of wants) if (w.host === host && w.script !== script) gb += w.gb;
  if (optional) for (const w of carried) if (w.host === host && w.script !== script) gb += w.gb;
  return gb;
}

/**
 * The most RAM (GB) that may be on hold at once: `maxFraction` of what the
 * hosts could free between them. Pure.
 * @param {{max: number, pinned?: number}[]} hosts @param {number} maxFraction
 */
export function holdBudget(hosts, maxFraction) {
  return maxFraction * hosts.reduce((sum, h) => sum + Math.max(0, h.max - (h.pinned ?? 0)), 0);
}

/**
 * The host to keep `want.ram` GB free on for a helper that found no room, or
 * null when it gets no hold: nothing could ever free that much, or the tick's
 * hold budget is spent. Pure.
 *
 * Order: `want.prefer` (a manager's dedicated host), then the off-home hosts
 * from the smallest drainable size up (the botnet loses the least, and the big
 * hosts stay whole for bigger helpers), by name on a tie, then home. A host
 * counts only if max - pinned - what is already held there covers the helper.
 * The previous answer is kept while it still qualifies, so the host drains;
 * after `moveOnMs` without the helper having been placed the next host in the
 * order takes over (round and round, if need be).
 *
 * @param {{ram: number, prefer?: string | null, prev?: {host: string, since: number} | null}} want
 * @param {{host: string, max: number, pinned?: number, last?: boolean}[]} hosts
 *   pinned - GB there that will never land (the daemon, running helpers, home's
 *   headroom); last - home, tried after everything else
 * @param {Record<string, number>} held - GB already held per host this tick
 * @param {{now: number, budget: number, moveOnMs: number}} o
 *   budget - GB of hold still allowed this tick
 * @returns {{host: string, since: number} | null}
 */
export function helperHoldHost(want, hosts, held, o) {
  if (!(want.ram > 0) || want.ram > o.budget) return null;
  const room = h => h.max - (h.pinned ?? 0);
  const rank = h => (h.host === want.prefer ? 0 : h.last ? 2 : 1);
  const fits = hosts
    .filter(h => room(h) - (held[h.host] ?? 0) >= want.ram - RAM_EPSILON)
    .sort((a, b) => rank(a) - rank(b) || room(a) - room(b) || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
  if (!fits.length) return null;

  const at = want.prev ? fits.findIndex(h => h.host === want.prev.host) : -1;
  if (at < 0) return { host: fits[0].host, since: o.now };
  if (o.now - want.prev.since < o.moveOnMs) return { host: want.prev.host, since: want.prev.since };
  return { host: fits[(at + 1) % fits.length].host, since: o.now };
}

/**
 * Ask for room for a required helper or manager that could not be placed: pick
 * the host (helperHoldHost) and add the hold to the tick. Only inside an open
 * daemon tick - a lone call has nobody to publish for it. Returns a clause for
 * the warning: what is held, or why nothing is.
 * @param {HelperTick} t @param {string} script @param {number} ram @param {Set<string>} reserved
 * @param {{prefer?: string, homeSlack?: number}} [o]
 */
function requestHold(t, script, ram, reserved, o = {}) {
  if (!t.open || !(ram > 0)) return "";
  const key = bare(script);
  const mine = t.wants.find(w => w.script === key);
  if (mine) return `${t.ns.format.ram(mine.gb)} held on ${mine.host}`;

  // What will never land, per host: the helpers known to be running there
  // (this tick's answers, and last tick's for those not yet looked at), the
  // daemon itself, what the caller says is taken for good, and the headroom a
  // helper must leave on home.
  const pinned = /** @type {Record<string, number>} */ ({});
  const pin = (host, gb) => { pinned[host] = (pinned[host] ?? 0) + gb; };
  for (const [s, host] of t.placedBefore) if (!t.at.has(s)) pin(host, scriptCost(t, s));
  for (const [s, host] of t.at) if (host !== null) pin(host, scriptCost(t, s));
  for (const [host, gb] of Object.entries(t.taken)) if (gb > 0) pin(host, gb);
  if (t.own) pin(HOME, scriptCost(t, t.own));
  pin(HOME, CONFIG.helpers.homeHeadroom);

  const hosts = t.rooted
    .filter(h => !reserved.has(h))
    .map(h => ({ host: h, max: hostSize(t, h), pinned: pinned[h] ?? 0, last: h === HOME }))
    .filter(h => h.max > 0);
  const P = CONFIG.helpers.holds;
  const held = /** @type {Record<string, number>} */ ({});
  let total = 0;
  for (const w of t.wants) {
    held[w.host] = (held[w.host] ?? 0) + w.gb;
    total += w.gb;
  }
  // On home the batcher keeps hacking.reserveHomeRam free besides the hold, and
  // a helper needs helpers.homeHeadroom left over: ask for the difference too.
  const homeExtra = Math.max(0, CONFIG.helpers.homeHeadroom - CONFIG.hacking.reserveHomeRam) + (o.homeSlack ?? 0);
  // The budget decides how many holds may pile up, not whether the first helper
  // in the order gets one: that one is always asked for (it is at most what the
  // helper will occupy anyway), or a small network could never place it.
  const budget = t.wants.length ? holdBudget(hosts, P.maxFraction) - total : Infinity;
  const pick = helperHoldHost(
    { ram, prefer: o.prefer ?? null, prev: t.carried.get(key) ?? null },
    hosts, held,
    { now: Date.now(), budget, moveOnMs: P.moveOnMs },
  );
  if (!pick) {
    const largest = hosts.reduce((m, h) => Math.max(m, h.max - h.pinned), 0);
    return largest < ram
      ? `nothing held: no host can free that much (the largest ${t.ns.format.ram(Math.max(0, largest))})`
      : `nothing held: ${t.ns.format.ram(total)} is already held for helpers ahead of it`;
  }
  const gb = ram + (pick.host === HOME ? homeExtra : 0);
  t.wants.push({ script: key, host: pick.host, gb, since: pick.since });
  return `${t.ns.format.ram(gb)} held on ${pick.host}`;
}

/**
 * Ensure a persistent helper is running SOMEWHERE with enough RAM - not just on
 * home. globalThis is shared across every host in Bitburner, so these helpers
 * work fine on any rooted server; running them off-home keeps scarce home RAM
 * for the daemon. We prefer the roomiest off-home host and only fall back to
 * home as a last resort. A REQUIRED helper that finds no room warns (it doesn't
 * fail silently) and, inside the daemon's tick, has room held for it (see "Room
 * for a required helper" above); { optional: true } marks a luxury script,
 * which waits quietly for RAM and never takes what is held for a required one.
 * Extra exec args can be forwarded via { args } (e.g. the next BitNode +
 * callback script for lib/backdoor.js).
 * @param {NS} ns @param {string} script @param {{optional?: boolean, args?: any[]}} [opts]
 */
export function ensureHelper(ns, script, opts = {}) {
  const t = tickFor(ns);
  const optional = !!opts.optional;
  t.visited.add(bare(script));

  // Already running anywhere (home included)? Leave it be.
  if (runningOn(t, script)) return;

  const ram = scriptCost(t, script);
  const reserved = globalThis.gordReservedHosts instanceof Set ? globalThis.gordReservedHosts : new Set();

  // Roomiest rooted non-home host first; home last (keep it for the daemon).
  const tried = launchOnFirstFit(t, script, ram, [...offHomeHosts(t, reserved), { host: HOME }], opts.args ?? [], optional);
  if (tried.host) return;

  if (!optional) {
    const held = tried.refusedOn
      ? `nothing held: ${tried.refusedOn} had the room and the game would not start it there`
      : requestHold(t, script, ram, reserved);
    // Surface it. A required helper that can't find RAM used to fail into a
    // per-tick ns.print nobody reads - which is exactly how lib/backdoor.js went
    // an entire run without installing a single backdoor. Throttled so the
    // journal gets one line every helperWarnMs, not one every tick.
    const msg = `no host has ${ns.format.ram(ram)} free for ${script} (home ${ns.format.ram(freeRam(ns, HOME))} free)` +
      (held ? ` - ${held}` : "");
    ns.print(`WARN: ${msg}`);
    const last = _helperWarnedAt.get(script) ?? 0;
    if (Date.now() - last >= CONFIG.helpers.warnMs) {
      _helperWarnedAt.set(script, Date.now());
      emitEvent(`[!] ${msg}`, "sys");
    }
  }
}

/**
 * The AUTO-FINISH preference: true (the default) means the daemon may destroy
 * w0r1d_d43m0n once everything's backdoored, false means it does everything else
 * exactly as normal but leaves the world daemon standing.
 *
 * Persisted (lib/toggles.js) more carefully than most settings would warrant,
 * because the thing it holds back is irreversible and unattended: an aug install
 * wipes globalThis, and a toggle that quietly reverted to ON could beat the node
 * hours later while the player is away.
 * @param {NS} ns
 */
export function autoFinishEnabled(ns) {
  return toggleEnabled(ns, { key: "gordAutoFinish", file: CONFIG.paths.autoFinishFile });
}

/**
 * Stop the finisher if it's running. Needed because the toggle can be flipped AFTER
 * lib/finish-bn.js was launched, and that script loops waiting for its moment - so
 * leaving it alive would beat the node anyway, several ticks after the player told
 * us not to.
 * @param {NS} ns
 */
function stopFinisher(ns) {
  const t = tickFor(ns);
  const key = bare(CONFIG.paths.finishBn);
  if (t.at.get(key) === null) return; // already swept (or seen absent) this tick
  // Every host, not just the one the tick remembers: this has to catch a second
  // copy too.
  for (const host of t.rooted) {
    if (!ns.scriptRunning(CONFIG.paths.finishBn, host)) continue;
    ns.scriptKill(CONFIG.paths.finishBn, host);
    ns.print(`Auto-finish held - stopped ${CONFIG.paths.finishBn} on ${host}.`);
  }
  noteRunning(t, key, null);
}

/**
 * Launch the backdoor helper, and - only once it reports the world daemon ready
 * (rooted, hacking level met), and only if we're actually allowed to finish - the
 * BitNode finisher.
 *
 * These are two scripts rather than one because of RAM: the finisher's
 * destroyW0r1dD43m0n is 32GB, and while they shared a file that whole cost had to
 * be free somewhere before ANY backdoor could be installed. Since backdoors are
 * what unlock CyberSec/NiteSec/The Black Hand/BitRunners, that starvation quietly
 * cost a run its hacking factions. Call this BEFORE the botnet manager in a
 * daemon's tick so the (now small) backdoor loop claims RAM ahead of workers.
 *
 * Two independent things can hold the finish back, and both leave everything else
 * running normally: the NODE'S OWN PLAN (nextBN <= 0 - e.g. BN10, where the point is
 * to stay and finish the sleeve roster) and the HUD's FINISH toggle, which is the
 * player saying "not yet" about any node. Neither hold would mean anything if the
 * bot backdoored w0r1d_d43m0n - a scripted backdoor there opens the BitVerse, which
 * IS the finish - so lib/backdoor.js never does, on any node; it only reports
 * finalReady. A node that must not end by itself also sets backdoor.skipFinalHost
 * (BN10), which makes finalReady permanently false and has the finisher refuse to
 * run at all, so this function never gets as far as launching anything.
 *
 * @param {NS} ns
 * @param {number} node     the current BitNode, passed to lib/backdoor.js as its
 *                          exec arg (so that helper needn't pay 1GB for getResetInfo)
 * @param {number} nextBN   BitNode to enter when the world daemon falls; <= 0 is
 *                          the halt sentinel ("finish by hand").
 * @param {string} [cbScript] script to run in the next node (defaults to the driver).
 */
export function ensureBackdoorHelpers(ns, node, nextBN, cbScript) {
  ensureHelper(ns, CONFIG.paths.backdoor, { args: [node] });

  const autoFinish = autoFinishEnabled(ns);

  // Kill any finisher FIRST, before the gordBackdoorState gate below. That gate
  // exists to decide whether to LAUNCH one, but it guarded the STOP as well, so a
  // finisher already waiting on hacking level went untouched whenever lib/backdoor.js
  // wasn't alive to publish state (RAM starvation, a purchased server churned out
  // from under it, a reload that restored the finisher but not the publisher). The
  // toggle being off is reason enough to stop, always - and lib/finish-bn.js now
  // also refuses to fire on its own if it somehow outlives us.
  if (!autoFinish) stopFinisher(ns);

  // Fresh state only: globalThis outlives installs and BitNode changes, and a
  // "ready" from a helper that is no longer running (or from the last node)
  // must not launch the finisher.
  const state = globalThis.gordBackdoorState;
  if (!state?.finalReady || Date.now() - (state.updatedAt ?? 0) > CONFIG.backdoor.stateStaleMs) return;

  const holdReason = !autoFinish ? "the HUD's FINISH toggle is off"
    : nextBN <= 0 ? "this node's plan is manual BitNode selection"
    : null;

  if (holdReason) {
    stopFinisher(ns);
    // Announce once PER REASON, so flipping the toggle off after the node was
    // already going to auto-continue still says so, instead of staying silent
    // because some earlier hold had claimed the latch.
    if (globalThis.gordAwaitingManualBN !== holdReason) {
      globalThis.gordAwaitingManualBN = holdReason;
      ns.tprint(`${state.finalHost} is ready (rooted, hacking level met), but the finish is on hold: ${holdReason}. Backdoor it yourself to finish, or turn FINISH back on in the HUD.`);
      emitEvent(`[!] ${state.finalHost} ready - holding (${holdReason})`, "sys");
    }
    return;
  }

  globalThis.gordAwaitingManualBN = false;
  const args = cbScript ? [nextBN, cbScript] : [nextBN];
  ensureHelper(ns, CONFIG.paths.finishBn, { args });
}

/**
 * Buy/upgrade a dedicated cloud server to at least `needRam` (rounded up to the
 * next power of two, since purchased servers only come in those sizes). Spends
 * conservatively - at most CONFIG.cloudHost.spendFraction of cash - so it never
 * starves aug/program buys. Returns true once the host exists at sufficient size.
 * Shared by the corp/gang cloud-manager placement (see placeManager).
 * @param {NS} ns
 */
export function provisionCloudHost(ns, name, needRam) {
  const cloud = ns.cloud;
  if (cloud.getServerLimit() <= 0) return false;

  const maxRam = cloud.getRamLimit();
  let size = CONFIG.cloudHost.minRam;
  while (size < needRam && size < maxRam) size *= 2;
  if (size < needRam) return false; // even the largest tier can't hold it

  const exists = ns.serverExists(name);
  if (exists && ns.getServerMaxRam(name) >= needRam) return true;

  const budget = playerMoney(ns) * CONFIG.cloudHost.spendFraction;

  if (!exists) {
    if (cloud.getServerNames().length >= cloud.getServerLimit()) return false;
    if (cloud.getServerCost(size) > budget) return false;
    if (cloud.purchaseServer(name, size)) {
      ns.tprint(`Provisioned ${name} (${ns.format.ram(size)}).`);
      return true;
    }
    return false;
  }

  const cost = cloud.getServerUpgradeCost(name, size);
  if (cost < 0 || cost > budget) return false;
  if (cloud.upgradeServer(name, size)) {
    ns.tprint(`Upgraded ${name} -> ${ns.format.ram(size)}.`);
    return true;
  }
  return false;
}

/**
 * Place one big, persistent manager (corp or gang). If it's already running
 * anywhere, just note whether it's on its dedicated host (so we can reserve it
 * from the botnet). Otherwise provision the dedicated cloud host and launch it
 * there, falling back to the roomiest off-home host, then home. Adds the
 * dedicated host to `reserved` whenever the manager lives on it.
 *
 * A manager that finds no room is held for like any required helper (see "Room
 * for a required helper" above) - on its dedicated host when that exists, since
 * that server was bought for exactly this and the botnet fills it until the
 * manager is actually on it.
 * @param {NS} ns @param {Set<string>} reserved
 * @param {{homeSlack?: number}} [opts] - extra GB to hold if the hold lands on home
 */
export function placeManager(ns, script, dedicatedHost, reserved, opts = {}) {
  placeManagerIn(tickFor(ns), script, dedicatedHost, reserved, opts);
}

/** placeManager within a tick. @param {HelperTick} t @param {Set<string>} reserved */
function placeManagerIn(t, script, dedicatedHost, reserved, opts = {}) {
  const ns = t.ns;
  t.visited.add(bare(script));

  const running = runningOn(t, script);
  if (running) {
    if (running === dedicatedHost) reserved.add(dedicatedHost);
    return;
  }

  const ram = scriptCost(t, script);
  provisionCloudHost(ns, dedicatedHost, ram);

  // The dedicated host first (if it exists), then the roomiest shared hosts, then home.
  const candidates = [];
  if (ns.serverExists(dedicatedHost)) {
    candidates.push({ host: dedicatedHost });
    // Bought or upgraded a moment ago, perhaps: the tick's walk predates it.
    if (!t.known.has(dedicatedHost)) {
      t.known.add(dedicatedHost);
      t.rooted.push(dedicatedHost);
    }
    t.sizes.delete(dedicatedHost);
  }
  candidates.push(...offHomeHosts(t, reserved, [dedicatedHost]), { host: HOME });

  const { host, refusedOn } = launchOnFirstFit(t, script, ram, candidates, [], false);
  if (host === dedicatedHost) reserved.add(dedicatedHost);
  if (!host) {
    const held = refusedOn
      ? `nothing held: ${refusedOn} had the room and the game would not start it there`
      : requestHold(t, script, ram, reserved, { prefer: dedicatedHost, homeSlack: opts.homeSlack });
    ns.print(`WARN: waiting for ${ns.format.ram(ram)} to place ${script}${held ? ` - ${held}` : ""}`);
  }
}

/**
 * Keep lib/gang.js (~36GB) running once we're in a gang, and publish the botnet
 * reservation for wherever it lives so hacking/manager.js and lib/pserv.js leave that
 * host alone. Adds the dedicated host to `reserved` when the manager sits on it.
 *
 * The RAM hold is the part that matters. By mid-run the botnet has filled every
 * host including home, so without carving space out first a 36GB manager can
 * wait forever for a gap - which is exactly how a hand-created gang ends up with
 * nothing managing it. This used to be the one hold the daemon ever made (on
 * home, written straight into globalThis.gordReservedRam from here - which also
 * wiped whatever else was in the map); it is now an ordinary manager hold
 * (placeManager), published with all the others when the tick closes: on
 * cloud-gang when that server exists, so the manager ends up on the host that
 * was bought for it, and with gang.homeReserveSlack on top if it lands on home.
 *
 * Call BEFORE ensureCorpManagers so the gang host is reserved before the corp goes
 * looking for off-home RAM.
 * @param {NS} ns @param {Set<string>} reserved
 */
export function ensureGangManager(ns, reserved) {
  const script = CONFIG.paths.gang;

  if (!inGangSafe(ns)) {
    globalThis.gordGangPending = false;
    return;
  }

  const t = tickFor(ns);
  placeManagerIn(t, script, CONFIG.gang.host, reserved, { homeSlack: CONFIG.gang.homeReserveSlack });

  // Dashboard shows a "starting" card during the short wait before it lands.
  globalThis.gordGangPending = !runningOn(t, script);
}

/**
 * TOR and the port openers, out of cash ABOVE the money floor only: a hoard held
 * for a faction invite is not program money, and in BN8 the floor is the stock
 * trader's whole book - SQLInject at $250m used to come straight out of trading
 * capital the moment cash touched it, after every install.
 * @param {NS} ns
 */
export async function buyDarkweb(ns) {
  const s = ns.singularity;
  const spendable = () => playerMoney(ns) - (globalThis.gordMoneyFloor ?? 0);

  if (!ns.hasTorRouter()) {
    if (spendable() >= CONFIG.programs.torCost) s.purchaseTor();
    return;
  }

  for (const p of CONFIG.programs.portOpeners) {
    if (!ns.fileExists(p, HOME)) {
      const cost = s.getDarkwebProgramCost(/** @type {any} */ (p));
      if (cost > 0 && spendable() >= cost) s.purchaseProgram(/** @type {any} */ (p));
    }
  }
}

/**
 * Root every server that can be rooted, and return the rooted ones in walk
 * order (home first). beginHelperTick keeps that list for the whole tick.
 * @param {NS} ns @returns {string[]}
 */
export function rootEverything(ns) {
  const rooted = [];
  for (const server of allServers(ns)) {
    let has = server === HOME;
    if (!has) {
      try { has = root(ns, server); } catch {}
    }
    if (has) rooted.push(server);
  }
  return rooted;
}

/**
 * Accept every pending faction invite. The only ones we ever decline are city
 * factions that would be a mistake right now - joining one permanently bans its
 * enemy cities, so shouldJoinCityFaction skips a city faction with nothing left to
 * offer, or one whose enemy is ALSO inviting us and offers more. Everything else,
 * including every hacking faction, is joined the moment the invite appears.
 *
 * The whole pending list is passed down so that comparison is made against
 * invites we can actually take today, not against every faction that might
 * theoretically invite us later (which used to decline all of them forever).
 * @param {NS} ns
 */
export async function acceptInvites(ns) {
  const pending = /** @type {string[]} */ (ns.singularity.checkFactionInvitations());

  for (const faction of pending) {
    if (!shouldJoinCityFaction(ns, faction, pending)) continue;
    if (ns.singularity.joinFaction(/** @type {any} */ (faction))) {
      ns.tprint(`Joined ${faction}.`);
      emitEvent(`[join] Joined ${faction}`, "faction", { factions: [String(faction)] });
    }
  }
}

// ── Gang identity ─────────────────────────────────────────────────────────────

/**
 * The faction our gang belongs to, or null when we have no gang. Read from the state
 * lib/gang.js publishes, so it costs nothing beyond the inGang check and is simply
 * empty until the manager is up - callers treat that as "no gang" for a tick or two.
 *
 * Worth knowing because a gang faction's reputation accrues PASSIVELY from respect
 * and workForFaction isn't even offered for it, so every "should I work this faction?"
 * decision has to skip it.
 * @param {NS} ns
 */
export function gangFactionName(ns) {
  return inGangSafe(ns) ? globalThis.gordGangState?.faction ?? null : null;
}

// ── Faction work ──────────────────────────────────────────────────────────────

/**
 * Start the best available faction work, and publish which faction we're grinding
 * (recordFactionWork) so off-home helpers can line up behind it - lib/sleeves.js puts
 * any sleeve too weak to crime onto FIELD WORK for the same faction.
 * @param {NS} ns @param {string} faction @returns {string|null} the work type that took
 */
export function startBestFactionWork(ns, faction) {
  for (const type of CONFIG.player.factionWorkTypes) {
    const ok = ns.singularity.workForFaction(
      /** @type {any} */ (faction),
      /** @type {any} */ (type),
      focusFlag(ns)
    );
    if (ok) {
      recordFactionWork(faction, type);
      return type;
    }
  }
  return null;
}

/**
 * When our primary goal doesn't need the player's focus, bank reputation with a
 * SECONDARY faction that still has augs we'll want later - free progress out of a
 * work slot that would otherwise idle. Returns a one-line description, or null.
 *
 * Skips the gang's own faction (its rep is passive - see gangFactionName) and any
 * faction whose remaining augs we either own, can't afford the prerequisites for, or
 * already have the reputation for.
 * @param {NS} ns @param {string} primaryFaction - skip this one; we're already on it
 */
export function maybeDoSecondaryFactionWork(ns, primaryFaction) {
  if (shouldFocus(ns)) return null; // can't background work

  const owned = new Set(ns.singularity.getOwnedAugmentations(true));
  const joined = ns.getPlayer().factions ?? [];
  const ourGangFaction = gangFactionName(ns);

  for (const factionName of joined) {
    if (factionName === primaryFaction) continue;
    if (factionName === ourGangFaction) continue; // gang rep is passive (from respect)
    if (!factionRepStillUseful(ns, factionName, owned, { requirePrereqs: true })) continue;

    const workType = startBestFactionWork(ns, factionName);
    if (workType) return `Secondary: ${factionName} (${workType})`;
  }

  return null;
}

// ── Augmentations: buy, and decide when to install ────────────────────────────

/**
 * The next augmentation to buy, or the one we're saving for. Pure - exported for
 * the tests.
 *
 * Every purchase multiplies the price of every aug still unbought by 1.9, so the
 * ORDER decides what a set costs: {100, 50, 10} is 231 bought dearest-first and
 * 466 cheapest-first. Buying whatever is affordable as it becomes affordable -
 * what this replaced - is cheapest-first in practice: the $50m aug goes through
 * while we're $100m short of the $1b one, which then costs $1.9b.
 *
 * So the dearest READY aug (reputation met, prerequisites owned) is bought first,
 * and while a ready aug is unaffordable but WITHIN REACH - its shortfall is no
 * more than `horizonMs` of income - nothing cheaper is bought: we save for it.
 * One further out than that is skipped rather than allowed to freeze everything
 * under it.
 *
 * An aug whose reputation would be BOUGHT (a donation - see buyAugs) rides the
 * same list with a `donation` on it. It keeps its place in the order by PRICE -
 * a donation raises no other price, so it is no reason to go first - but what
 * has to fit, or be within reach, is price + donation: the donation is only ever
 * made when the aug it unlocks is paid for in the same breath, so cash is never
 * sunk into reputation for something we then can't afford.
 *
 * @param {{aug: string, price: number, donation?: number}[]} ready - purchasable
 *   but for money (donation: dollars of reputation still to buy first; default 0)
 * @param {{spendable: number, incomePerMs: number, horizonMs: number}} o
 *   spendable - cash above the money floor
 * @returns {{buy: any | null, savingFor: any | null}}
 */
export function nextAugPurchase(ready, o) {
  const byPrice = [...ready].sort((a, b) => b.price - a.price);
  const reach = Math.max(0, o.incomePerMs) * o.horizonMs;
  for (const c of byPrice) {
    const cost = c.price + (c.donation ?? 0);
    if (cost <= o.spendable) return { buy: c, savingFor: null };
    if (cost - o.spendable <= reach) return { buy: null, savingFor: c };
  }
  return { buy: null, savingFor: null };
}

// ── Donations: reputation for money ───────────────────────────────────────────
//
// At ns.getFavorToDonate() favor (150 x the node's multiplier) a faction takes
// donations: $1m buys faction_rep x FactionWorkRepGain reputation, instantly.
// Late in a node that is far cheaper than the hours the same reputation takes to
// grind (The Red Pill is 2.5m), so once a faction is past the line buyAugs buys
// an aug's missing reputation along with the aug, and the pre-install NeuroFlux
// dump buys the reputation its extra levels need. Getting a faction TO the line
// is the "favor" install reason (installReason) and idle rep banking
// (lib/aug-targets.js pickFavorBankFaction).

/** Factions that take no donations at all (they offer no work). */
const NO_DONATION = new Set(CONFIG.factions.noDonation);
/** Factions that refused a donation this run - not asked again. */
const _donationRefused = new Set();
/** Reputation per dollar as last MEASURED off a real donation (no-Formulas path). */
let _repPerDollarSeen = 0;

/**
 * Forget what donations taught us. Module state is NOT per process: the game
 * caches a script's module until its source changes (bitburner-src
 * NetscriptJSEvaluator.ts), so both of the above outlive an install and a
 * BitNode change - where favor has moved and the next node's FactionWorkRepGain
 * makes the measured rate wrong. The daemon calls this once at boot.
 */
export function resetDonationMemory() {
  _donationRefused.clear();
  _repPerDollarSeen = 0;
}

/**
 * Dollars to donate for `repShort` reputation, rounded up and padded by `margin`
 * so a float's worth of shortfall can't leave the aug one rep out of reach.
 * Infinity when the rate is unknown - which makes it unaffordable, not free. Pure.
 * @param {number} repShort @param {number} repPerDollar @param {number} [margin]
 */
export function donationCost(repShort, repPerDollar, margin = 0) {
  if (!(repShort > 0)) return 0;
  if (!(repPerDollar > 0)) return Infinity;
  return Math.ceil((repShort / repPerDollar) * (1 + margin));
}

/**
 * Is this reputation shortfall worth paying for? Not while the work slot is
 * about to deliver it anyway: under policy.skipIfGrindUnderMs of grinding at the
 * measured rate, the money is better kept for the aug. Nor when the grind is
 * the CHEAPER way to get it - the donation would take longer to earn back than
 * the reputation takes to grind (cash-starved nodes: BN9). An unmeasured rate
 * (we aren't working there) has no grind to compare against, so it's worth it;
 * fitting the budget is nextAugPurchase's call. Pure.
 * @param {{repShort: number, repRatePerMs: number, donation?: number, incomePerMs?: number}} c
 *   donation / incomePerMs - what it costs and what we earn; omit to skip the
 *   earn-back comparison
 * @param {{skipIfGrindUnderMs: number}} policy - CONFIG.augs.donate
 */
export function worthDonating(c, policy) {
  if (!(c.repShort > 0)) return false;
  if (!(c.repRatePerMs > 0)) return true;
  const grindMs = c.repShort / c.repRatePerMs;
  if (grindMs < policy.skipIfGrindUnderMs) return false;
  if (c.donation > 0 && c.incomePerMs > 0 && c.donation / c.incomePerMs > grindMs) return false;
  return true;
}

/**
 * Reputation one donated dollar buys. Formulas.exe gives the game's exact figure
 * (faction_rep x the BitNode's FactionWorkRepGain, per $1m). Without it the
 * closed form can't see the BitNode multiplier (getBitNodeMultipliers is 4GB),
 * so `exact` is false until a real donation has been measured - the callers
 * make that first one a small probe rather than trusting the guess with the
 * whole amount.
 * @param {NS} ns @returns {{perDollar: number, exact: boolean}}
 */
function repPerDollar(ns) {
  const player = ns.getPlayer();
  if (hasFormulas(ns)) {
    try {
      return { perDollar: ns.formulas.reputation.repFromDonation(1e6, player) / 1e6, exact: true };
    } catch { /* fall through to the closed form */ }
  }
  if (_repPerDollarSeen > 0) return { perDollar: _repPerDollarSeen, exact: true };
  return { perDollar: (player.mults?.faction_rep ?? 1) / 1e6, exact: false };
}

/**
 * A faction's measured reputation rate (rep/ms) from the daemon's rolling
 * snapshot - only while it is FRESH. The snapshot is kept for the current aug
 * target's faction alone, so an old one describes work we've since left.
 * @param {string} faction
 */
function liveRepRate(faction) {
  const snap = (globalThis._repSnaps ?? {})[faction];
  if (!snap || Date.now() - snap.time > AUGS.repRateMaxAgeMs) return 0;
  return snap.rate ?? 0;
}

/**
 * The joined factions that will take a donation right now: favor at the game's
 * threshold, not our gang's (the game refuses it), not one that offers no work.
 * @param {NS} ns @param {string[]} joined @returns {Set<string>}
 */
function donationFactions(ns, joined) {
  const out = new Set();
  if (!AUGS.donate.enabled) return out;
  const threshold = ns.getFavorToDonate();
  const gang = gangFactionName(ns);
  for (const f of joined) {
    if (f === gang || NO_DONATION.has(f) || _donationRefused.has(f)) continue;
    if (ns.singularity.getFactionFavor(/** @type {any} */ (f)) >= threshold) out.add(f);
  }
  return out;
}

/**
 * Donate, and measure what it bought (which is also the no-Formulas calibration).
 * A refusal with the money in hand means the faction doesn't take donations at
 * all; it is remembered so the buy loop can't spin on it.
 * @param {NS} ns @param {string} faction @param {number} amount @param {string} what
 * @returns {number} reputation gained (0 = refused)
 */
function donateForRep(ns, faction, amount, what) {
  const s = ns.singularity;
  const f = /** @type {any} */ (faction);
  const before = s.getFactionRep(f);
  if (!s.donateToFaction(f, amount)) {
    if (playerMoney(ns) >= amount) _donationRefused.add(faction);
    return 0;
  }
  const gained = s.getFactionRep(f) - before;
  if (gained > 0) _repPerDollarSeen = gained / amount;
  emitEvent(
    `[buy] Donated $${ns.format.number(amount)} to ${faction} (+${ns.format.number(gained)} rep) for ${what}`,
    "buy",
    { factions: [faction] },
  );
  return gained;
}

/**
 * Buy augmentations across our joined factions in the order that makes the set
 * cheapest: dearest first, saving for one that's within reach instead of buying
 * under it (nextAugPurchase). NeuroFlux Governor is left to the pre-install dump
 * in maybeInstall while any real aug is still unowned - a level bought mid-run
 * raises every other price by the same 1.9 - and bought here only once there is
 * nothing else left to want.
 *
 * Reputation is bought too, where a faction takes donations (see the Donations
 * block above): an aug whose only gap is reputation with such a faction joins the
 * same list, costed at price + the donation that closes the gap, and is donated
 * for at the moment it is bought - never earlier, so the two can't fight over
 * cash. NeuroFlux is not donated for here; that is the pre-install dump's job.
 *
 * Respects globalThis.gordMoneyFloor - the daemon raises it while hoarding cash for
 * a money-gated faction invite (Daedalus / The Covenant / Illuminati), where spending
 * below the line would cancel the very invite we're waiting on. Zero on nodes that
 * never hoard, so this is a no-op there.
 * @param {NS} ns @returns {string[]} human-readable descriptions of what we bought
 */
export function buyAugs(ns) {
  const s = ns.singularity;
  const owned = new Set(s.getOwnedAugmentations(true));
  const joined = ns.getPlayer().factions ?? [];
  const floor = globalThis.gordMoneyFloor ?? 0;
  const purchases = [];
  const donors = donationFactions(ns, joined);

  // What each joined faction still sells that we don't own and could buy but for
  // money (prereqs owned): outright where the reputation is met, else through a
  // donation where the faction takes one - from whichever such faction is
  // closest. Also whether any real (non-NeuroFlux) aug remains at all.
  /** @type {Map<string, {aug: string, faction: string, rep: number, repReq: number, viaDonation: boolean}>} */
  const options = new Map();
  let realAugsLeft = false;
  for (const faction of joined) {
    const rep = s.getFactionRep(/** @type {any} */ (faction));
    for (const aug of s.getAugmentationsFromFaction(/** @type {any} */ (faction))) {
      if (aug !== AUGS.neuroFlux && !owned.has(aug)) realAugsLeft = true;
      if (aug !== AUGS.neuroFlux && owned.has(aug)) continue;
      const have = options.get(aug);
      if (have && !have.viaDonation) continue;          // already buyable outright
      const repReq = s.getAugmentationRepReq(aug);
      const viaDonation = rep < repReq;
      if (viaDonation && (aug === AUGS.neuroFlux || !donors.has(faction))) continue;
      if (viaDonation && have && have.rep >= rep) continue; // the other donor is closer
      if (!s.getAugmentationPrereq(aug).every(a => owned.has(a))) continue;
      options.set(aug, { aug, faction, rep, repReq, viaDonation });
    }
  }
  if (realAugsLeft) options.delete(AUGS.neuroFlux);

  let savingFor = null;
  for (let guard = 0; guard < AUGS.maxBuysPerTick && options.size > 0; guard++) {
    // Prices and reputation are re-read every round: each purchase raised the
    // former, each donation the latter.
    const rate = repPerDollar(ns);
    const incomePerMs = globalThis._incomeRatePerMs ?? 0;
    const priced = [];
    for (const c of options.values()) {
      const price = s.getAugmentationPrice(c.aug);
      const repShort = c.viaDonation ? c.repReq - s.getFactionRep(/** @type {any} */ (c.faction)) : 0;
      if (repShort <= 0) {
        priced.push({ ...c, price, donation: 0 });
        continue;
      }
      const donation = donationCost(repShort, rate.perDollar, AUGS.donate.margin);
      if (worthDonating({ repShort, repRatePerMs: liveRepRate(c.faction), donation, incomePerMs }, AUGS.donate)) {
        priced.push({ ...c, price, donation });
      }
    }
    const next = nextAugPurchase(priced, {
      spendable: playerMoney(ns) - floor,
      incomePerMs,
      horizonMs: AUGS.saveHorizonMs,
    });
    savingFor = next.savingFor;
    const pick = next.buy;
    if (!pick) break;

    if (pick.donation > 0) {
      // Unmeasured rate (no Formulas.exe, no donation yet this run): a small
      // probe first, so the real amount is sized from what a dollar actually buys.
      const amount = rate.exact ? pick.donation : Math.min(pick.donation, AUGS.donate.probeAmount);
      const gained = donateForRep(ns, pick.faction, amount, pick.aug);
      if (gained <= 0) {
        // Refused: drop every option that leaned on this faction's donations.
        for (const c of [...options.values()]) {
          if (c.viaDonation && c.faction === pick.faction) options.delete(c.aug);
        }
        continue;
      }
      purchases.push(`$${ns.format.number(amount)} donated to ${pick.faction} for ${pick.aug}`);
      // A probe, or a donation that fell short: next round re-prices it.
      if (s.getFactionRep(/** @type {any} */ (pick.faction)) < pick.repReq) continue;
    }

    if (!s.purchaseAugmentation(/** @type {any} */ (pick.faction), pick.aug)) {
      options.delete(pick.aug); // the game refused it; don't spin on it
      continue;
    }
    purchases.push(`${pick.aug} from ${pick.faction}`);
    if (pick.aug === AUGS.neuroFlux) continue; // more levels may follow
    owned.add(pick.aug);
    options.delete(pick.aug);
  }

  // For the HUD / status line: the aug cheaper purchases are being held for
  // (price includes the donation that buys its reputation, when there is one).
  globalThis.gordAugSavingFor = savingFor
    ? { aug: savingFor.aug, price: savingFor.price + (savingFor.donation ?? 0), donation: savingFor.donation ?? 0 }
    : null;
  return purchases;
}

/**
 * The install policy as a pure function: why an install is due now, or null.
 *   "red-pill"   - The Red Pill is QUEUED (always; it's the BitNode key). Queued,
 *                  not merely owned: once it is installed it stays "owned" for the
 *                  rest of the node, and as a trigger that reset the run every
 *                  tick a NeuroFlux level was affordable.
 *   "queue"      - queuedThreshold augs are waiting
 *   "priority"   - priorityQueuedThreshold are waiting AND one is a priority aug
 *   "aggressive" - every priority aug is installed and minQueued are waiting
 *   "time"       - the run has lasted timeTriggerMs with minQueued waiting, or
 *                  TWICE that with anything waiting at all: where minQueued is
 *                  above one (the dear-aug nodes), one to three bought augs
 *                  otherwise sat uninstalled for as long as the next was out of reach
 *   "favor"      - the reset itself would carry the faction we're grinding over
 *                  the donation threshold (s.favor, from favorInstallCandidate),
 *                  and that pays: at least favorMinGrindMs of grind is left for
 *                  its augs, and income would BUY that reputation in no more
 *                  than favorMaxPayFraction of the time. Deliberately narrow,
 *                  since it resets a run early: something must be queued
 *                  (favorMinQueued), the run must be favorMinRunMs old, and a
 *                  faction can only ever trip it once - after the install it
 *                  is past the threshold.
 * Nothing queued is never a reason: the pre-install NeuroFlux dump must not be
 * what creates the queue.
 * @param {{queued: number, redPillQueued: boolean, hasPriorityAug: boolean,
 *           allPriorityDone: boolean, elapsedMs: number,
 *           favor?: {faction: string, grindMs: number, payMs: number} | null}} s
 * @param {typeof CONFIG.augs.install} policy - the NODE's augs.install (forNode)
 * @returns {"red-pill" | "queue" | "priority" | "aggressive" | "time" | "favor" | null}
 */
export function installReason(s, policy) {
  if (s.queued <= 0) return null;
  if (s.redPillQueued) return "red-pill";
  if (s.queued >= policy.queuedThreshold) return "queue";
  if (s.queued >= policy.priorityQueuedThreshold && s.hasPriorityAug) return "priority";
  if (s.allPriorityDone && s.queued >= policy.minQueued) return "aggressive";
  if (s.queued >= policy.minQueued && s.elapsedMs >= policy.timeTriggerMs) return "time";
  if (s.elapsedMs >= 2 * policy.timeTriggerMs) return "time";
  if (
    policy.favorInstall && s.favor &&
    s.queued >= policy.favorMinQueued &&
    s.elapsedMs >= policy.favorMinRunMs &&
    s.favor.grindMs >= policy.favorMinGrindMs &&
    s.favor.payMs <= s.favor.grindMs * policy.favorMaxPayFraction
  ) return "favor";
  return null;
}

/**
 * The faction an install would be worth making FOR: one that isn't taking
 * donations yet, would be the moment this run's reputation is folded into its
 * favor, and still has a grind ahead of it. Returns that grind against what it
 * would cost in income-time to buy instead, for installReason to judge; the
 * longest grind wins when several qualify. Pure.
 *
 * Only a faction with a MEASURED reputation rate counts - i.e. the one the work
 * slot is on. A faction nobody is grinding has no grind to save, and guessing
 * its rate would be guessing at a reset.
 *
 * Note payMs / grindMs is independent of how much reputation is left: it is
 * (rep/ms from work) / (rep/ms income buys). So favorMaxPayFraction really asks
 * "does money buy this faction's reputation several times faster than work
 * does?" - true late in a node, false in a cash-starved one, where the reset
 * would unlock donations nobody can pay for.
 *
 * @param {{faction: string, favor: number, rep: number, maxWantedRep: number,
 *          repRatePerMs: number}[]} rows
 *   maxWantedRep - the highest reputation requirement among its unowned augs
 * @param {{threshold: number, repPerDollar: number, incomePerMs: number}} o
 * @returns {{faction: string, grindMs: number, payMs: number} | null}
 */
export function favorInstallCandidate(rows, o) {
  const buyRate = o.repPerDollar * o.incomePerMs; // rep/ms that income buys
  if (!(buyRate > 0)) return null;

  let best = null;
  for (const r of rows) {
    if (r.favor >= o.threshold) continue;                            // already takes donations
    if (favorAfterInstall(r.favor, r.rep) < o.threshold) continue;   // a reset wouldn't unlock them
    const repLeft = r.maxWantedRep - r.rep;
    if (!(repLeft > 0) || !(r.repRatePerMs > 0)) continue;           // no grind left, or unmeasured
    const c = { faction: r.faction, grindMs: repLeft / r.repRatePerMs, payMs: repLeft / buyRate };
    if (!best || c.grindMs > best.grindMs) best = c;
  }
  return best;
}

/**
 * favorInstallCandidate's inputs, read live. Only factions with a fresh measured
 * rate are looked at, so this is one faction's worth of calls on most ticks.
 * @param {NS} ns @param {string[]} ownedWithPurchased
 */
function favorInstallState(ns, ownedWithPurchased) {
  const s = ns.singularity;
  const owned = new Set(ownedWithPurchased);
  const gang = gangFactionName(ns);
  const rows = [];
  for (const faction of ns.getPlayer().factions ?? []) {
    if (faction === gang || NO_DONATION.has(faction) || _donationRefused.has(faction)) continue;
    const repRatePerMs = liveRepRate(faction);
    if (!(repRatePerMs > 0)) continue;
    const f = /** @type {any} */ (faction);
    const wanted = s.getAugmentationsFromFaction(f).filter(a => a !== AUGS.neuroFlux && !owned.has(a));
    rows.push({
      faction,
      favor: s.getFactionFavor(f),
      rep: s.getFactionRep(f),
      maxWantedRep: Math.max(0, ...wanted.map(a => s.getAugmentationRepReq(a))),
      repRatePerMs,
    });
  }
  if (!rows.length) return null;
  return favorInstallCandidate(rows, {
    threshold: ns.getFavorToDonate(),
    repPerDollar: repPerDollar(ns).perDollar,
    incomePerMs: globalThis._incomeRatePerMs ?? 0,
  });
}

/**
 * The pre-install NeuroFlux dump from one faction: levels until the money runs
 * out, or - where the faction doesn't take donations - until its reputation
 * does. Each level raises NeuroFlux's reputation requirement as well as its
 * price; with donations that gap is bought too, whenever the gap plus the level
 * still fits in what's left. (Money doesn't survive the reset, so anything that
 * fits is worth it.)
 * @param {NS} ns @param {string} faction @param {boolean} canDonate
 */
function dumpNeuroFlux(ns, faction, canDonate) {
  const s = ns.singularity;
  const f = /** @type {any} */ (faction);
  for (let guard = 0; guard < AUGS.maxBuysPerTick * 4; guard++) {
    const price = s.getAugmentationPrice(AUGS.neuroFlux);
    const money = playerMoney(ns);
    if (money < price) return;

    const repShort = s.getAugmentationRepReq(AUGS.neuroFlux) - s.getFactionRep(f);
    if (repShort > 0) {
      if (!canDonate) return;
      const rate = repPerDollar(ns);
      const gift = donationCost(repShort, rate.perDollar, AUGS.donate.margin);
      if (price + gift > money) return;
      // Unmeasured rate: probe first (see buyAugs); the loop re-reads and tops up.
      const amount = rate.exact ? gift : Math.min(gift, AUGS.donate.probeAmount);
      if (donateForRep(ns, faction, amount, AUGS.neuroFlux) <= 0) return;
      continue;
    }

    if (!s.purchaseAugmentation(f, AUGS.neuroFlux)) return;
  }
}

/**
 * Install queued augmentations - a soft reset - when it's worth the lost progress.
 * Any ONE of these triggers it:
 *   - The Red Pill is queued (always; it's the BitNode key)
 *   - queuedThreshold augs are waiting
 *   - priorityQueuedThreshold are waiting AND one is an early-game priority aug
 *   - AGGRESSIVE: every priority aug is already installed and anything at all is
 *     queued. Past that point the reset's price-multiplier reset is worth more than
 *     the run time it costs
 *   - the run has lasted timeTriggerMs with something queued
 *   - FAVOR: the reset would unlock donations with the faction being ground, and
 *     buying the rest of its reputation beats grinding it (see installReason)
 *
 * Never installs while hoarding for a money-gated invite: the reset drops our skills
 * below gates we've just met, and the pre-install NeuroFlux dump would spend the very
 * cash we're holding.
 * @param {NS} ns @param {string} selfScript - this daemon's path, relaunched after the reset
 * @param {((ns: NS) => boolean) | null} [beforeInstall]
 * @param {typeof CONFIG.augs.install} [policy] - the node's augs.install (forNode);
 *   BN7 and BN9 batch installs bigger than the default
 */
export function maybeInstall(ns, selfScript, beforeInstall = null, policy = CONFIG.augs.install) {
  const s = ns.singularity;
  const ownedWithPurchased = s.getOwnedAugmentations(true);
  const ownedInstalled = s.getOwnedAugmentations(false);
  const queued = ownedWithPurchased.length - ownedInstalled.length;
  // QUEUED, not merely owned: getOwnedAugmentations(true) includes the installed
  // ones, so "owns The Red Pill" stays true for the rest of the node once it's
  // in - and as an install trigger that reset the run every tick a NeuroFlux
  // level was affordable (the dump below queues one, which is all the game needs).
  const redPillQueued = ownedWithPurchased.includes(AUGS.redPill) && !ownedInstalled.includes(AUGS.redPill);

  // Publish the aug picture for the off-home readers (ui/dashboard.js's queue
  // card and owned count, lib/stocks.js's pre-install liquidation), so none of
  // them has to carry getOwnedAugmentations (5GB) of their own.
  globalThis.gordAugSnapshot = {
    owned: ownedWithPurchased,
    installed: ownedInstalled,
    queued,
    redPillQueued,
    // This node's install threshold, for the HUD's "install soon" line.
    installAt: policy.queuedThreshold,
    updatedAt: Date.now(),
  };

  const priority = AUGS.installPriority;

  // The game's own clock for "since the last install OR BitNode entry" - the
  // reset file only knows about installs this bot made, so in a fresh BitNode it
  // still held the previous node's last install and the first queued aug could
  // trip the time trigger straight away. (The daemon pays getResetInfo already.)
  const elapsed = Date.now() - ns.getResetInfo().lastAugReset;

  // The "favor" reason's faction, if any. Only looked up when it could matter:
  // the feature is on, something is queued, and the run is old enough.
  const favor = policy.favorInstall && AUGS.donate.enabled &&
    queued >= policy.favorMinQueued && elapsed >= policy.favorMinRunMs
    ? favorInstallState(ns, ownedWithPurchased)
    : null;

  const reason = (globalThis.gordMoneyFloor ?? 0) > 0 ? null : installReason({
    queued,
    redPillQueued,
    hasPriorityAug: priority.some(a => ownedWithPurchased.includes(a) && !ownedInstalled.includes(a)),
    allPriorityDone: priority.every(a => ownedInstalled.includes(a)),
    elapsedMs: elapsed,
    favor,
  }, policy);
  if (!reason) {
    globalThis.gordInstallRequested = 0;
    return;
  }

  // An install wipes the stock market, so positions held through it are lost
  // rather than feeding the NeuroFlux dump below. Ask lib/stocks.js to sell
  // (it watches this stamp) and hold the reset until its portfolio is empty -
  // bounded, so a trader that died or can't sell never blocks a reset.
  const requestedAt = (globalThis.gordInstallRequested ||= Date.now());
  const stock = globalThis.gordStockState;
  const traderLive = !!stock && Date.now() - (stock.updatedAt ?? 0) <= CONFIG.stocks.stateStaleMs;
  if (traderLive && (stock.totalValue ?? 0) > 0 && Date.now() - requestedAt < CONFIG.stocks.installLiquidateTimeoutMs) {
    ns.print(`Install pending (${reason}) - waiting for the stock portfolio to liquidate.`);
    return;
  }

  // A node may need a moment before the reset lands (BN9 sells its hashes
  // first - they don't survive an install). The decision above is re-made
  // every tick, so holding here just delays it.
  if (beforeInstall && !beforeInstall(ns)) return;

  if (reason === "time") {
    ns.tprint(`Time-triggered install after ${(elapsed / 3_600_000).toFixed(1)}h with ${queued} aug(s) queued.`);
  } else if (reason === "aggressive") {
    ns.tprint(`Aggressive install: all priority augs done, resetting with ${queued} queued.`);
  } else if (reason === "favor" && favor) {
    ns.tprint(
      `Favor install: resetting with ${queued} queued so ${favor.faction} starts taking donations - ` +
      `${(favor.grindMs / 3_600_000).toFixed(1)}h of reputation grind left, ` +
      `${(favor.payMs / 3_600_000).toFixed(1)}h of income buys it instead.`
    );
  }

  // Dump remaining cash into NeuroFlux Governor right before resetting - money
  // doesn't survive the reset, and NFG levels do. From the faction with the MOST
  // reputation among those that actually SELL it: each level raises NFG's rep
  // requirement, so that is the one that can sell the most levels - and the
  // special factions (Bladeburners, a gang's) don't offer it at all, so "the
  // first faction with enough rep" could pick one whose every purchase fails.
  // Then, if that one doesn't take donations, from the best seller that does:
  // there the reputation for further levels can be bought (dumpNeuroFlux).
  const joined = ns.getPlayer().factions ?? [];
  const donors = donationFactions(ns, joined);
  const sellers = joined
    .filter(f => s.getAugmentationsFromFaction(/** @type {any} */ (f)).includes(AUGS.neuroFlux))
    .map(f => ({ f, rep: s.getFactionRep(/** @type {any} */ (f)) }))
    .sort((a, b) => b.rep - a.rep);
  const dumpFrom = new Set([sellers[0]?.f, sellers.find(x => donors.has(x.f))?.f].filter(Boolean));
  for (const faction of dumpFrom) dumpNeuroFlux(ns, faction, donors.has(faction));

  // Record what this reset installs + how long the run lasted, for the next boot's
  // journal. AFTER the NeuroFlux buys (so late NFG is counted) and BEFORE
  // writeResetTime (which overwrites the timestamp we need for the duration).
  // Guarded: a summary failure must never block the install.
  try {
    const installedSet = new Set(s.getOwnedAugmentations(false));
    const installing = s.getOwnedAugmentations(true).filter(a => !installedSet.has(a));
    recordResetSummary(ns, installing, Date.now() - readLastResetTime(ns));
  } catch (e) {
    ns.print(`reset summary failed: ${String(e)}`);
  }

  writeResetTime(ns);
  s.installAugmentations(selfScript);
}

/**
 * Grow the purchased-server fleet with whatever spending the current aug goal leaves
 * spare. Server RAM only multiplies hacking income, while cash buys augs outright, so
 * the budget scales down the closer we are to affording something:
 *   hoarding for an invite -> spend nothing
 *   no aug target          -> a modest slice of a free treasury
 *   blocked on REP         -> money's piling up anyway, so spend some surplus
 *   blocked on MONEY       -> only nibble at the shortfall, or report that we're saving
 * @param {NS} ns @param {any} target - the current aug target from getNextAugTarget
 */
export async function maybeBuyInfra(ns, target) {
  if ((globalThis.gordMoneyFloor ?? 0) > 0) {
    return { action: "Holding Cash", detail: "servers paused - saving for a faction invite" };
  }

  const money = playerMoney(ns);

  if (!target) {
    return await managePurchasedServers(ns, INFRA.noTarget.reserveMoney, INFRA.noTarget.spendFraction);
  }

  const { price, moneyMissing = 0, repMissing = 0 } = target;

  if (repMissing > 0) {
    const hardCap = money > price ? money - price : money * INFRA.repPending.fallbackCapFraction;
    return await managePurchasedServers(ns, INFRA.repPending.reserveMoney, INFRA.repPending.spendFraction, hardCap);
  }

  const tinyBudget = moneyMissing * INFRA.savingBudgetFraction;
  if (tinyBudget < INFRA.minBudget) {
    return {
      action: "Saving for Aug",
      detail: `${target.aug}: need $${ns.format.number(moneyMissing)}`,
    };
  }
  return await managePurchasedServers(ns, price, INFRA.savingSpendFraction, tinyBudget);
}

// nextBNOverride's memo: the file is read once per process, not once per tick.
let _nextBN = /** @type {{key: string, value: number | null} | null} */ (null);

/**
 * The player's explicit choice of next BitNode - the daemon's arg [0], as in
 * `run bn7/daemon.js 10` (0 = hold for a manual choice) - or null when there is
 * none and the node's own plan applies.
 *
 * Remembered in a file for the rest of the BitNode, because an aug install
 * restarts the daemon through the game's reset callback, which passes NO
 * arguments: without this, the choice silently reverted to the default plan at
 * the first install - and buying The Red Pill always triggers one, so a hold
 * (`... 0`) was lost exactly when it mattered. Keyed by the time this BitNode
 * was entered, so it can never leak into the next one. `run <daemon> auto`
 * forgets it.
 * @param {NS} ns @returns {number | null}
 */
export function nextBNOverride(ns) {
  const key = String(ns.getResetInfo().lastNodeReset);
  const arg = ns.args[0];
  const explicit = arg != null && arg !== "";
  if (explicit) {
    const value = Number.isFinite(Number(arg)) ? Number(arg) : null; // "auto" clears
    if (_nextBN?.key !== key || _nextBN.value !== value) {
      ns.write(CONFIG.paths.nextBnFile, value == null ? "" : `${key} ${value}`, "w");
      _nextBN = { key, value };
    }
    return value;
  }
  if (_nextBN?.key !== key) {
    const [k, v] = String(ns.read(CONFIG.paths.nextBnFile)).trim().split(/\s+/);
    _nextBN = { key, value: k === key && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null };
  }
  return _nextBN.value;
}

/**
 * The BitNode to enter when this one is finished: the player's explicit choice
 * (nextBNOverride) if there is one, otherwise the next step of the campaign
 * plan (CONFIG.campaign.order - lib/capabilities.js campaignStep). 0 is the
 * halt sentinel: finish nothing, the player chooses.
 *
 * The plan's answer is also published as globalThis.gordCampaign for the HUD:
 * which node, whether it will be entered as a challenge run (lib/finish-bn.js
 * adds the BitNode options for that), and `waiting` while a challenge step
 * cannot be judged because lib/achievements.js has not read the save yet - a
 * halt that lifts by itself.
 *
 * This is every daemon's plan now. Each node used to carry its own rule ("BN5
 * re-enters until 5.2, then halts", "BN9 until 9.2", "BN7 until 7.3"), which
 * could not express "and THEN go to BN14" - so the run stopped and waited at
 * every node boundary.
 * @param {NS} ns @param {any} cfg - forNode(n)
 * @returns {number}
 */
export function plannedNextNode(ns, cfg) {
  const reset = ns.getResetInfo();
  const step = campaignStep(reset, cfg.campaign.order, heldAchievements(globalThis.gordAchievements, reset));
  const override = nextBNOverride(ns);
  globalThis.gordCampaign = { ...step, override, updatedAt: Date.now() };
  return override ?? step.node;
}

/** @param {NS} ns */
export function readLastResetTime(ns) {
  try {
    const raw = ns.read(CONFIG.paths.resetFile);
    const t = Number(raw);
    return isNaN(t) ? 0 : t;
  } catch {
    return 0;
  }
}

/** @param {NS} ns */
export function writeResetTime(ns) {
  ns.write(CONFIG.paths.resetFile, String(Date.now()), "w");
}

/**
 * Persist a one-shot summary of the reset we're about to perform, so the next
 * boot's journal can report "installed N augmentations after this run". Written
 * just before installAugmentations() (which wipes globalThis), then consumed once
 * on the following boot. Guarded by the caller so a summary failure can never
 * block the install itself.
 * @param {NS} ns
 * @param {string[]} augs   the augmentations being installed this reset
 * @param {number} sinceMs  duration of the run that just ended, in ms
 */
export function recordResetSummary(ns, augs, sinceMs) {
  const record = { at: Date.now(), augs: augs ?? [], sinceMs: sinceMs ?? 0 };
  ns.write(CONFIG.paths.resetSummaryFile, JSON.stringify(record), "w");
}

/**
 * Read and clear the reset summary written by the previous run's install (if
 * any). Returns { at, augs, sinceMs } once, then blanks the file so the same
 * reset is never reported twice. Returns null when there's nothing pending.
 * @param {NS} ns
 */
export function consumeResetSummary(ns) {
  try {
    const raw = ns.read(CONFIG.paths.resetSummaryFile);
    if (!raw) return null;
    const record = JSON.parse(raw);
    ns.write(CONFIG.paths.resetSummaryFile, "", "w"); // consume: report at most once
    return record && Array.isArray(record.augs) ? record : null;
  } catch {
    return null;
  }
}
