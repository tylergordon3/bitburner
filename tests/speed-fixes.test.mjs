// tests/speed-fixes.test.mjs
// The 2026-10-25 speed fixes for nodes finished by hacking the world daemon:
// no install after The Red Pill is in (while its level is in reach), the
// Daedalus lock and the Red Pill's place at the head of the buy order, the
// core's money-gated invite hoard, the IPvGO focus on Daedalus, and the run
// history file. Each one either resets a run or holds one, so the rules are
// pinned here.
// Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  installReason, levelEtaMs, appendCapped, runHistoryEntry, buyAugs, daedalusLock, redPillHold,
} from "../lib/daemon-lib.js";
import { coreHoardWanted, hackingFinishes, clearStaleState } from "../lib/daemon-core.js";
import { goFocus, FOCUS_MAX_AGE_MS } from "../lib/go-logic.js";
import { CONFIG, forNode } from "../lib/config.js";

const HOUR = 3_600_000;
const DEFAULT = CONFIG.augs.install;
const st = over => ({
  queued: 0, redPillQueued: false, hasPriorityAug: false, allPriorityDone: false,
  elapsedMs: 0, favor: null, ...over,
});

// ── installReason's two holds ────────────────────────────────────────────────

test("installReason: after The Red Pill nothing installs, whatever is queued", () => {
  const busy = { queued: 50, allPriorityDone: true, hasPriorityAug: true, elapsedMs: 100 * HOUR };
  assert.equal(installReason(st(busy), DEFAULT), "queue");
  assert.equal(installReason(st({ ...busy, redPillHold: true }), DEFAULT), null);
  // A favor install is a reset too.
  const favor = { faction: "BitRunners", grindMs: 10 * HOUR, payMs: 1 * HOUR };
  assert.equal(installReason(st({ queued: 1, elapsedMs: 2 * HOUR, favor, redPillHold: true }), DEFAULT), null);
});

test("installReason: a queued Red Pill still installs at once, lock or hold", () => {
  assert.equal(installReason(st({ queued: 1, redPillQueued: true, daedalusLock: "Daedalus" }), DEFAULT), "red-pill");
  assert.equal(installReason(st({ queued: 1, redPillQueued: true, redPillHold: true }), DEFAULT), "red-pill");
});

test("installReason: the Daedalus lock holds every ordinary reason", () => {
  const lock = { daedalusLock: "Daedalus" };
  assert.equal(installReason(st({ ...lock, queued: DEFAULT.queuedThreshold }), DEFAULT), null);
  assert.equal(installReason(st({ ...lock, queued: 2, hasPriorityAug: true }), DEFAULT), null);
  assert.equal(installReason(st({ ...lock, queued: 1, allPriorityDone: true }), DEFAULT), null);
  assert.equal(installReason(st({ ...lock, queued: 4, elapsedMs: 100 * HOUR }), DEFAULT), null);
});

test("installReason: under the lock only Daedalus's own favor install goes", () => {
  const pays = { grindMs: 10 * HOUR, payMs: 1 * HOUR };
  const base = { daedalusLock: "Daedalus", queued: 1, elapsedMs: 2 * HOUR };
  assert.equal(installReason(st({ ...base, favor: { faction: "Daedalus", ...pays } }), DEFAULT), "favor");
  assert.equal(installReason(st({ ...base, favor: { faction: "BitRunners", ...pays } }), DEFAULT), null);
  // ...and still only when it pays.
  const dear = { faction: "Daedalus", grindMs: 10 * HOUR, payMs: 9 * HOUR };
  assert.equal(installReason(st({ ...base, favor: dear }), DEFAULT), null);
});

// ── How far the world daemon's level is ──────────────────────────────────────

test("levelEtaMs: BN11's 26h save - 2999 of 4500 is ~2.0M exp", () => {
  // hacking mult 28.13 x HackingLevelMultiplier 0.6, exp 133,054 -> level 2999.
  // At 1 exp/ms (3.6M/h) that is ~2.0M ms.
  const eta = levelEtaMs({ level: 2999, exp: 133_054, target: 4500, expPerMs: 1 });
  assert.ok(eta > 1.9e6 && eta < 2.2e6, `eta ${eta}`);
  assert.equal(levelEtaMs({ level: 4500, exp: 2e6, target: 4500, expPerMs: 0 }), 0);
});

test("levelEtaMs: unknown without a rate, or with too little exp to read the multiplier", () => {
  assert.equal(levelEtaMs({ level: 2999, exp: 133_054, target: 4500, expPerMs: 0 }), null);
  assert.equal(levelEtaMs({ level: 50, exp: 500, target: 4500, expPerMs: 1 }), null);
});

