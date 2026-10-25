// tests/achievements.test.mjs
// The achievement plan: reading held achievements out of a save, challenge runs
// in the campaign, and the config a challenge run plays with.
// Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  ACHIEVEMENT_PLAN,
  GROUP_ORDER,
  missingByGroup,
  extractArray,
  extractSourceFiles,
  parseSaveProgress,
  progressScanner,
} from "../lib/achievements-logic.js";
import {
  campaignStep,
  campaignNext,
  challengeMarker,
  challengeEntryOptions,
  capabilitiesFromReset,
} from "../lib/capabilities.js";
import { CONFIG, CHALLENGE, forNode, forReset, isChallengeRun } from "../lib/config.js";

// A save as the game writes it: the player record is a JSON string inside JSON.
const player = {
  ctor: "PlayerObject",
  data: {
    sourceFiles: { ctor: "JSONMap", data: [[1, 3], [12, 7]] },
    achievements: [{ ID: "CYBERSEC", unlockedOn: 1 }, { ID: "CHALLENGE_BN13", unlockedOn: 2 }],
    money: 5,
    exploits: ["YoureNotMeantToAccessThis"],
  },
};
const saveText = JSON.stringify({ ctor: "BitburnerSaveObject", data: { PlayerSave: JSON.stringify(player), AllServersSave: "{}" } });

test("parseSaveProgress pulls both lists out of a double-encoded save without parsing it", () => {
  assert.deepEqual(parseSaveProgress(saveText), {
    ids: ["CYBERSEC", "CHALLENGE_BN13"],
    exploits: ["YoureNotMeantToAccessThis"],
    ownedSF: [[1, 3], [12, 7]],
  });
  // An un-nested player record reads the same way.
  assert.deepEqual(parseSaveProgress(JSON.stringify(player.data))?.ids, ["CYBERSEC", "CHALLENGE_BN13"]);
  assert.deepEqual(parseSaveProgress(JSON.stringify(player.data))?.ownedSF, [[1, 3], [12, 7]]);
  // Empty lists are lists, not "missing"; no Source-File list is ownedSF null.
  assert.deepEqual(parseSaveProgress('{"achievements":[],"exploits":[]}'), { ids: [], exploits: [], ownedSF: null });
  assert.equal(parseSaveProgress("{}"), null);
});

test("extractSourceFiles reads the OWNED levels, never the run's overrides", () => {
  // The overrides come first here, and use the same JSONMap shape.
  const text = JSON.stringify({ bitNodeOptions: { sourceFileOverrides: { ctor: "JSONMap", data: [[12, 0]] } }, sourceFiles: { ctor: "JSONMap", data: [[12, 9], [4, 3]] } });
  assert.deepEqual(extractSourceFiles(text), [[12, 9], [4, 3]]);
  assert.deepEqual(extractSourceFiles(JSON.stringify(JSON.stringify({ sourceFiles: { ctor: "JSONMap", data: [] } }))), []);
  // Cut short: no answer yet, rather than a wrong one.
  assert.equal(extractSourceFiles('{"sourceFiles":{"ctor":"JSONMap","data":[[1,3],[2'), null);
  assert.equal(extractSourceFiles('{"sourceFiles":{"ctor":"JSONMap","data":[[1,3]'), null);
  assert.equal(extractSourceFiles('{"sourceFileOverrides":{"ctor":"JSONMap","data":[[1,3]]}}'), null);
});

test("extractArray waits for the closing bracket", () => {
  assert.equal(extractArray('{"exploits":["A","B', "exploits"), null);
  assert.deepEqual(extractArray('{"exploits":["A","B"]}', "exploits")?.items, ["A", "B"]);
});

test("progressScanner finds the lists in a stream cut anywhere, however far apart", () => {
  for (const size of [1, 7, 64, saveText.length]) {
    const scanner = progressScanner();
    let found = null;
    for (let i = 0; i < saveText.length && !found; i += size) found = scanner.feed(saveText.slice(i, i + size));
    assert.deepEqual(found?.ids, ["CYBERSEC", "CHALLENGE_BN13"], `chunk size ${size}`);
  }
  // Megabytes between the two lists: the first one found is kept while the
  // window that held it scrolls away.
  const scanner = progressScanner();
  assert.equal(scanner.feed('{\\"achievements\\":[{\\"ID\\":\\"NS2\\"}],'), null);
  for (let i = 0; i < 40; i++) assert.equal(scanner.feed("x".repeat(100_000)), null);
  // Both lists but no Source-Files yet: keep reading; the stream's end settles for the lists.
  assert.equal(scanner.feed('\\"exploits\\":[]'), null);
  assert.deepEqual(scanner.partial(), { ids: ["NS2"], exploits: [], ownedSF: null });
  assert.deepEqual(scanner.feed(',\\"sourceFiles\\":{\\"ctor\\":\\"JSONMap\\",\\"data\\":[[12,3]]}'), { ids: ["NS2"], exploits: [], ownedSF: [[12, 3]] });
  assert.equal(progressScanner().partial(), null);
});

