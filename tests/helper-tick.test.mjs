// tests/helper-tick.test.mjs
// How the daemon places its off-home helpers (lib/daemon-lib.js):
//   - the pure decisions behind the RAM it asks the botnet to keep free for a
//     REQUIRED helper that found no room (which host, how much, who may use it);
//   - the same thing end to end against a fake network with a fake batcher that
//     fills every free GB, which is the situation the holds exist for;
//   - that a daemon tick walks the network ONCE, counted on a fake `ns`.
// Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  helperHoldHost, holdBudget, heldAgainst,
  beginHelperTick, closeHelperTick, helperTickYielded,
  ensureHelper, placeManager, ensureGangManager, ensureBackdoorHelpers,
} from "../lib/daemon-lib.js";
import { chargeTaken } from "../lib/daemon-core.js";
import { CONFIG } from "../lib/config.js";
import { fakeNet, bare } from "./helpers/fake-net.mjs";

const P = CONFIG.paths;
const HOLDS = CONFIG.helpers.holds;

// ── The pure decisions ───────────────────────────────────────────────────────

const HOSTS = [
  { host: "zer0", max: 32 }, { host: "joesguns", max: 16 }, { host: "foodnstuff", max: 16 },
  { host: "n00dles", max: 4 }, { host: "silver-helix", max: 64 },
  { host: "home", max: 256, pinned: 98, last: true },
];
const NOW = 1_000_000;
const open = { now: NOW, budget: Infinity, moveOnMs: 60_000 };

test("helperHoldHost: the smallest host that can free the room, by name on a tie, home last", () => {
  assert.deepEqual(helperHoldHost({ ram: 13 }, HOSTS, {}, open), { host: "foodnstuff", since: NOW });
  assert.equal(helperHoldHost({ ram: 20 }, HOSTS, {}, open).host, "zer0");
  assert.equal(helperHoldHost({ ram: 40 }, HOSTS, {}, open).host, "silver-helix");
  // Only home can: 256 - 98 pinned = 158.
  assert.equal(helperHoldHost({ ram: 100 }, HOSTS, {}, open).host, "home");
  // Home is the last resort even when it is the tightest fit.
  const tight = [{ host: "big", max: 1024 }, { host: "home", max: 64, pinned: 30, last: true }];
  assert.equal(helperHoldHost({ ram: 30 }, tight, {}, open).host, "big");
});

test("helperHoldHost: what is already held on a host, and what never lands there, count against it", () => {
  assert.equal(helperHoldHost({ ram: 13 }, HOSTS, { foodnstuff: 10 }, open).host, "joesguns");
  assert.equal(helperHoldHost({ ram: 13 }, HOSTS, { foodnstuff: 10, joesguns: 4 }, open).host, "zer0");
  // A 20GB helper lives on zer0: only 12 of its 32 can ever come free.
  const pinned = HOSTS.map(h => (h.host === "zer0" ? { ...h, pinned: 20 } : h));
  assert.equal(helperHoldHost({ ram: 20 }, pinned, {}, open).host, "silver-helix");
  // ...and the order is by what can come free, not by the size on the label.
  assert.equal(helperHoldHost({ ram: 12 }, pinned, {}, open).host, "zer0");
});

test("helperHoldHost: no hold for a helper bigger than every host, nor past the budget", () => {
  assert.equal(helperHoldHost({ ram: 200 }, HOSTS, {}, open), null);
  assert.equal(helperHoldHost({ ram: 13 }, [], {}, open), null);
  assert.equal(helperHoldHost({ ram: 0 }, HOSTS, {}, open), null);
  assert.equal(helperHoldHost({ ram: 13 }, HOSTS, {}, { ...open, budget: 12.9 }), null);
  assert.equal(helperHoldHost({ ram: 13 }, HOSTS, {}, { ...open, budget: 13 }).host, "foodnstuff");
});

test("helperHoldHost: a manager's dedicated host comes first, if it exists and is big enough", () => {
  const withCloud = [...HOSTS, { host: "cloud-gang", max: 64 }];
  assert.equal(helperHoldHost({ ram: 36, prefer: "cloud-gang" }, withCloud, {}, open).host, "cloud-gang");
  assert.equal(helperHoldHost({ ram: 36, prefer: "cloud-gang" }, HOSTS, {}, open).host, "silver-helix");
  assert.equal(helperHoldHost({ ram: 100, prefer: "cloud-gang" }, withCloud, {}, open).host, "home");
});

