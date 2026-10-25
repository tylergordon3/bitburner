// lib/achievements-logic.js
//
// The achievements that take planning, and how to read which ones the player
// already holds. Pure - no Netscript, no RAM - so the HUD, the daemon's campaign
// plan, the Node tests and the offline tool (offline/achievements.mjs) all share
// one table.
//
// Where the facts come from: bitburner-src src/Achievements/Achievements.ts (the
// conditions) and src/Exploits/* (the SF-1 easter eggs). The game has ~109
// achievements; the sixty-odd that arrive by simply playing (join a faction, buy
// a program, ...) are not listed. What is listed is everything that needs a
// decision: a BitNode to enter, an option to enter it with, a run to hold open,
// or a trick.
//
// Groups, in the order worth doing them:
//   sf        - a first Source-File. Arrives with the campaign (campaign.order).
//   challenge - "finish BN-n WITHOUT its mechanic". A campaign step of
//               [n, "challenge"] enters the node with the right BitNode options
//               and the config that goes with them (CHALLENGE in lib/config.js).
//   endgame   - needs absurd money. All of them fall out of ONE long run with a
//               mature corporation; see docs/ACHIEVEMENTS.md "The money run".
//   grind     - time, not planning.
//   exploit   - the developers' easter eggs: run tools/exploits.js.
//   special   - one-offs with a trick to them.

/** @typedef {{ name: string, group: string, how: string }} PlannedAchievement */