test("the plan table is well formed and groups what is missing", () => {
  for (const [id, a] of Object.entries(ACHIEVEMENT_PLAN)) {
    assert.ok(a.name && a.how, `${id} needs a name and a how`);
    assert.ok(GROUP_ORDER.includes(a.group), `${id} has unknown group ${a.group}`);
  }
  const groups = missingByGroup(Object.keys(ACHIEVEMENT_PLAN).filter(id => id !== "BYPASS" && id !== "SF8.1"));
  assert.deepEqual(groups.map(g => [g.group, g.items.map(i => i.id)]), [["sf", ["SF8.1"]], ["exploit", ["BYPASS"]]]);
  // Every challenge the config can enter is an achievement the plan describes.
  for (const c of Object.values(CHALLENGE)) assert.ok(ACHIEVEMENT_PLAN[c.achievement], c.achievement);
});

// ── Challenge runs ───────────────────────────────────────────────────────────

const at = (currentNode, owned, bitNodeOptions = {}) => ({ currentNode, ownedSF: new Map(owned), bitNodeOptions });
const MARK = { sourceFileOverrides: new Map([[1, 3]]) };

test("isChallengeRun needs the node's options AND the entry marker", () => {
  assert.equal(isChallengeRun(at(2, [])), false);
  assert.equal(isChallengeRun(at(2, [], { disableGang: true, sourceFileOverrides: new Map() })), false);
  assert.equal(isChallengeRun(at(2, [], { ...MARK })), false);
  assert.equal(isChallengeRun(at(2, [], { disableGang: true, ...MARK })), true);
  // BN13 has no option to set: the marker alone says so.
  assert.equal(isChallengeRun(at(13, [], { sourceFileOverrides: new Map() })), false);
  assert.equal(isChallengeRun(at(13, [], { ...MARK })), true);
  // A node with no challenge is never one, marker or not.
  assert.equal(isChallengeRun(at(5, [], { ...MARK })), false);
  // The marker as a saved JSONMap or pairs (what a test or a tool may hold).
  assert.equal(isChallengeRun(at(13, [], { sourceFileOverrides: [[1, 3]] })), true);
});

test("forReset overlays the challenge config only on a challenge run", () => {
  assert.equal(forReset(at(7, [])), forNode(7));
  const cfg = forReset(at(7, [], { disableBladeburner: true, ...MARK }));
  assert.equal(cfg.bladeburner.enabled, false);
  assert.equal(cfg.paths.daemon, "/bn1/daemon.js");
  assert.equal(cfg.name, forNode(7).name);
  assert.equal(forNode(7).bladeburner.enabled, true, "the node's own config is untouched");
  assert.equal(forReset(at(13, [], { ...MARK })).stanek.enabled, false);
  assert.equal(forReset(at(14, [], { ...MARK })).go.enabled, false);
  assert.equal(forReset(at(9, [], { disableHacknetServer: true, ...MARK })).hacknet.enabled, false);
});

test("capabilities drop a mechanic the BitNode options disable", () => {
  const owned = [[2, 1], [3, 3], [6, 1], [9, 1]];
  const plain = capabilitiesFromReset(at(4, owned));
  assert.deepEqual([plain.gang, plain.corporation, plain.bladeburner, plain.hacknetServer], [true, true, true, true]);
  const off = capabilitiesFromReset(at(4, owned, { disableGang: true, disableCorporation: true, disableBladeburner: true, disableHacknetServer: true }));
  assert.deepEqual([off.gang, off.corporation, off.bladeburner, off.hacknetServer], [false, false, false, false]);
  assert.equal(capabilitiesFromReset(at(2, owned, { disableGang: true })).gang, false, "even in the mechanic's own node");
});

test("challengeMarker is a level-3 Source-File other than SF12", () => {
  assert.deepEqual(challengeMarker(at(7, [[1, 3], [4, 3]])), [1, 3]);
  assert.deepEqual(challengeMarker(at(7, [[1, 2], [12, 3], [10, 3]])), [10, 3]);
  assert.equal(challengeMarker(at(7, [[1, 2], [12, 3]])), null);
});

test("challengeEntryOptions: the node's options plus the marker, as plain JSON", () => {
  const reset = at(14, [[1, 3]]);
  assert.deepEqual(challengeEntryOptions(reset, 2), { disableGang: true, sourceFileOverrides: [[1, 3]] });
  assert.deepEqual(challengeEntryOptions(reset, 13), { sourceFileOverrides: [[1, 3]] });
  assert.equal(challengeEntryOptions(reset, 5), null, "no challenge for BN5");
  assert.equal(challengeEntryOptions(at(14, []), 2), null, "no marker possible");
  assert.doesNotThrow(() => JSON.stringify(challengeEntryOptions(reset, 2)));
});