/** A fake game for the hold and the lock. */
function fakeNs(o) {
  return {
    getPlayer: () => ({
      money: o.money ?? 0, factions: o.factions ?? [], skills: { hacking: o.level ?? 1 },
      exp: { hacking: o.exp ?? 0 }, mults: { faction_rep: 1 },
    }),
    getResetInfo: () => ({ lastNodeReset: o.run ?? 1, lastAugReset: 0, currentNode: 1 }),
    getServerRequiredHackingLevel: () => o.target ?? 3000,
    singularity: {
      getOwnedAugmentations: () => [...(o.owned ?? [])],
      getAugmentationsFromFaction: f => (o.sells ?? {})[f] ?? [],
    },
  };
}

test("redPillHold: only in a hacking node, only once the pill is installed", () => {
  delete globalThis._expSnap;
  const ns = fakeNs({ level: 100, exp: 1e5, target: 3000, run: 11 });
  assert.equal(redPillHold(ns, ["BitWire"], DEFAULT, true), false);
  assert.equal(redPillHold(ns, ["The Red Pill"], DEFAULT, false), false);
  // Installed, rate not yet measured: held (the safe side).
  assert.equal(redPillHold(ns, ["The Red Pill"], DEFAULT, true), true);
});

test("redPillHold: released once the level is out of reach at the measured rate", () => {
  // m = 100 / (32 ln(1e5 + 534.6) - 200) ~ 0.57: 3000 needs ~e^170 exp - never.
  globalThis._expSnap = { exp: 1e5, at: Date.now(), rate: 1 };
  const ns = fakeNs({ level: 100, exp: 1e5, target: 3000, run: 12 });
  assert.equal(redPillHold(ns, ["The Red Pill"], DEFAULT, true), false);
  assert.equal(globalThis.gordRedPillHold.hold, false);
  delete globalThis._expSnap;
});

test("daedalusLock: joined, selling The Red Pill, not owned, hacking node", () => {
  const sells = { Daedalus: ["The Red Pill", "QLink"] };
  const joined = fakeNs({ factions: ["Daedalus"], sells });
  assert.equal(daedalusLock(joined, [], true), "Daedalus");
  assert.equal(daedalusLock(joined, ["The Red Pill"], true), null);
  assert.equal(daedalusLock(joined, [], false), null);
  assert.equal(daedalusLock(fakeNs({ factions: [], sells }), [], true), null);
  // BN15: Daedalus does not sell it - no lock.
  assert.equal(daedalusLock(fakeNs({ factions: ["Daedalus"], sells: { Daedalus: ["QLink"] } }), [], true), null);
});

// ── buyAugs: The Red Pill last in its round (but never starved), nothing after it ─────────────────────────────

function fakeGame(world) {
  const bought = [];
  const priceOf = a => world.augs[a].price * Math.pow(1.9, bought.filter(b => b !== "The Red Pill").length);
  const ns = {
    getPlayer: () => ({
      money: world.money, factions: Object.keys(world.factions), mults: { faction_rep: 1 },
      skills: { hacking: world.level ?? 1 }, exp: { hacking: world.exp ?? 0 },
    }),
    getResetInfo: () => ({ lastNodeReset: 7, lastAugReset: 0, currentNode: 1 }),
    getServerRequiredHackingLevel: () => 3000,
    getFavorToDonate: () => 150,
    fileExists: () => false,
    gang: { inGang: () => false },
    format: { number: n => String(Math.round(n)) },
    singularity: {
      getOwnedAugmentations: () => [...world.owned],
      getFactionRep: f => world.factions[f].rep,
      getFactionFavor: f => world.factions[f].favor,
      getAugmentationsFromFaction: f => world.factions[f].augs,
      getAugmentationRepReq: a => world.augs[a].repReq,
      getAugmentationPrereq: () => [],
      getAugmentationPrice: priceOf,
      purchaseAugmentation: (f, a) => {
        const price = priceOf(a);
        if (world.factions[f].rep < world.augs[a].repReq || world.money < price) return false;
        world.money -= price;
        world.owned.push(a);
        bought.push(a);
        return true;
      },
      donateToFaction: (f, amount) => {
        const fac = world.factions[f];
        if (fac.favor < 150 || world.money < amount) return false;
        world.money -= amount;
        fac.rep += amount * world.repPerDollar;
        return true;
      },
    },
  };
  return { ns, bought };
}

test("buyAugs: a donatable Red Pill goes before a dearer aug that would eat its money", () => {
  globalThis.gordMoneyFloor = 0;
  globalThis._incomeRatePerMs = 0;
  globalThis._repSnaps = {};
  // $1m buys 1 reputation (faction_rep 1): the pill's 2.5m costs ~$2.5t, while
  // QLink's $3t is the dearer - dearest-first alone would buy it and strand the pill.
  const world = {
    money: 3e12, repPerDollar: 1e-6, owned: [],
    factions: { Daedalus: { rep: 0, favor: 150, augs: ["The Red Pill", "QLink"] } },
    augs: { "The Red Pill": { price: 0, repReq: 2.5e6 }, QLink: { price: 3e12, repReq: 0 } },
  };
  const { ns, bought } = fakeGame(world);
  buyAugs(ns, { policy: DEFAULT, hackingFinish: true });
  assert.equal(bought[0], "The Red Pill");
  assert.ok(!bought.includes("QLink"), "what is left no longer buys QLink");
});