/** @type {Record<string, PlannedAchievement>} */
export const ACHIEVEMENT_PLAN = {
  // ── First Source-Files ──────────────────────────────────────────────────────
  "SF8.1": { name: "Ghost of Wall Street", group: "sf", how: "Finish BN8 (bn8/daemon.js: the stock trader is the only income there)." },
  "SF11.1": { name: "The Big Crash", group: "sf", how: "Finish BN11." },
  "SF12.1": { name: "The Recursion", group: "sf", how: "Finish BN12." },
  "SF13.1": { name: "They're lunatics", group: "sf", how: "Finish BN13." },
  "SF14.1": { name: "IPvGO Subnet Takeover", group: "sf", how: "Finish BN14." },
  "SF15.1": { name: "The Secrets of the Dark Net", group: "sf", how: "Finish BN15. Daedalus does not sell The Red Pill there (the dark net's labs do), so the bot's way out would be the Bladeburner black ops (slow at rank x0.2) - BITNODE[15] does not run Bladeburner yet." },
  BN_DESTROYER: { name: "More BitNodes, please!", group: "sf", how: "Source-File level 3 in all fifteen BitNodes - the end of campaign.order." },
  FAST_BN: { name: "Speed demon", group: "sf", how: "Finish any BitNode inside 48 hours of entering it. A BN12 run (entered at SF12 level 0, so as easy as BN12.1) should do it by itself." },

  // ── Challenges ──────────────────────────────────────────────────────────────
  CHALLENGE_BN1: { name: "BN1: Challenge", group: "challenge", how: "Finish BN1 with home at 128GB or less and one core: campaign step [1, \"challenge\"]." },
  CHALLENGE_BN2: { name: "BN2: Challenge", group: "challenge", how: "Finish BN2 without ever forming a gang: [2, \"challenge\"]." },
  CHALLENGE_BN3: { name: "BN3: Challenge", group: "challenge", how: "Finish BN3 without a corporation: [3, \"challenge\"]." },
  CHALLENGE_BN6: { name: "BN6: Challenge", group: "challenge", how: "Finish BN6 by hacking, never joining Bladeburner: [6, \"challenge\"]." },
  CHALLENGE_BN7: { name: "BN7: Challenge", group: "challenge", how: "Finish BN7 by hacking, never joining Bladeburner: [7, \"challenge\"]." },
  CHALLENGE_BN8: { name: "BN8: Challenge", group: "challenge", how: "Finish BN8 without buying 4S market data (either kind): [8, \"challenge\"]." },
  CHALLENGE_BN9: { name: "BN9: Challenge", group: "challenge", how: "Finish BN9 with no hacknet spending or income at all: [9, \"challenge\"]." },
  CHALLENGE_BN10: { name: "BN10: Challenge", group: "challenge", how: "Finish BN10 with sleeves that never gained exp or augs: [10, \"challenge\"]. The bot never ends BN10 itself - you backdoor w0r1d_d43m0n." },
  CHALLENGE_BN12: { name: "BN12: Challenge", group: "challenge", how: "Source-File 12 at level 50: a campaign step of [12, 50], fifty runs - each entered at SF12 level 0, so each plays at BN12.1's difficulty (campaign.recursionLevel)." },
  CHALLENGE_BN13: { name: "BN13: Challenge", group: "challenge", how: "Finish BN13 without accepting Stanek's Gift: [13, \"challenge\"]." },
  CHALLENGE_BN14: { name: "BN14: Challenge", group: "challenge", how: "Finish BN14 with no IPvGO move made through the API: [14, \"challenge\"]." },
  CHALLENGE_BN15: { name: "BN15: Challenge", group: "challenge", how: "Finish BN15 without calling dnet.heartbleed. The bot never touches the dark net, so any BN15 finish it makes earns it." },

  // ── The money run ───────────────────────────────────────────────────────────
  CORPORATION_BRIBE: { name: "Lobbying is great!", group: "endgame", how: "Buy the corporation's Government Partnership unlock." },
  CORPORATION_EMPLOYEE_3000: { name: "Small town", group: "endgame", how: "One division with 3,000 employees across its offices (six cities of 500)." },
  ALL_HACKNET_SERVER: { name: "Full network", group: "endgame", how: "Own all 20 hacknet servers (needs BN9 or SF9)." },
  MAX_HACKNET_SERVER: { name: "That's the new limit", group: "endgame", how: "One hacknet server at level 300, 8,192GB, 128 cores, cache 15 - the last cores cost ~$1e30." },
  QUEUE_40: { name: "It's time to install", group: "endgame", how: "40 augmentations bought and not yet installed - every NeuroFlux level is its own entry; each queued aug raises the next one's price x1.9 (x1.767 with SF11.3), except Shadows of Anarchy augs (game v3.0.1; the next release also exempts the dark net lab augs). Hold the install: augs.install thresholds." },
  INSTALL_100: { name: "I asked for this", group: "endgame", how: "100 different augmentations installed in one BitNode - nearly every faction's list, plus grafts." },
  NEUROFLUX_255: { name: "Neuroflux is love, Neuroflux is life", group: "endgame", how: "NeuroFlux Governor level 255 installed. Levels reset per BitNode; cost and rep both grow 14% a level." },
  MAX_RAM: { name: "Download more ram", group: "endgame", how: "Home RAM at the cap, 2^30 GB - the last doubling alone is ~$1e19." },
  MONEY_1Q: { name: "Here comes the money!", group: "endgame", how: "$1e18 in hand at once." },
  HACKING_100000: { name: "Power Overwhelming", group: "endgame", how: "Hacking level 100,000: the hacking multiplier NeuroFlux 255 gives, in a node that does not cut hacking levels." },

  // ── Grinds ──────────────────────────────────────────────────────────────────
  STOCK_1q: { name: "Wolf of Wall Street", group: "grind", how: "$1e15 of stock-market profit inside one BitNode. BN8 is where the trader runs longest." },
  INTELLIGENCE_255: { name: "Smart!", group: "grind", how: "Intelligence 255 - roughly 28 times the intelligence exp of level 148. Comes with finishing nodes, grafting, black ops and program creation." },
  BLADEBURNER_UNSPENT_100000: { name: "You should really spend those...", group: "grind", how: "100,000 Bladeburner skill points unspent at once (~300,000 rank): bladeburner.skillPointBank: 100_000 in a Bladeburner node's BITNODE entry, with FINISH off - it only banks once the black ops are done or Operation Daedalus is ready and held." },
  DARKNET_BACKDOOR: { name: "Make your Own Network", group: "grind", how: "Backdoors on 50 dark net servers at once (stasis-linked ones do not count). Any node: DarkscapeNavigator.exe ($50m on the dark web, $30m at Chongqing's Shadowed Walkway) opens the dark net. No automation here yet." },
  DARKNET_DEPTHS: { name: "Into the Depths", group: "grind", how: "Install The Sword, the sixth dark net lab's prize (seventh in BN15). The labs need BN15 or SF15, and each lab's prize is chosen by what is INSTALLED, so it is six lab clears with an install after each, in one node. No automation here yet." },
  IPVGO_WINNING_STREAK: { name: "Ten Steps Ahead", group: "grind", how: "Ten wins in a row against Illuminati (no faction needed). go.streak: the Go helper plays only Illuminati until it lands - on in BN14. An install wipes the streak." },

  // ── Exploits (Source-File -1) ───────────────────────────────────────────────
  BYPASS: { name: "Exploit: bypass", group: "exploit", how: "run tools/exploits.js" },
  PROTOTYPETAMPERING: { name: "Exploit: prototype tampering", group: "exploit", how: "run tools/exploits.js (the game only checks every 15 minutes)" },
  UNCLICKABLE: { name: "Exploit: unclickable", group: "exploit", how: "run tools/exploits.js, then click the box it shows" },
  UNDOCUMENTEDFUNCTIONCALL: { name: "Exploit: undocumented", group: "exploit", how: "run tools/exploits.js" },
  TIMECOMPRESSION: { name: "Exploit: time compression", group: "exploit", how: "run tools/exploits.js" },
  RAINBOW: { name: "Exploit: rainbow", group: "exploit", how: "run tools/exploits.js" },
  N00DLES: { name: "Exploit: noodles", group: "exploit", how: "City > New Tokyo > Noodle Bar > Eat noodles" },
  REALITYALTERATION: { name: "Exploit: reality alteration", group: "exploit", how: "run tools/exploits.js --reality with DevTools open" },
  EDITSAVEFILE: { name: "Exploit: edit", group: "exploit", how: "node offline/edit-save.mjs, then import the file it writes" },
  TRUE_RECURSION: { name: "Exploit: true recursion", group: "exploit", how: "New Tokyo Arcade: finish BN1 in the game inside the game (docs/ACHIEVEMENTS.md has the short way)" },
  DEVMENU: { name: "Exploit: you're not meant to access this", group: "exploit", how: "Open the dev menu." },

  // ── One-offs ────────────────────────────────────────────────────────────────
  MONEY_M1B: { name: "Massive debt", group: "special", how: "$1b in debt. Classes charge without checking your balance: spend down to zero, stop the income, and put yourself and every sleeve in Powerhouse Gym (~13 hours)." },
  IPVGO_ANTICHEAT: { name: "IPvGO anticheat", group: "special", how: "Get ejected for cheating at IPvGO: a failed cheat, after any earlier cheat attempt in the same game, has a 10% chance. The cheat API needs SF14.2, or BN14 with SF14.1 held - not a first BN14 run, and never the BN14 challenge run (a cheat voids it). Not automated." },
  THE_VOID: { name: "The Void", group: "special", how: "Not in game v3.0.1 - it arrives with the next release. Then: run tools/void.js (singularity.goToLocation(\"The Void\")), or by hand: Ishima > \"0x6C1\" and wait ~25 seconds." },
  UNACHIEVABLE: { name: "UNACHIEVABLE", group: "special", how: "Its condition is hard-coded false (the source says to modify it). Edit your save: offline/edit-save.mjs --achievement UNACHIEVABLE, then import the copy." },
};