test("campaignStep: a challenge step is one run, and it counts for the level too", () => {
  const order = /** @type {[number, number | "challenge"][]} */ ([[13, 1], [13, "challenge"], [13, 3], [9, 3]]);
  const none = new Set(["CYBERSEC"]);
  const owned = level => [[1, 3], [9, 3], ...(level ? [[13, level]] : [])];

  // First BN13 run ending: level 1 lands, the challenge is next.
  assert.deepEqual(campaignStep(at(13, owned(0)), order, none), { node: 13, challenge: true, waiting: false });
  // The challenge run ending: it earns the achievement and 13.2; one plain run left.
  const inChallenge = at(13, owned(1), { ...MARK });
  assert.deepEqual(campaignStep(inChallenge, order, none), { node: 13, challenge: false, waiting: false });
  // Third run ending with the achievement on record: the plan moves on (and is done).
  assert.deepEqual(campaignStep(at(13, owned(2)), order, new Set(["CHALLENGE_BN13"])), { node: 0, challenge: false, waiting: false });
  // A plain run that somehow did not earn it goes back in as a challenge run.
  assert.deepEqual(campaignStep(at(13, owned(2)), order, none), { node: 13, challenge: true, waiting: false });
  assert.equal(campaignNext(at(13, owned(2)), order, none), 13);
});

test("campaignStep waits rather than guesses when the achievements are unknown", () => {
  const order = /** @type {[number, number | "challenge"][]} */ ([[9, 3], [3, "challenge"], [5, 3]]);
  const reset = at(9, [[1, 3], [9, 2], [5, 1]]);
  assert.deepEqual(campaignStep(reset, order, null), { node: 0, challenge: false, waiting: true });
  assert.deepEqual(campaignStep(reset, order, new Set()), { node: 3, challenge: true, waiting: false });
  // Unknown achievements do not matter while a level step comes first.
  assert.deepEqual(campaignStep(at(9, [[1, 3], [9, 1]]), order, null), { node: 9, challenge: false, waiting: false });
  // No marker possible: the challenge is skipped, not entered as a run that could never satisfy it.
  assert.deepEqual(campaignStep(at(9, [[9, 2], [5, 1]]), order, new Set()), { node: 5, challenge: false, waiting: false });
});

