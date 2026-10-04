// tests/donations.test.mjs
// Favor and donations: the game's favor curve (lib/aug-targets.js), buying an
// aug's missing reputation with money (lib/daemon-lib.js buyAugs), the "favor"
// install reason, and idle rep banking toward the donation threshold. All of it
// moves money or triggers a reset, and none of it shows up until late in a
// node, so the rules are pinned here.
// Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  favorToRep, repToFavor, favorAfterInstall, repToUnlockDonations, pickFavorBankFaction,
} from "../lib/aug-targets.js";
import {
  buyAugs, nextAugPurchase, donationCost, worthDonating, installReason, favorInstallCandidate,
} from "../lib/daemon-lib.js";
import { CONFIG, forNode } from "../lib/config.js";

const HOUR = 3_600_000;

// ── The favor curve ──────────────────────────────────────────────────────────

test("favor curve matches the game's (favor.ts): 150 favor is ~462k reputation", () => {
  assert.ok(Math.abs(favorToRep(150) - 462_490) < 50, String(favorToRep(150)));
  assert.equal(favorToRep(0), 0);
  for (const f of [1, 37.5, 150, 300]) assert.ok(Math.abs(repToFavor(favorToRep(f)) - f) < 1e-9);
  // An install folds this run's reputation into the favor already held.
  assert.ok(Math.abs(favorAfterInstall(0, favorToRep(150)) - 150) < 1e-9);
  assert.ok(Math.abs(favorAfterInstall(100, favorToRep(150) - favorToRep(100)) - 150) < 1e-9);
  assert.ok(Math.abs(repToUnlockDonations(100, 0, 150) - (favorToRep(150) - favorToRep(100))) < 1e-6);
  assert.equal(repToUnlockDonations(150, 0, 150), 0);
  assert.equal(repToUnlockDonations(0, 1e9, 150), 0);
});

// ── Donation sizing ──────────────────────────────────────────────────────────

test("donationCost: shortfall -> dollars, rounded up, padded, never free on an unknown rate", () => {
  assert.equal(donationCost(1000, 1e-6), 1e9);
  assert.equal(donationCost(1000, 1e-6, 0.01), 1.01e9);
  assert.equal(donationCost(0, 1e-6), 0);
  assert.equal(donationCost(-5, 1e-6), 0);
  assert.equal(donationCost(1000, 0), Infinity);
});

test("worthDonating: not for reputation the work slot delivers in minutes", () => {
  const policy = CONFIG.augs.donate;
  const perMs = repPerMin => repPerMin / 60_000;
  assert.equal(worthDonating({ repShort: 1000, repRatePerMs: perMs(1000) }, policy), false); // 1 minute away
  assert.equal(worthDonating({ repShort: 1000, repRatePerMs: perMs(10) }, policy), true);    // 100 minutes
  assert.equal(worthDonating({ repShort: 1000, repRatePerMs: 0 }, policy), true);            // not being ground
  assert.equal(worthDonating({ repShort: 0, repRatePerMs: 0 }, policy), false);
  // Nor when grinding is the cheaper way: 100 minutes of grind, but the $1b it
  // costs takes 1000 minutes to earn back. At ten times the income it is worth it.
  const dear = { repShort: 1000, repRatePerMs: perMs(10), donation: 1e9 };
  assert.equal(worthDonating({ ...dear, incomePerMs: 1e9 / (1000 * 60_000) }, policy), false);
  assert.equal(worthDonating({ ...dear, incomePerMs: 1e9 / (10 * 60_000) }, policy), true);
  assert.equal(worthDonating({ ...dear, incomePerMs: 0 }, policy), true); // income unknown: no comparison
});

test("nextAugPurchase: a donation counts toward what must fit, not toward the order", () => {
  const o = { spendable: 10e9, incomePerMs: 0, horizonMs: HOUR };
  const ready = [{ aug: "ready", price: 2e9 }, { aug: "donated", price: 1e9, donation: 7e9 }];
  // Dearest PRICE first - the donation raises nobody's price.
  assert.equal(nextAugPurchase(ready, o).buy.aug, "ready");
  // price + donation must fit: 1 + 7 = 8 does, 1 + 12 doesn't (and isn't near).
  assert.equal(nextAugPurchase([ready[1]], o).buy.aug, "donated");
  assert.deepEqual(nextAugPurchase([{ aug: "donated", price: 1e9, donation: 12e9 }], o), { buy: null, savingFor: null });
  // ...but within reach of income it is saved for, and nothing cheaper is bought.
  const near = nextAugPurchase(
    [{ aug: "donated", price: 5e9, donation: 6e9 }, { aug: "cheap", price: 1e9 }],
    { spendable: 10e9, incomePerMs: 1000, horizonMs: HOUR },
  );
  assert.equal(near.buy, null);
  assert.equal(near.savingFor.aug, "donated");
});