export const GROUP_ORDER = ["sf", "challenge", "endgame", "grind", "exploit", "special"];
export const GROUP_LABEL = {
  sf: "SOURCE-FILES",
  challenge: "CHALLENGES",
  endgame: "THE MONEY RUN",
  grind: "GRINDS",
  exploit: "EXPLOITS (SF-1)",
  special: "ONE-OFFS",
};

/**
 * The planned achievements the player does not hold yet, grouped in doing order.
 * @param {Iterable<string>} owned - achievement IDs the player holds
 * @returns {{ group: string, label: string, items: (PlannedAchievement & { id: string })[] }[]}
 */
export function missingByGroup(owned) {
  const have = new Set(owned);
  return GROUP_ORDER.map(group => ({
    group,
    label: GROUP_LABEL[group],
    items: Object.entries(ACHIEVEMENT_PLAN)
      .filter(([id, a]) => a.group === group && !have.has(id))
      .map(([id, a]) => ({ id, ...a })),
  })).filter(g => g.items.length > 0);
}

/**
 * Pull one array out of the save text without parsing the save: `"key":[ ... ]`
 * with no nested arrays, which is what both lists wanted here look like. The
 * player record is a JSON string INSIDE the save's JSON, so its quotes arrive
 * escaped (\"key\":[); a save that is not double-encoded is handled too.
 *
 * indexOf rather than a regular expression on purpose: Bitburner's static RAM
 * analysis bills identifiers by name, and a regex's `.exec` reads as ns.exec.
 * @param {string} text @param {string} key
 * @returns {{ items: any[], end: number } | null} null while the array is not
 *   (yet) complete in `text` - the caller may be feeding a stream.
 */