test("buyAugs: nothing is bought once The Red Pill is installed in a hacking node", () => {
  delete globalThis._expSnap;
  globalThis.gordMoneyFloor = 0;
  const world = {
    money: 1e12, repPerDollar: 1, owned: ["The Red Pill"], level: 10, exp: 1e3,
    factions: { CyberSec: { rep: 1e6, favor: 0, augs: ["BitWire"] } },
    augs: { BitWire: { price: 1e4, repReq: 0 } },
  };
  const { ns, bought } = fakeGame(world);
  assert.deepEqual(buyAugs(ns, { policy: DEFAULT, hackingFinish: true }), []);
  assert.deepEqual(bought, []);
  // A black-ops node keeps buying.
  buyAugs(ns, { policy: DEFAULT, hackingFinish: false });
  assert.deepEqual(bought, ["BitWire"]);
});

// ── Which daemons the core hoards for, and which nodes end on hacking ────────

test("coreHoardWanted: every runDaemon node but the four with a floor of their own", () => {
  assert.equal(coreHoardWanted({}, forNode(1), "/bn1/daemon.js"), true);
  assert.equal(coreHoardWanted({}, forNode(11), "/bn11/daemon.js"), true);
  assert.equal(coreHoardWanted({}, forNode(2), "/bn2/daemon.js"), true);
  assert.equal(coreHoardWanted({}, forNode(8), "/bn8/daemon.js"), false);
  assert.equal(coreHoardWanted({}, forNode(9), "/bn9/daemon.js"), false);
  assert.equal(coreHoardWanted({}, forNode(10), "bn10/daemon.js"), false);
  assert.equal(coreHoardWanted({}, forNode(13), "/bn13/daemon.js"), false);
  assert.equal(coreHoardWanted({ inviteHoard: true }, forNode(13), "/bn13/daemon.js"), true);
});

test("hackingFinishes: the world daemon nodes yes, the black-ops nodes no", () => {
  for (const n of [1, 2, 3, 4, 5, 8, 9, 10, 11, 12]) assert.equal(hackingFinishes(forNode(n)), true, `BN${n}`);
  for (const n of [6, 7, 13, 14]) assert.equal(hackingFinishes(forNode(n)), false, `BN${n}`);
});

test("clearStaleState: the hold's snapshot and the Go focus do not outlive the daemon", () => {
  const g = { _expSnap: {}, gordRedPillHold: {}, gordGoFocus: { faction: "Daedalus" } };
  clearStaleState(g, 1);
  assert.equal(g._expSnap, undefined);
  assert.equal(g.gordRedPillHold, undefined);
  assert.equal(g.gordGoFocus, undefined);
});

// ── IPvGO focus ──────────────────────────────────────────────────────────────

test("goFocus: a fresh focus names the opponent, with its configured board", () => {
  const opponents = [{ name: "Daedalus", weight: 2, boardSize: 9 }, { name: "Illuminati", weight: 1 }];
  const now = 1_000_000;
  assert.deepEqual(goFocus({ faction: "Daedalus", updatedAt: now }, opponents, now), { name: "Daedalus", boardSize: 9 });
  assert.deepEqual(goFocus({ faction: "Tetrads", updatedAt: now }, opponents, now), { name: "Tetrads" });
  assert.equal(goFocus({ faction: "Daedalus", updatedAt: now - FOCUS_MAX_AGE_MS - 1 }, opponents, now), null);
  assert.equal(goFocus(null, opponents, now), null);
});

// ── Run history ──────────────────────────────────────────────────────────────

test("appendCapped: keeps the newest lines and drops blanks", () => {
  let text = "";
  for (let i = 0; i < 7; i++) text = appendCapped(text, `l${i}`, 5);
  assert.equal(text, "l2\nl3\nl4\nl5\nl6\n");
  assert.equal(appendCapped("\n\na\n", "b", 5), "a\nb\n");
});

test("runHistoryEntry: run and node clocks, aug counts, SF levels as an object", () => {
  const e = runHistoryEntry(
    "install",
    { currentNode: 11, lastAugReset: 1_000, lastNodeReset: 500, ownedSF: new Map([[1, 3], [4, 3]]) },
    { hack: 2999, money: 7.7e10 },
    { installed: ["a", "b"], queued: 3 },
    5_000,
    { reason: "queue" },
  );
  assert.equal(e.node, 11);
  assert.equal(e.event, "install");
  assert.equal(e.runMs, 4_000);
  assert.equal(e.nodeMs, 4_500);
  assert.equal(e.installed, 2);
  assert.equal(e.queued, 3);
  assert.deepEqual(e.sf, { 1: 3, 4: 3 });
  assert.equal(e.reason, "queue");
  assert.doesNotThrow(() => JSON.stringify(e));
});