test("helperHoldHost: the same host every tick so it drains - until it has had its chance", () => {
  const first = helperHoldHost({ ram: 13 }, HOSTS, {}, open);
  // A smaller host turning up (newly rooted) does not move a hold that is draining.
  const more = [{ host: "aaa", max: 14 }, ...HOSTS];
  const later = helperHoldHost({ ram: 13, prev: first }, more, {}, { ...open, now: NOW + 59_999 });
  assert.deepEqual(later, first, "kept, with the time it was first asked for");
  // moveOnMs later and still not placed: the next host in the order, clock restarted.
  const moved = helperHoldHost({ ram: 13, prev: first }, more, {}, { ...open, now: NOW + 60_000 });
  assert.deepEqual(moved, { host: "joesguns", since: NOW + 60_000 });
  // Round and round rather than giving up: after the last comes the first.
  const lastOne = { host: "home", since: NOW };
  assert.equal(helperHoldHost({ ram: 13, prev: lastOne }, more, {}, { ...open, now: NOW + 60_000 }).host, "aaa");
  // The only host that fits simply starts over.
  assert.deepEqual(
    helperHoldHost({ ram: 100, prev: { host: "home", since: NOW } }, HOSTS, {}, { ...open, now: NOW + 60_000 }),
    { host: "home", since: NOW + 60_000 },
  );
  // A previous host that no longer qualifies (reserved since, or taken by a
  // helper that outranks this one) is forgotten.
  assert.deepEqual(
    helperHoldHost({ ram: 13, prev: first }, HOSTS, { foodnstuff: 16 }, { ...open, now: NOW + 5 }),
    { host: "joesguns", since: NOW + 5 },
  );
});

test("holdBudget: a share of what could be freed at all", () => {
  assert.equal(holdBudget(HOSTS, 0.5), 0.5 * (32 + 16 + 16 + 4 + 64 + 158));
  assert.equal(holdBudget([{ max: 64, pinned: 100 }], 0.5), 0, "a host that is all helpers frees nothing");
  assert.equal(holdBudget([], 0.5), 0);
});

test("heldAgainst: this tick's holds bind everyone but their owner; last tick's bind optional helpers only", () => {
  const wants = [{ script: "lib/sleeves.js", host: "b", gb: 72 }, { script: "lib/go.js", host: "b", gb: 10 }];
  const carried = [{ script: "lib/gang.js", host: "b", gb: 36 }, { script: "lib/gang.js", host: "c", gb: 1 }];
  // A required helper further down the order: outranked by this tick's holds,
  // but it outranks whatever is still to be looked at.
  assert.equal(heldAgainst("lib/hacknet.js", "b", false, wants, carried), 82);
  // An optional one is outranked by all of them.
  assert.equal(heldAgainst("lib/contracts.js", "b", true, wants, carried), 118);
  // Nobody is kept out of their own room.
  assert.equal(heldAgainst("lib/sleeves.js", "b", false, wants, carried), 10);
  assert.equal(heldAgainst("lib/gang.js", "b", true, wants, carried), 82);
  assert.equal(heldAgainst("lib/contracts.js", "a", true, wants, carried), 0);
});

test("chargeTaken: the RAM a LIVE charge manager holds or is still to take, per host", () => {
  const state = {
    updatedAt: NOW,
    ram: { threadRam: 2, hosts: [
      { host: "cloud-0", threads: 100, want: 100 }, { host: "cloud-1", threads: 0, want: 50 },
      { host: "cloud-2", threads: 30, want: 10 }, // being shrunk: what is there still counts
      { host: "home", threads: 20, want: 20 }, { host: "idle", threads: 0, want: 0 },
    ] },
  };
  assert.deepEqual(chargeTaken(state, NOW + 1_000, 60_000), { "cloud-0": 200, "cloud-1": 100, "cloud-2": 60, home: 40 });
  assert.deepEqual(chargeTaken(state, NOW + 60_001, 60_000), {}, "a dead helper's plan binds nobody");
  assert.deepEqual(chargeTaken(null, NOW, 60_000), {});
  assert.deepEqual(chargeTaken({ updatedAt: NOW }, NOW, 60_000), {});
});

// ── End to end: a daemon tick against a full network ─────────────────────────

/** Globals a tick reads or writes; each test starts and ends without them. */
function clean() {
  delete globalThis.gordReservedRam;
  delete globalThis.gordReservedHosts;
  delete globalThis.gordGangPending;
  delete globalThis.gordEvents;
}

/** One daemon tick's worth of helper placement, published the way runDaemon does. */
function tick(net, body, opts = {}) {
  beginHelperTick(net.ns, opts);
  body(net.ns);
  const holds = closeHelperTick(net.ns);
  globalThis.gordReservedRam = holds;
  return holds;
}

const SMALL = { a: { max: 16 }, b: { max: 32 }, c: { max: 64 } };
const REQ = "/lib/required.js";
const REQ2 = "/lib/required-too.js";
const OPT = "/lib/optional.js";
const DAEMON = "/bn1/daemon.js";
const SIZES = { [bare(REQ)]: 20, [bare(REQ2)]: 10, [bare(OPT)]: 10, [bare(DAEMON)]: 90, [bare(P.gang)]: 36 };