// ── buyAugs, end to end over a fake game ─────────────────────────────────────

/**
 * world: { money, repPerDollar (what the GAME gives), factionRepMult (what the
 * player sheet says), factions: {name: {rep, favor, augs, noWork?}},
 * augs: {name: {price, repReq, prereq?}}, owned: [] }
 */
function fakeGame(world) {
  const log = { donations: [], bought: [] };
  const priceOf = a => world.augs[a].price * Math.pow(1.9, log.bought.length);
  const ns = {
    getPlayer: () => ({ money: world.money, factions: Object.keys(world.factions), mults: { faction_rep: world.factionRepMult ?? 1 } }),
    getFavorToDonate: () => 150,
    fileExists: () => false, // no Formulas.exe: the closed-form + probe path
    gang: { inGang: () => false },
    format: { number: n => String(Math.round(n)) },
    singularity: {
      getOwnedAugmentations: () => [...world.owned],
      getFactionRep: f => world.factions[f].rep,
      getFactionFavor: f => world.factions[f].favor,
      getAugmentationsFromFaction: f => world.factions[f].augs,
      getAugmentationRepReq: a => world.augs[a].repReq,
      getAugmentationPrereq: a => world.augs[a].prereq ?? [],
      getAugmentationPrice: priceOf,
      purchaseAugmentation: (f, a) => {
        const price = priceOf(a);
        if (world.factions[f].rep < world.augs[a].repReq || world.money < price) return false;
        world.money -= price;
        world.owned.push(a);
        log.bought.push(a);
        return true;
      },
      donateToFaction: (f, amount) => {
        const fac = world.factions[f];
        if (fac.noWork || fac.favor < 150 || world.money < amount) return false;
        world.money -= amount;
        fac.rep += amount * world.repPerDollar;
        log.donations.push({ faction: f, amount });
        return true;
      },
    },
  };
  return { ns, log };
}

function reset(over = {}) {
  globalThis.gordMoneyFloor = over.floor ?? 0;
  globalThis._incomeRatePerMs = over.income ?? 0;
  globalThis._repSnaps = over.snaps ?? {};
}

test("buyAugs: without Formulas the first donation is a probe, then the measured rate sizes the rest", () => {
  // The player sheet says faction_rep 2 (so the closed form expects 2 rep per
  // $1m), but the BitNode halves it: the game really gives 1. Trusting the
  // guess would donate half of what's needed and strand the money.
  reset();
  const world = {
    money: 10e9, repPerDollar: 1e-6, factionRepMult: 2, owned: [],
    factions: { Daedalus: { rep: 100_000, favor: 150, augs: ["X"] } },
    augs: { X: { price: 1e9, repReq: 101_000 } },
  };
  const { ns, log } = fakeGame(world);
  const bought = buyAugs(ns);

  assert.deepEqual(log.bought, ["X"]);
  assert.equal(log.donations.length, 2);
  assert.equal(log.donations[0].amount, CONFIG.augs.donate.probeAmount);
  // The second is the real one: the remaining 999 rep at the MEASURED $1m/rep, +1%.
  assert.equal(log.donations[1].amount, Math.ceil(999 / 1e-6 * 1.01));
  assert.ok(world.factions.Daedalus.rep >= 101_000);
  assert.ok(bought.some(line => line.includes("donated to Daedalus for X")));
  assert.ok(bought.includes("X from Daedalus"));
});

test("buyAugs: a faction below the donation threshold is never donated to", () => {
  reset();
  const world = {
    money: 100e9, repPerDollar: 1e-6, owned: [],
    factions: { BitRunners: { rep: 100_000, favor: 149.9, augs: ["X"] } },
    augs: { X: { price: 1e9, repReq: 101_000 } },
  };
  const { ns, log } = fakeGame(world);
  assert.deepEqual(buyAugs(ns), []);
  assert.deepEqual(log.donations, []);
  assert.equal(world.money, 100e9);
});