export function extractArray(text, key) {
  for (const quote of ['\\"', '"']) {
    const marker = `${quote}${key}${quote}:[`;
    const at = text.indexOf(marker);
    if (at < 0) continue;
    const close = text.indexOf("]", at + marker.length);
    if (close < 0) return null;
    const body = text.slice(at + marker.length - 1, close + 1);
    try {
      return { items: JSON.parse(quote === '"' ? body : body.split('\\"').join('"')), end: close + 1 };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The Source-Files the player OWNS, out of the save's player record:
 * `"sourceFiles":{"ctor":"JSONMap","data":[[1,3],[2,1]]}` (escaped quotes when the
 * record is a string inside the save). Not getResetInfo().ownedSF, which holds the
 * ACTIVE levels - an override (every BN12 run) hides the owned one there.
 * "sourceFileOverrides" is a different key and never matches.
 * @param {string} text
 * @returns {[number, number][] | null} null while not (yet) complete in `text`
 */
export function extractSourceFiles(text) {
  for (const quote of ['\\"', '"']) {
    const marker = `${quote}sourceFiles${quote}:{`;
    const at = text.indexOf(marker);
    if (at < 0) continue;
    const dataKey = `${quote}data${quote}:[`;
    const data = text.indexOf(dataKey, at + marker.length);
    if (data < 0) return null;
    const open = data + dataKey.length - 1;
    // The pairs hold numbers only, so the list ends at the first "]]" - or at
    // once when it is empty.
    const close = text[open + 1] === "]" ? open + 1 : text.indexOf("]]", open) + 1;
    if (close <= 0) return null;
    try {
      const pairs = JSON.parse(text.slice(open, close + 1));
      if (!Array.isArray(pairs)) return null;
      return pairs
        .filter(p => Array.isArray(p) && p.length === 2)
        .map(([sf, level]) => /** @type {[number, number]} */ ([Number(sf), Number(level)]))
        .filter(([sf, level]) => Number.isFinite(sf) && Number.isFinite(level));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The achievement IDs and exploit names in a (decoded) save, or as much of one
 * as has been read so far, plus the owned Source-Files (null if the save has no
 * readable list - the two lists alone are still an answer).
 * @param {string} text
 * @returns {{ ids: string[], exploits: string[], ownedSF: [number, number][] | null } | null}
 *   null until both lists have been seen whole.
 */
export function parseSaveProgress(text) {
  const achievements = extractArray(text, "achievements");
  const exploits = extractArray(text, "exploits");
  if (!achievements || !exploits) return null;
  return {
    ids: achievements.items.map(a => String(a?.ID ?? a)).filter(Boolean),
    exploits: exploits.items.map(String),
    ownedSF: extractSourceFiles(text),
  };
}

// Enough text to hold either list whatever chunk boundary it straddles.
const SCAN_WINDOW_CHARS = 2_000_000;

/**
 * parseSaveProgress for a save arriving in pieces: feed it decoded text as it
 * comes and it answers as soon as both lists and the Source-Files have gone past,
 * so the caller can stop reading. Each is kept when found (they can be megabytes
 * apart in a player record that holds a corporation), and only a tail of the text
 * is held. At the end of the stream, `partial()` answers with whatever was found
 * (ownedSF null when the Source-Files never showed up).
 * @returns {{
 *   feed: (chunk: string) => { ids: string[], exploits: string[], ownedSF: [number, number][] | null } | null,
 *   partial: () => { ids: string[], exploits: string[], ownedSF: [number, number][] | null } | null,
 * }}
 */
export function progressScanner() {
  let text = "";
  /** @type {any[] | null} */ let achievements = null;
  /** @type {any[] | null} */ let exploits = null;
  /** @type {[number, number][] | null} */ let ownedSF = null;
  const answer = () => achievements && exploits ? {
    ids: achievements.map(a => String(a?.ID ?? a)).filter(Boolean),
    exploits: exploits.map(String),
    ownedSF,
  } : null;
  return {
    feed(chunk) {
      text += chunk;
      achievements ??= extractArray(text, "achievements")?.items ?? null;
      exploits ??= extractArray(text, "exploits")?.items ?? null;
      ownedSF ??= extractSourceFiles(text);
      if (text.length > SCAN_WINDOW_CHARS) text = text.slice(-SCAN_WINDOW_CHARS / 2);
      return ownedSF ? answer() : null;
    },
    partial: answer,
  };
}