/** A network the batcher has already filled, with the daemon on home. */
function fullNet(hosts = SMALL, home = 128, ram = SIZES, extra = {}) {
  clean();
  const net = fakeNet({ hosts, home, ram, extra });
  net.start(DAEMON, "home");
  net.fill();
  return net;
}

test("REGRESSION: a required helper that finds no room is held for, the host drains, it lands, the hold is gone", () => {
  const net = fullNet();
  // Tick 1: every host is full of legs. It used to end here, every tick, for
  // as long as the batcher kept replacing its legs - which is always.
  const first = tick(net, ns => ensureHelper(ns, REQ), { own: DAEMON });
  assert.deepEqual(first, { b: 20 }, "its size, on the smallest host that can hold it");
  assert.equal(net.hostOf(REQ), null);

  // The batcher's legs land, and it launches new ones everywhere but into the hold.
  net.drain();
  net.fill();
  assert.equal(net.free("b"), 20);
  assert.equal(net.free("c"), 0);

  // Tick 2: placed, and nothing is asked for any more.
  const second = tick(net, ns => ensureHelper(ns, REQ), { own: DAEMON });
  assert.equal(net.hostOf(REQ), "b");
  assert.deepEqual(second, {});
  net.fill();
  assert.equal(net.free("b"), 0, "the botnet has the rest of the host back");
  clean();
});

test("an optional helper does not take the room that is draining for a required one, even when it is launched first", () => {
  const net = fullNet();
  // The launch order has the optional helper AHEAD of the required one (as the
  // achievement reader is ahead of the sleeve manager in runDaemon).
  const order = ns => {
    ensureHelper(ns, OPT, { optional: true });
    ensureHelper(ns, REQ);
  };
  tick(net, order, { own: DAEMON });
  net.drain();
  net.fill();
  assert.equal(net.free("b"), 20, "the hold has drained");

  tick(net, order, { own: DAEMON });
  assert.equal(net.hostOf(REQ), "b", "the required helper got its room");
  assert.equal(net.hostOf(OPT), null, "the optional one did not get there first");

  // With the required helper placed, what is free is anyone's again.
  net.drain();
  tick(net, order, { own: DAEMON });
  assert.ok(net.hostOf(OPT));
  clean();
});

test("among required helpers the launch order is the priority: room held for the first is not the second's to take", () => {
  const net = fullNet();
  // b has drained to 15GB free: not yet the 20 the first needs, more than the
  // 10 the second does.
  net.g.legs.b = 17;
  const order = ns => {
    ensureHelper(ns, REQ);
    ensureHelper(ns, REQ2);
  };
  const holds = tick(net, order, { own: DAEMON });
  assert.equal(net.hostOf(REQ2), null, "the second did not land in the first's room");
  assert.deepEqual(holds, { b: 20, a: 10 }, "it is held for elsewhere instead");

  // The other way round is allowed: the first may use what was draining for the second.
  net.drain();
  net.fill();
  net.g.legs.b = 32; // b did not drain after all; a (held for the second) did
  net.g.legs.a = 0;
  net.g.max.a = 20;
  tick(net, order, { own: DAEMON });
  assert.equal(net.hostOf(REQ), "a");
  clean();
});

test("a helper bigger than every host is not held for - it is warned about, once per warnMs", () => {
  const HUGE = "/lib/huge.js";
  const net = fullNet(SMALL, 128, { ...SIZES, [bare(HUGE)]: 100 });
  const order = ns => ensureHelper(ns, HUGE);
  assert.deepEqual(tick(net, order, { own: DAEMON }), {});
  assert.deepEqual(tick(net, order, { own: DAEMON }), {});
  const warned = (globalThis.gordEvents ?? []).filter(e => e.text.includes(bare(HUGE)));
  assert.equal(warned.length, 1, "throttled");
  assert.match(warned[0].text, /no host has 100GB free/);
  assert.match(warned[0].text, /nothing held: no host can free that much \(the largest 64GB\)/);
  clean();
});

test("holds are bounded: past helpers.holds.maxFraction of what could be freed, the rest of the order waits", () => {
  // Room that could be freed: 16 + 32 + 64 off-home, 128 - 90 (daemon) - 8
  // (headroom) = 30 on home: 142GB, so at most 71GB on hold.
  assert.equal(HOLDS.maxFraction, 0.5);
  const net = fullNet(SMALL, 128, { ...SIZES, "lib/r1.js": 40, "lib/r2.js": 30, "lib/r3.js": 10 });
  const holds = tick(net, ns => {
    ensureHelper(ns, "/lib/r1.js");
    ensureHelper(ns, "/lib/r2.js");
    ensureHelper(ns, "/lib/r3.js");
  }, { own: DAEMON });
  assert.deepEqual(holds, { c: 40, b: 30 }, "70 of 71GB: the third waits for one of the first two to be placed");
  assert.ok(net.g.prints.some(p => /r3\.js.*nothing held: 70GB is already held for helpers ahead of it/.test(p)));
  clean();
});