test("buyAugs: donation + price must fit above the money floor - else nothing is donated", () => {
  // $3b in hand, $2b of it held for a faction invite: $1b spendable. The aug is
  // $0.5b but its reputation costs $1.01b - donating would sink the cash into
  // rep for an aug we then couldn't pay for.
  reset({ floor: 2e9 });
  const world = {
    money: 3e9, repPerDollar: 1e-6, owned: [],
    factions: { Daedalus: { rep: 100_000, favor: 200, augs: ["X"] } },
    augs: { X: { price: 0.5e9, repReq: 101_000 } },
  };
  const { ns, log } = fakeGame(world);
  assert.deepEqual(buyAugs(ns), []);
  assert.deepEqual(log.donations, []);
  assert.equal(globalThis.gordAugSavingFor, null);

  // With income that covers the gap inside the save horizon it is SAVED for
  // (still nothing donated), and the published price includes the donation.
  reset({ floor: 2e9, income: 1000 });
  assert.deepEqual(buyAugs(ns), []);
  assert.deepEqual(log.donations, []);
  assert.equal(globalThis.gordAugSavingFor.aug, "X");
  assert.equal(globalThis.gordAugSavingFor.donation, 1.01e9);
  assert.equal(globalThis.gordAugSavingFor.price, 0.5e9 + 1.01e9);
  assert.equal(world.money, 3e9);
});

test("buyAugs: ready augs still go dearest-first; the donated one takes its place by price", () => {
  reset();
  const world = {
    money: 20e9, repPerDollar: 1e-6, owned: [],
    factions: {
      Daedalus: { rep: 100_000, favor: 150, augs: ["Donated"] },
      CyberSec: { rep: 50_000, favor: 0, augs: ["Ready"] },
    },
    augs: { Donated: { price: 1e9, repReq: 101_000 }, Ready: { price: 2e9, repReq: 10_000 } },
  };
  const { ns, log } = fakeGame(world);
  buyAugs(ns);
  assert.deepEqual(log.bought, ["Ready", "Donated"]);
  assert.equal(log.donations.length, 1);
  assert.equal(log.donations[0].faction, "Daedalus");
  assert.equal(log.donations[0].amount, 1.01e9);
});

test("buyAugs: no donation for reputation the work slot is minutes from delivering", () => {
  reset({ snaps: { Daedalus: { time: Date.now(), rep: 100_000, rate: 1000 / 60_000 } } });
  const world = {
    money: 20e9, repPerDollar: 1e-6, owned: [],
    factions: { Daedalus: { rep: 100_000, favor: 150, augs: ["X"] } },
    augs: { X: { price: 1e9, repReq: 101_000 } },
  };
  const { ns, log } = fakeGame(world);
  assert.deepEqual(buyAugs(ns), []);
  assert.deepEqual(log.donations, []);
  // A STALE snapshot (work we've since left) doesn't hold the donation back.
  reset({ snaps: { Daedalus: { time: Date.now() - 10 * CONFIG.augs.repRateMaxAgeMs, rep: 0, rate: 1000 / 60_000 } } });
  buyAugs(ns);
  assert.deepEqual(log.bought, ["X"]);
});

test("buyAugs: a faction that refuses donations is dropped, not retried forever", () => {
  reset();
  const world = {
    money: 20e9, repPerDollar: 1e-6, owned: [],
    factions: { "Some Special Faction": { rep: 100_000, favor: 500, noWork: true, augs: ["X"] } },
    augs: { X: { price: 1e9, repReq: 101_000 } },
  };
  const { ns, log } = fakeGame(world);
  let asked = 0;
  const donate = ns.singularity.donateToFaction;
  ns.singularity.donateToFaction = (f, a) => { asked++; return donate(f, a); };
  assert.deepEqual(buyAugs(ns), []);
  assert.deepEqual(buyAugs(ns), []);
  assert.equal(asked, 1, "asked once, remembered");
  assert.deepEqual(log.bought, []);
  assert.equal(world.money, 20e9);
});

test("the no-work factions are on the no-donation list", () => {
  for (const f of ["Bladeburners", "Church of the Machine God", "Shadows of Anarchy"]) {
    assert.ok(CONFIG.factions.noDonation.includes(f), f);
  }
});

// ── The "favor" install reason ───────────────────────────────────────────────

const DEFAULT = CONFIG.augs.install;
const st = (over = {}) => ({ queued: 0, redPillQueued: false, hasPriorityAug: false, allPriorityDone: false, elapsedMs: 0, ...over });

// Grinding Daedalus: 500k rep this run (an install folds that into > 150 favor),
// 2m more to The Red Pill at a rate that makes it 10 hours.
const grinding = (over = {}) => ({
  faction: "Daedalus", favor: 0, rep: 500_000, maxWantedRep: 2_500_000, repRatePerMs: 2_000_000 / (10 * HOUR), ...over,
});
// Income that buys the same 2m rep in `hours` at $1m per rep.
const market = hours => ({ threshold: 150, repPerDollar: 1e-6, incomePerMs: 2_000_000 / 1e-6 / (hours * HOUR) });