test("the shipped campaign: every step names a real node, every challenge exists, the plain daemon exists", () => {
  for (const [node, target] of CONFIG.campaign.order) {
    assert.ok(forNode(node).paths.daemon, `BN${node} has no daemon`);
    if (target === "challenge") assert.ok(CHALLENGE[node], `no CHALLENGE entry for BN${node}`);
    else assert.ok(Number.isInteger(target) && target >= 1, `bad level for BN${node}`);
  }
  for (const [node, c] of Object.entries(CHALLENGE)) {
    const daemon = c.config.paths?.daemon ?? forNode(Number(node)).paths.daemon;
    assert.ok(existsSync(new URL(`..${daemon}`, import.meta.url)), `${daemon} (BN${node} challenge) does not exist`);
  }
  // From the owner's position today (in BN7 going for 7.2) the plan's next node is BN9.
  const today = at(7, [[1, 3], [2, 1], [3, 3], [4, 3], [5, 1], [6, 1], [7, 1], [9, 1], [10, 3]]);
  assert.deepEqual(campaignStep(today, CONFIG.campaign.order, new Set()), { node: 9, challenge: false, waiting: false });
  // From the 2026-10-23 save (finishing BN14.1): BN11.1, then BN8.1.
  const bn14 = at(14, [[1, 3], [2, 1], [3, 3], [4, 3], [5, 3], [6, 1], [7, 3], [9, 3], [10, 3], [13, 1]]);
  assert.deepEqual(campaignStep(bn14, CONFIG.campaign.order, new Set()), { node: 11, challenge: false, waiting: false });
  // 2026-10-25, finishing BN8.1: its challenge run next, then 11.2 and 11.3.
  const OWNED = [[1, 3], [2, 1], [3, 3], [4, 3], [5, 3], [6, 1], [7, 3], [9, 3], [10, 3], [11, 1], [13, 1], [14, 1]];
  const bn8 = at(8, OWNED);
  assert.deepEqual(campaignStep(bn8, CONFIG.campaign.order, new Set()), { node: 8, challenge: true, waiting: false });
  const bn8ch = at(8, [...OWNED, [8, 1]], { disable4SData: true, sourceFileOverrides: new Map([[1, 3]]) });
  assert.deepEqual(campaignStep(bn8ch, CONFIG.campaign.order, new Set()), { node: 11, challenge: false, waiting: false });
  const bn11 = at(11, [...OWNED.filter(([n]) => n !== 11), [8, 2], [11, 2]]);
  assert.deepEqual(campaignStep(bn11, CONFIG.campaign.order, new Set(["CHALLENGE_BN8"])), { node: 12, challenge: false, waiting: false });
  // Then BN12 again and again - each run entered at SF12 level 0, so the owned
  // level comes from the save - until 50, then the BN13 challenge.
  // The reset of a BN12 run: getResetInfo() has SF12 at its override (0, so absent).
  const bn12 = at(12, [...OWNED.filter(([n]) => n !== 11), [8, 2], [11, 3]], { sourceFileOverrides: new Map([[12, 0]]) });
  const savedAt = level => {
    const held = /** @type {any} */ (new Set(["CHALLENGE_BN8"]));
    held.ownedSF = new Map([...OWNED, [8, 2], [11, 3], [12, level]]);
    return held;
  };
  const order = CONFIG.campaign.order;
  assert.deepEqual(campaignStep(bn12, order, savedAt(0)), { node: 12, challenge: false, waiting: false }, "about to own 1 of 50");
  assert.deepEqual(campaignStep(bn12, order, savedAt(37)), { node: 12, challenge: false, waiting: false });
  assert.deepEqual(campaignStep(bn12, order, savedAt(49)), { node: 13, challenge: true, waiting: false });
  // The save not read in this run: wait, never guess (a guess of 0 loops forever).
  assert.deepEqual(campaignStep(bn12, order, new Set(["CHALLENGE_BN8"])), { node: 0, challenge: false, waiting: true });
  // Source-File 12 at 50 already proved by its achievement: on to BN13.
  assert.deepEqual(campaignStep(bn12, order, new Set(["CHALLENGE_BN8", "CHALLENGE_BN12"])), { node: 13, challenge: true, waiting: false });
  // The end of the plan: the five challenge-only runs, BN10 last.
  const late = at(14, [[1, 3], [2, 3], [3, 3], [4, 3], [5, 3], [6, 3], [7, 3], [8, 3], [9, 3], [10, 3], [11, 3], [12, 50], [13, 3], [14, 2], [15, 3]]);
  const all = new Set(["CHALLENGE_BN2", "CHALLENGE_BN6", "CHALLENGE_BN8", "CHALLENGE_BN13", "CHALLENGE_BN14"]);
  assert.deepEqual(campaignStep(late, CONFIG.campaign.order, all), { node: 9, challenge: true, waiting: false });
  all.add("CHALLENGE_BN9"); all.add("CHALLENGE_BN7"); all.add("CHALLENGE_BN3"); all.add("CHALLENGE_BN1");
  assert.deepEqual(campaignStep(late, CONFIG.campaign.order, all), { node: 10, challenge: true, waiting: false });
});

test("the plan covers THE_VOID with its tool, and the tool exists", () => {
  assert.match(ACHIEVEMENT_PLAN.THE_VOID.how, /tools\/void\.js/);
  assert.ok(existsSync(new URL("../tools/void.js", import.meta.url)));
});

test("the HUD's open steps: done ones drop out, the one this run earns is marked", async () => {
  const { openSteps } = await import("../ui/achievements.js");
  const today = at(7, [[1, 3], [2, 1], [3, 3], [4, 3], [5, 1], [6, 1], [7, 1], [9, 1], [10, 3]]);
  const steps = openSteps(today, new Set(["CHALLENGE_BN3"]));
  assert.deepEqual(steps[0], { node: 7, text: "BN7 to 7.2", done: false, inHand: true });
  assert.equal(steps[1].text, "BN9 to 9.3");
  assert.ok(!steps.some(s => s.text === "BN3 challenge"), "a held challenge is not an open step");
  assert.ok(steps.some(s => s.text === "BN13 challenge"));
  // In a challenge run, that step is the one in hand.
  const run = at(13, [[1, 3], [13, 1]], { sourceFileOverrides: new Map([[1, 3]]) });
  assert.equal(openSteps(run, new Set()).find(s => s.text === "BN13 challenge")?.inHand, true);
  // A BN12 run at SF12 level 0: with the save's owned level the step is in hand,
  // and the owned level - not the override - says what is done.
  const bn12 = at(12, [[1, 3], [5, 3], [7, 3], [9, 3], [11, 3]], { sourceFileOverrides: new Map([[12, 0]]) });
  const step12 = openSteps(bn12, new Set(), new Map([[12, 49]])).find(s => s.node === 12);
  assert.deepEqual(step12, { node: 12, text: "BN12 to 12.50", done: false, inHand: true });
  assert.ok(!openSteps(bn12, new Set(), new Map([[12, 50]])).some(s => s.node === 12));
});