test("no hold on a host that cannot free the room: the daemon and the helpers already there never land", () => {
  const net = fullNet({ b: { max: 32 }, c: { max: 64 } }, 128, { ...SIZES, "lib/resident.js": 20, [bare(REQ)]: 24 });
  // A helper already lives on b - 20 of its 32GB will never come free.
  net.drain();
  net.start("/lib/resident.js", "b");
  net.fill();
  const order = ns => {
    ensureHelper(ns, "/lib/resident.js");
    ensureHelper(ns, REQ);
  };
  assert.deepEqual(tick(net, order, { own: DAEMON }), { c: 24 }, "not b, though 32 >= 24");

  // Home likewise: 128 - 90 for the daemon - 8 headroom = 30, so a 36GB helper
  // is never held for there (it would wait for ever), a 28GB one is.
  const homeOnly = fullNet({}, 128, { ...SIZES, [bare(REQ)]: 36 });
  assert.deepEqual(tick(homeOnly, ns => ensureHelper(ns, REQ), { own: DAEMON }), {});
  const fits = fullNet({}, 128, { ...SIZES, [bare(REQ)]: 28 });
  assert.deepEqual(tick(fits, ns => ensureHelper(ns, REQ), { own: DAEMON }), { home: 28 });
  fits.drain();
  fits.fill();
  tick(fits, ns => ensureHelper(ns, REQ), { own: DAEMON });
  assert.equal(fits.hostOf(REQ), "home", "and home's hold is enough for the launch to leave its headroom");
  clean();
});

test("no hold on a reserved host, nor on RAM the charge workers have taken", () => {
  const net = fullNet();
  globalThis.gordReservedHosts = new Set(["b"]);
  net.drain();
  net.fill();
  assert.deepEqual(tick(net, ns => ensureHelper(ns, REQ), { own: DAEMON }), { c: 20 });
  clean();

  // The charge manager takes whatever comes free on a host in its plan until
  // the plan is full, and its workers never land: a hold there would only feed
  // it. What it leaves of a host can be held - c's last 24GB, home's margin.
  const stanek = fullNet();
  assert.deepEqual(tick(stanek, ns => ensureHelper(ns, REQ), { own: DAEMON, taken: { b: 32, c: 40 } }), { c: 20 });
  const onHome = fullNet();
  assert.deepEqual(tick(onHome, ns => ensureHelper(ns, REQ), { own: DAEMON, taken: { b: 32, c: 64, home: 8 } }), { home: 20 });
  const nowhere = fullNet();
  assert.deepEqual(tick(nowhere, ns => ensureHelper(ns, REQ), { own: DAEMON, taken: { b: 32, c: 64, home: 12 } }), {});
  clean();
});

test("a hold lives only as long as its helper is asked for again", () => {
  const net = fullNet();
  assert.deepEqual(tick(net, ns => ensureHelper(ns, REQ), { own: DAEMON }), { b: 20 });
  // Next tick the node no longer wants it (the gift was settled, the finish
  // was held): nothing is asked for, and nothing lingers.
  assert.deepEqual(tick(net, () => {}, { own: DAEMON }), {});
  // A call outside any tick (a tool, a test) places if it can and holds nothing.
  ensureHelper(net.ns, REQ);
  assert.deepEqual(closeHelperTick(net.ns), {});
  net.drain();
  ensureHelper(net.ns, REQ);
  assert.ok(net.hostOf(REQ));
  clean();
});

test("REGRESSION: an exact fit is a fit - the room a hold drains to is exactly the helper's size", () => {
  clean();
  // 64 - 57.35 is 6.649999999999999 in floating point, and the helper is 6.65GB:
  // the game starts it (exec allows 0.001GB), so the placement must not refuse to try.
  assert.ok(64 - 57.35 < 6.65);
  const net = fakeNet({ hosts: { x: { max: 64 } }, home: 16, ram: { "lib/exact.js": 6.65, [bare(DAEMON)]: 16 } });
  net.start(DAEMON, "home");
  net.g.legs.x = 57.35;
  tick(net, ns => ensureHelper(ns, "/lib/exact.js"), { own: DAEMON });
  assert.equal(net.hostOf("/lib/exact.js"), "x");
  // ...and the same when choosing where to hold: 64 - 57.35 pinned can free 6.65.
  assert.equal(helperHoldHost({ ram: 6.65 }, [{ host: "x", max: 64, pinned: 57.35 }], {}, open).host, "x");
  clean();
});