test("favorInstallCandidate: only a faction the reset would carry over the threshold, with a measured grind left", () => {
  const c = favorInstallCandidate([grinding()], market(0.5));
  assert.equal(c.faction, "Daedalus");
  assert.ok(Math.abs(c.grindMs - 10 * HOUR) < 1 && Math.abs(c.payMs - 0.5 * HOUR) < 1);

  assert.equal(favorInstallCandidate([grinding({ rep: 400_000 })], market(0.5)), null, "reset wouldn't unlock");
  assert.equal(favorInstallCandidate([grinding({ favor: 150 })], market(0.5)), null, "already donating");
  assert.equal(favorInstallCandidate([grinding({ repRatePerMs: 0 })], market(0.5)), null, "nobody is grinding it");
  assert.equal(favorInstallCandidate([grinding({ maxWantedRep: 400_000 })], market(0.5)), null, "nothing left to grind");
  assert.equal(favorInstallCandidate([grinding()], { ...market(0.5), incomePerMs: 0 }), null, "no income to donate");
  // Favor already banked counts: 100 favor (~156k rep's worth) + 310k rep crosses
  // the ~462k line, 0 favor + 310k doesn't.
  assert.ok(favorInstallCandidate([grinding({ favor: 100, rep: 310_000 })], market(0.5)));
  assert.equal(favorInstallCandidate([grinding({ favor: 0, rep: 310_000 })], market(0.5)), null);
});

test("installReason 'favor': fires only when buying the reputation clearly beats grinding it", () => {
  const favor = favorInstallCandidate([grinding()], market(0.5));
  const live = { queued: 1, elapsedMs: 2 * HOUR, favor };
  assert.equal(installReason(st(live), DEFAULT), "favor");

  // Never with an empty queue (the game refuses the install), never early in a run.
  assert.equal(installReason(st({ ...live, queued: 0 }), DEFAULT), null);
  assert.equal(installReason(st({ ...live, elapsedMs: DEFAULT.favorMinRunMs - 1 }), DEFAULT), null);
  // Not for a short grind...
  const short = favorInstallCandidate([grinding({ repRatePerMs: 2_000_000 / (1 * HOUR) })], market(0.1));
  assert.equal(installReason(st({ ...live, favor: short }), DEFAULT), null);
  // ...and not when money buys the reputation barely faster than work earns it.
  const poor = favorInstallCandidate([grinding()], market(5));
  assert.equal(installReason(st({ ...live, favor: poor }), DEFAULT), null);
  // No candidate, or the switch off: the old policy, unchanged.
  assert.equal(installReason(st({ ...live, favor: null }), DEFAULT), null);
  assert.equal(installReason(st(live), { ...DEFAULT, favorInstall: false }), null);
});

test("BN7 and BN9 keep their batching: 'favor' needs more queued, and BN9 a far better deal", () => {
  const good = favorInstallCandidate([grinding()], market(0.5));   // pays in 5% of the grind
  const fair = favorInstallCandidate([grinding()], market(2));     // 20%
  for (const node of [7, 9]) {
    const policy = forNode(node).augs.install;
    assert.equal(installReason(st({ queued: 1, elapsedMs: 2 * HOUR, favor: good }), policy), null, `BN${node} on one aug`);
    assert.equal(installReason(st({ queued: 2, elapsedMs: 2 * HOUR, favor: good }), policy), "favor");
  }
  // 20% is fine by default and in BN7, not in BN9 (a reset there costs the fleet).
  assert.equal(installReason(st({ queued: 2, elapsedMs: 2 * HOUR, favor: fair }), DEFAULT), "favor");
  assert.equal(installReason(st({ queued: 2, elapsedMs: 2 * HOUR, favor: fair }), forNode(9).augs.install), null);
  // BN9 also wants a longer grind saved: 4 hours isn't one.
  const fourHours = favorInstallCandidate([grinding({ repRatePerMs: 2_000_000 / (4 * HOUR) })], market(0.1));
  assert.equal(installReason(st({ queued: 2, elapsedMs: 2 * HOUR, favor: fourHours }), DEFAULT), "favor");
  assert.equal(installReason(st({ queued: 2, elapsedMs: 2 * HOUR, favor: fourHours }), forNode(9).augs.install), null);
});