test("no hold for a helper that RAM is not what is stopping: a refused launch, a script that is not there", () => {
  // The room is free and the game still will not start it (a broken import,
  // a missing file on the host): holding more RAM for it would hold it for ever.
  clean();
  const REFUSED = "/lib/refused.js";
  const refusing = fakeNet({ hosts: SMALL, home: 128, ram: { ...SIZES, [bare(REFUSED)]: 20 }, extra: { exec: () => 0 } });
  assert.deepEqual(tick(refusing, ns => ensureHelper(ns, REFUSED), { own: DAEMON }), {});
  assert.ok(refusing.g.prints.some(p => /refused\.js.*nothing held: c had the room and the game would not start it there/.test(p)));

  // A script that is not on home: getScriptRam says 0 and exec says no.
  const missing = fullNet(SMALL, 128, { ...SIZES, "lib/missing.js": 0 }, { exec: () => 0 });
  assert.deepEqual(tick(missing, ns => ensureHelper(ns, "/lib/missing.js"), { own: DAEMON }), {});
  assert.equal(missing.hostOf("/lib/missing.js"), null);
  clean();
});

// ── Managers ─────────────────────────────────────────────────────────────────

test("the gang manager is held for on its dedicated host, and ends up there", () => {
  const hosts = { ...SMALL, "cloud-gang": { max: 64 } };
  const net = fullNet(hosts, 256, SIZES, { gang: { inGang: () => true } });
  const reserved = new Set();
  const holds = tick(net, ns => ensureGangManager(ns, reserved), { own: DAEMON });
  assert.deepEqual(holds, { "cloud-gang": 36 }, "not c, which is the same size and comes first by name");
  assert.equal(globalThis.gordGangPending, true);
  assert.equal(reserved.size, 0, "the host is the botnet's until the manager is on it");

  net.drain();
  net.fill();
  const after = tick(net, ns => ensureGangManager(ns, reserved), { own: DAEMON });
  assert.equal(net.hostOf(P.gang), "cloud-gang");
  assert.deepEqual(after, {});
  assert.equal(globalThis.gordGangPending, false);
  assert.ok(reserved.has("cloud-gang"), "and now the whole host is reserved from the botnet");
  clean();
});

test("the gang manager without a dedicated host: any host that fits, home with its slack as the last resort", () => {
  const net = fullNet(SMALL, 256, SIZES, { gang: { inGang: () => true } });
  assert.deepEqual(tick(net, ns => ensureGangManager(ns, new Set()), { own: DAEMON }), { c: 36 });

  const homeOnly = fullNet({ a: { max: 16 } }, 256, SIZES, { gang: { inGang: () => true } });
  const holds = tick(homeOnly, ns => ensureGangManager(ns, new Set()), { own: DAEMON });
  assert.deepEqual(holds, { home: 36 + CONFIG.gang.homeReserveSlack });

  // Not in a gang: nothing is placed, held or pending.
  const none = fullNet(SMALL, 256, SIZES);
  assert.deepEqual(tick(none, ns => ensureGangManager(ns, new Set()), { own: DAEMON }), {});
  assert.equal(globalThis.gordGangPending, false);
  assert.equal(none.hostOf(P.gang), null);
  clean();
});

test("placeManager: a manager already on its dedicated host keeps it reserved; one elsewhere does not", () => {
  const net = fullNet({ ...SMALL, "cloud-corp": { max: 64 } }, 256, { ...SIZES, "lib/boss.js": 30 });
  net.drain();
  net.start("/lib/boss.js", "cloud-corp");
  const reserved = new Set();
  tick(net, ns => placeManager(ns, "/lib/boss.js", "cloud-corp", reserved), { own: DAEMON });
  assert.deepEqual([...reserved], ["cloud-corp"]);

  net.stop("/lib/boss.js");
  net.start("/lib/boss.js", "c");
  const none = new Set();
  tick(net, ns => placeManager(ns, "/lib/boss.js", "cloud-corp", none), { own: DAEMON });
  assert.equal(none.size, 0);
  clean();
});

// ── One walk per tick ────────────────────────────────────────────────────────

/** A mid-game network: 69 world servers and 25 purchased ones, all rooted. */
function bigNet() {
  const hosts = {};
  for (let i = 0; i < 69; i++) hosts[`srv-${String(i).padStart(2, "0")}`] = { max: 64 };
  for (let i = 0; i < 25; i++) hosts[`cloud-${i}`] = { max: 1024 };
  return hosts;
}

test("a tick walks the network once, and finds each running helper with one call", () => {
  clean();
  const running = Array.from({ length: 12 }, (_, i) => `/lib/helper-${i}.js`);
  const waiting = ["/lib/luxury-a.js", "/lib/luxury-b.js"];
  const net = fakeNet({ hosts: bigNet(), home: 1024, ram: { [bare(DAEMON)]: 90 } });
  net.start(DAEMON, "home");
  running.forEach((s, i) => net.start(s, `cloud-${i * 2}`));
  net.fill();
  const all = Object.keys(net.g.max).length; // 95 hosts

  const body = ns => {
    for (const s of running) ensureHelper(ns, s);
    for (const s of waiting) ensureHelper(ns, s, { optional: true });
  };
  // The first tick has to find everything.
  net.takeCounts();
  tick(net, body, { own: DAEMON });
  const cold = net.takeCounts();
  assert.equal(cold.by.scan, all, "one walk");
  assert.equal(cold.by.hasRootAccess, all - 1, "one rooting pass (home needs none)");

  // Every tick after it: one walk, one scriptRunning per running helper, and
  // one per host for each helper that is running nowhere.
  tick(net, body, { own: DAEMON });
  const warm = net.takeCounts();
  assert.equal(warm.by.scan, all);
  assert.equal(warm.by.hasRootAccess, all - 1);
  assert.equal(warm.by.scriptRunning, running.length + waiting.length * all);
  assert.equal(net.g.started.length, 1 + running.length, "and nothing was started twice");
  clean();
});

test("the tick's memory is a hint, not a belief: a helper that moved, died or lost its host is still handled", () => {
  clean();
  const net = fakeNet({ hosts: SMALL, home: 128, ram: SIZES });
  const body = ns => ensureHelper(ns, OPT, { optional: true });
  tick(net, body);
  const first = net.hostOf(OPT);
  assert.ok(first);

  // Killed and restarted elsewhere behind the daemon's back (a sync + kill-helpers).
  net.stop(OPT);
  const elsewhere = first === "a" ? "b" : "a";
  net.start(OPT, elsewhere);
  tick(net, body);
  assert.equal(net.g.procs.filter(p => p.script === bare(OPT)).length, 1, "found where it now is; no second copy");

  // Its host is gone (a purchased server after an install): nothing throws, and it is relaunched.
  net.stop(OPT);
  delete net.g.max[elsewhere];
  net.g.rooted.delete(elsewhere);
  tick(net, body);
  assert.ok(net.hostOf(OPT));
  clean();
});

test("what a tick saw is not carried into another process's tick, nor across a yield as 'not running'", () => {
  clean();
  const one = fakeNet({ hosts: SMALL, home: 128, ram: SIZES });
  const two = fakeNet({ hosts: { z: { max: 64 } }, home: 128, ram: SIZES });
  // A daemon dies mid-tick: its tick is never closed.
  beginHelperTick(one.ns, { own: DAEMON });
  ensureHelper(one.ns, REQ);
  // Another process (the module is shared - the game caches it) is unaffected.
  ensureHelper(two.ns, REQ);
  assert.equal(two.hostOf(REQ), "z");
  assert.deepEqual(closeHelperTick(two.ns), {}, "and cannot close a tick that is not its own");
  closeHelperTick(one.ns);

  // "Running nowhere" does not survive a yield: something else may have started it.
  const net = fakeNet({ hosts: SMALL, home: 128, ram: SIZES });
  beginHelperTick(net.ns, { own: DAEMON });
  net.fill();
  ensureHelper(net.ns, OPT, { optional: true }); // no room: seen running nowhere
  net.drain();
  net.start(OPT, "c");                           // ...started by hand while the daemon awaited
  helperTickYielded(net.ns);
  ensureHelper(net.ns, OPT, { optional: true });
  closeHelperTick(net.ns);
  assert.equal(net.g.procs.filter(p => p.script === bare(OPT)).length, 1);
  clean();
});

test("the finisher is stopped on every host when the finish is held, in one sweep per tick", () => {
  clean();
  const saved = globalThis.gordAutoFinish;
  globalThis.gordAutoFinish = false;
  globalThis.gordBackdoorState = { finalReady: true, finalHost: "w0r1d_d43m0n", updatedAt: Date.now() };
  try {
    const net = fakeNet({ hosts: SMALL, home: 128, ram: SIZES, extra: { read: () => "off", write: () => {} } });
    net.start(P.finishBn, "a");
    net.start(P.finishBn, "c");
    net.takeCounts();
    tick(net, ns => ensureBackdoorHelpers(ns, 1, 12), { own: DAEMON });
    assert.equal(net.hostOf(P.finishBn), null, "both copies");
    assert.ok(net.hostOf(P.backdoor));
    // backdoor: looked for on 4 hosts; finisher: one sweep of 4, not the two
    // the two hold checks used to make.
    assert.equal(net.takeCounts().by.scriptRunning, 8);
  } finally {
    if (saved === undefined) delete globalThis.gordAutoFinish; else globalThis.gordAutoFinish = saved;
    delete globalThis.gordBackdoorState;
    delete globalThis.gordAwaitingManualBN;
    clean();
  }
});