// ── Idle rep banking ─────────────────────────────────────────────────────────

const fac = (faction, over = {}) => ({
  faction, favor: 0, rep: 0, donatable: true, sellsWanted: false, sellsNeuroFlux: true, ...over,
});

test("pickFavorBankFaction: one NeuroFlux seller, the closest - and none once one is covered", () => {
  const pick = pickFavorBankFaction([fac("CyberSec"), fac("NiteSec", { favor: 100 })], 150);
  assert.equal(pick.faction, "NiteSec");
  assert.ok(Math.abs(pick.repToGo - (favorToRep(150) - favorToRep(100))) < 1e-6);

  // A faction already donating - or about to, on the next install - covers it.
  assert.equal(pickFavorBankFaction([fac("CyberSec"), fac("NiteSec", { favor: 150 })], 150), null);
  assert.equal(pickFavorBankFaction([fac("CyberSec"), fac("NiteSec", { rep: 500_000 })], 150), null);
  // The gang's faction (or a no-work one) neither counts nor is picked.
  assert.equal(pickFavorBankFaction([fac("Slum Snakes", { donatable: false })], 150), null);
  assert.equal(
    pickFavorBankFaction([fac("Slum Snakes", { donatable: false, favor: 900 }), fac("CyberSec")], 150).faction,
    "CyberSec",
  );
});

test("pickFavorBankFaction: a faction still selling a real aug always qualifies, and goes first", () => {
  const rows = [
    fac("NiteSec", { favor: 150 }),                       // NeuroFlux covered
    fac("CyberSec", { favor: 140 }),                      // close, but only NeuroFlux left
    fac("BitRunners", { favor: 10, sellsWanted: true }),  // far, but sells something we want
  ];
  assert.equal(pickFavorBankFaction(rows, 150).faction, "BitRunners");
  assert.equal(pickFavorBankFaction([], 150), null);
});

// ── Leftovers pinned alongside ───────────────────────────────────────────────

test("REGRESSION: the bootstrap mug is not re-issued (and so restarted) every tick", async () => {
  const { doEarlyBootstrapIfNeeded } = await import("../lib/player-actions.js");
  let work = null;
  let commits = 0;
  const ns = {
    getPlayer: () => ({ money: 0, skills: { hacking: 60, strength: 5, defense: 5 } }),
    getHackingLevel: () => 60,
    hasTorRouter: () => false,
    fileExists: () => false,
    read: () => "",
    write: () => {},
    format: { number: n => String(n), percent: n => String(n) },
    singularity: {
      getCrimeChance: () => 0.9,
      getOwnedAugmentations: () => [],
      getCurrentWork: () => work,
      setFocus: () => true,
      commitCrime: crime => { commits++; work = { type: "CRIME", crimeType: crime }; return 4000; },
    },
  };
  assert.equal((await doEarlyBootstrapIfNeeded(ns)).action, "Crime");
  assert.equal((await doEarlyBootstrapIfNeeded(ns)).action, "Crime");
  assert.equal((await doEarlyBootstrapIfNeeded(ns)).action, "Crime");
  assert.equal(commits, 1);
  // Something else took the slot: start it again.
  work = { type: "CLASS" };
  await doEarlyBootstrapIfNeeded(ns);
  assert.equal(commits, 2);
});

test("company-work reads the live megacorp gate (0.75x once the server is backdoored)", async () => {
  const { makeCompanyWork } = await import("../lib/company-work.js");
  const cfg = forNode(10);
  const ns = live => ({
    singularity: {
      getOwnedAugmentations: () => [],
      getAugmentationsFromFaction: () => ["Some Aug"],
      getCompanyRep: () => 310_000,
      getFactionInviteRequirements: f => {
        if (!live) throw new Error("unavailable");
        return [{ type: "employedBy", company: f }, { type: "companyReputation", company: f, reputation: 300_000 }];
      },
    },
  });
  const ops = live => makeCompanyWork(cfg).opportunities(ns(live), { joined: new Set(), invited: new Set() });
  assert.ok(ops(true).length > 0);
  assert.ok(ops(true).every(o => o.companyRepReq === 300_000 && o.companyRepMissing === 0));
  // Requirement unreadable: the config constant.
  assert.ok(ops(false).every(o => o.companyRepReq === cfg.factions.companyRepReq && o.companyRepMissing === 90_000));
  // Company work is not city-locked in any node now (workForCompany has no city check).
  for (const node of [9, 10]) assert.equal(forNode(node).factions.companyWorkNeedsCity, false);
});