// ── The whole daemon tick ────────────────────────────────────────────────────

const STOP = new Error("stop the fake daemon");

/**
 * Enough of a game for lib/daemon-core.js runDaemon to tick: the fake network,
 * a player with no factions and no augs, and a decision that does nothing.
 * `afterTick(i)` runs where the daemon sleeps - the batcher's turn.
 */
function daemonGame({ hosts, home = 1024, ram = {}, reset = {}, hacking = 500, extra = {}, ticks = 1, afterTick = () => {} }) {
  clean();
  const resetInfo = {
    currentNode: 1, ownedSF: new Map([[4, 3]]), lastNodeReset: 1_000, lastAugReset: Date.now() - 60_000,
    bitNodeOptions: { sourceFileOverrides: new Map() },
    ...reset,
  };
  let done = 0;
  const net = fakeNet({
    hosts, home, ram: { [bare(DAEMON)]: 86, ...ram },
    extra: {
      getResetInfo: () => resetInfo,
      read: () => "", write: () => {},
      getPlayer: () => ({ money: 1e6, skills: { hacking }, factions: [], karma: 0, mults: {} }),
      getHackingLevel: () => hacking,
      hasTorRouter: () => true,
      fileExists: () => true,
      getFavorToDonate: () => 150,
      getMoneySources: () => ({ sinceInstall: { total: 0 }, sinceStart: { total: 0 } }),
      sleep: async () => {
        afterTick(++done);
        if (done >= ticks) throw STOP;
      },
      singularity: {
        checkFactionInvitations: () => [], getOwnedAugmentations: () => [], getAugmentationsFromFaction: () => [],
        getFactionRep: () => 0, getDarkwebProgramCost: () => 0,
      },
      corporation: { hasCorporation: () => false },
      ...extra,
    },
  });
  net.start(DAEMON, "home");
  // Already read this BitNode, so the one-shots that would publish them stay out of the way.
  globalThis.gordAchievements = { ids: [], updatedAt: Date.now() };
  globalThis.gordAugStats = { stats: {}, count: 1 };
  return net;
}

/** Run the real daemon loop until the fake stops it. */
async function runTicks(net, cfg, hooks = {}) {
  const { runDaemon } = await import("../lib/daemon-core.js");
  try {
    await runDaemon(net.ns, { cfg, self: DAEMON, decide: async () => ({ action: "Idle", detail: "", target: null, infra: null }), ...hooks });
  } catch (e) {
    if (e !== STOP) throw e;
  }
}

function cleanDaemon() {
  clean();
  for (const key of ["gordAchievements", "gordAugStats", "gordState", "gordCampaign", "gordGiftPending", "gordAugPipeline",
    "gordAugSnapshot", "gordAugSavingFor", "gordLastReset", "gordNodeStamp", "gordFactionPipeline", "gordHadCorp",
    "gordCorpPending", "gordCorpNodeStamp", "gordInstallRequested", "gordStanekState"]) delete globalThis[key];
}

test("a whole daemon tick: one walk of the network, one scriptRunning per running helper", async () => {
  const { forNode } = await import("../lib/config.js");
  const counts = [];
  let net;
  net = daemonGame({
    hosts: bigNet(), ticks: 3,
    reset: { ownedSF: new Map([[2, 3], [4, 3], [10, 3]]) },
    extra: { gang: { inGang: () => true } },
    afterTick: () => counts.push(net.takeCounts()),
  });
  net.takeCounts();
  await runTicks(net, forNode(1));
  const helpers = net.g.procs.length - 1;
  assert.ok(helpers >= 10, `the usual helpers are all up (${helpers})`);
  const all = Object.keys(net.g.max).length;
  // The steady state: everything is running, nothing to place.
  const steady = counts[2].by;
  assert.equal(steady.scan, all, "one walk - this was thirteen");
  assert.equal(steady.hasRootAccess, all - 1);
  assert.equal(steady.scriptRunning, helpers);
  assert.equal(steady.exec ?? 0, 0);
  assert.ok(counts[2].total < 300, `ns calls in a steady tick: ${counts[2].total} (was 3,163 on this network)`);
  cleanDaemon();
});

test("the daemon replaces gordReservedRam once a tick: holds for what found no room, nothing left over", async () => {
  const { forNode } = await import("../lib/config.js");
  const published = [];
  const sizes = { [bare(P.backdoor)]: 9, [bare(P.sleeves)]: 72, [bare(P.manager)]: 10, [bare(P.dashboard)]: 5 };
  let net;
  net = daemonGame({
    hosts: { h1: { max: 128 }, h2: { max: 128 }, h3: { max: 128 } }, home: 128, ram: sizes, ticks: 3,
    reset: { ownedSF: new Map([[4, 3], [10, 3]]) },
    afterTick: () => {
      published.push({ ...globalThis.gordReservedRam });
      net.drain();
      net.fill();
    },
  });
  net.fill();
  // Left by the driver, or by the last node's daemon.
  globalThis.gordReservedRam = { "cloud-gang": 44, home: 13.1 };
  await runTicks(net, forNode(1), { sleevesOptional: false });

  // Tick 1: the four required helpers, in launch order, all on the first host
  // that can free the room - and the stale entries are gone.
  assert.deepEqual(published[0], { h1: 9 + 72 + 10 + 5 });
  // Tick 2: the room drained and they took it; the luxury scripts launched
  // around them did not.
  assert.deepEqual(published[1], {});
  for (const s of [P.backdoor, P.sleeves, P.manager, P.dashboard]) assert.equal(net.hostOf(s), "h1", s);
  assert.deepEqual(net.g.started.map(s => s.script).slice(1).sort(), [P.backdoor, P.sleeves, P.manager, P.dashboard].map(bare).sort());
  assert.deepEqual(published[2], {});
  cleanDaemon();
});

test("a sleeve manager that would exit at once is never required: nothing is held for it", async () => {
  const { forNode } = await import("../lib/config.js");
  const published = [];
  const net = daemonGame({
    hosts: { h1: { max: 128 } }, home: 128, ticks: 1,
    ram: { [bare(P.sleeves)]: 72, [bare(P.backdoor)]: 200, [bare(P.manager)]: 200, [bare(P.dashboard)]: 200 },
    afterTick: () => published.push({ ...globalThis.gordReservedRam }),
  });
  net.fill();
  // A Bladeburner node makes sleeves required - but this player has no SF10.
  await runTicks(net, forNode(1), { sleevesOptional: false });
  assert.deepEqual(published[0], {});
  cleanDaemon();
});

test("the charge workers' holds are folded into the same map, the larger of the two on a shared host", async () => {
  const { forNode } = await import("../lib/config.js");
  const published = [];
  const net = daemonGame({
    hosts: { h1: { max: 64 }, h2: { max: 128 } }, home: 256, ticks: 1,
    ram: { [bare(P.backdoor)]: 9, [bare(P.manager)]: 300, [bare(P.dashboard)]: 300 },
    reset: { currentNode: 13, lastNodeReset: 1_000 },
    afterTick: () => published.push({ ...globalThis.gordReservedRam }),
  });
  net.fill();
  globalThis.gordStanekState = {
    gate: "accepted", resetAt: 1_000, updatedAt: Date.now(),
    holds: { h1: 60, home: 70 },
    ram: { threadRam: 2, hosts: [{ host: "h1", threads: 0, want: 30 }, { host: "home", threads: 0, want: 3 }] },
  };
  await runTicks(net, forNode(13), { sleevesOptional: true });
  // backdoor.js (9GB) is held for on h2 - not on h1, the smaller host, where the
  // charge manager would take the room as it drained - and the charge holds
  // ride along in the same map.
  assert.deepEqual(published[0], { h1: 60, home: 70, h2: 9 });
  cleanDaemon();
});

test("the daemon launches the hacknet-node buyer only while the RUN's config wants it", async () => {
  const { forNode, forReset, CHALLENGE } = await import("../lib/config.js");
  const one = { h1: { max: 1024 } };
  const startedNodes = net => net.g.procs.filter(p => p.script === bare(P.hacknetNodes));

  // Early in an ordinary node: launched, and told the node.
  const early = daemonGame({ hosts: one, hacking: 50 });
  await runTicks(early, forNode(1));
  assert.deepEqual(startedNodes(early).map(p => p.args), [[1]]);
  assert.ok(early.hostOf(P.econ), "next to econ.js, which no longer carries it");

  // Past the level cap: never started.
  const late = daemonGame({ hosts: one, hacking: CONFIG.econ.hacknetMaxHackingLevel + 1 });
  await runTicks(late, forNode(1));
  assert.deepEqual(startedNodes(late), []);
  assert.ok(late.hostOf(P.econ));

  // BN9 entered as its challenge run (zero hacknet spending), at hacking level 1.
  const reset = {
    currentNode: 9, ownedSF: new Map([[4, 3], [9, 1]]),
    bitNodeOptions: { ...CHALLENGE[9].options, sourceFileOverrides: new Map([[1, 3]]) },
  };
  const challenge = daemonGame({ hosts: one, hacking: 1, reset, ticks: 2 });
  await runTicks(challenge, forReset(challenge.ns.getResetInfo()));
  assert.deepEqual(startedNodes(challenge), []);
  assert.equal(challenge.hostOf(P.hacknet), null, "nor the hacknet-server manager");
  cleanDaemon();
});
