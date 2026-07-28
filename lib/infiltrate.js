// lib/infiltrate.js
//
// Infiltration mini-game AUTO-SOLVER. There is NO Netscript API to play an
// infiltration (ns.infiltration only reads reward data), so this is unavoidably a
// DOM/keyboard automation layer: it reads the rendered mini-game off the page and
// dispatches synthetic keyboard events to solve it. That makes it the single
// deliberately-fragile script in this repo - it depends on Bitburner's DOM/text
// and WILL break when the game's UI changes. Everything tunable lives in
// CONFIG.infiltration; the per-game logic is centralised below so a break is a
// one-file, well-signposted fix.
//
// RAM: it touches `document`/`window` only through globalThis[...] bracket access,
// which the RAM checker doesn't bill (same trick the dashboard uses for React), so
// this costs only the base script size + ns.sleep. It runs off-home like the other
// helpers; the browser DOM is global, so any host works.
//
// Coordination: publishes globalThis.gordInfiltrating = true while a game is on
// screen. bn10/daemon.js watches that and yields the player (issues no gym/crime/
// faction/travel call - any of which cancels the mini-game) until it clears.
//
// Flow per loop tick:
//   1. If a mini-game is showing -> identify it by its on-screen instruction and
//      solve it (dispatch the right keys).
//   2. If the reward screen is showing -> take the reward (sell for cash, or trade
//      for reputation) per CONFIG.infiltration.rewardMode.
//   3. Else, if autoStart and an "Infiltrate Company" button is present (the
//      daemon parks us on a company page) -> click it to begin the next run.

import { CONFIG } from "./config.js";

const CFG = CONFIG.infiltration;

// Diagnostic heartbeat cadence: the solver ticks ~33x/s, so all logging is
// throttled - state changes log immediately (deduped), plus a status line every
// HEARTBEAT_MS so you can confirm it's alive and see what it currently sees.
const HEARTBEAT_MS = 4000;

// DOM handles via bracket access so the RAM checker doesn't bill `document`/`window`.
// Cast to any: this whole file is untyped DOM automation, and threading DOM lib
// types through every helper buys nothing here.
const DOC = () => /** @type {any} */ (globalThis["document"]);
const WIN = () => /** @type {any} */ (globalThis["window"]);

// ── Static game data ─────────────────────────────────────────────────────────

// BribeGame positive adjectives (transcribed from the game's own word list). When
// the shown word is one of these, confirm; otherwise cycle to the next.
const POSITIVE_WORDS = new Set([
  "affectionate", "agreeable", "bright", "charming", "clean", "creative",
  "determined", "diplomatic", "dynamic", "energetic", "friendly", "funny",
  "generous", "giving", "hardworking", "helpful", "kind", "likable", "loving",
  "loyal", "patient", "polite", "sincere", "thoughtful", "witty",
]);

// Instruction phrases that identify each mini-game (matched as substrings against
// the infiltration area's text). Order matters only for disambiguation.
const GAMES = [
  { key: "slash",    match: "Slash when his guard is down" },
  { key: "bracket",  match: "Close the brackets" },
  { key: "backward", match: "Type it backward" },
  { key: "bribe",    match: "Say something nice about the guard" },
  { key: "cheat",    match: "Enter the Code" },
  { key: "minesweep", match: "Mark all the mines" },
  { key: "minesweepMemo", match: "Remember all the mines" },
  { key: "wires",    match: "Cut the wires" },
  { key: "symbols",  match: "Match the symbols" },
];

// Arrow glyph -> key name (CheatCode / grid navigation share these).
const ARROW_TO_KEY = {
  "↑": "ArrowUp", "↓": "ArrowDown", "←": "ArrowLeft", "→": "ArrowRight",
};
const CLOSE_BRACKET = { "(": ")", "[": "]", "{": "}", "<": ">" };

// ── Main loop ────────────────────────────────────────────────────────────────

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  const host = ns.getHostname();
  // Surface this script's log window so the diagnostics are visible without
  // hunting for the process. Cast to any + guarded: the tail API name has moved
  // between builds (ns.tail -> ns.ui.openTail), and neither is on the NS type here.
  const nsAny = /** @type {any} */ (ns);
  try { nsAny.ui.openTail(); } catch { try { nsAny.tail(); } catch {} }

  if (!DOC()) {
    ns.tprint("ERROR: infiltrate.js: no DOM available - exiting.");
    return;
  }
  ns.tprint(`INFO: infiltrate.js running on ${host} | location=${CFG.location} autoStart=${CFG.autoStart} reward=${CFG.rewardMode} | open its tail to watch.`);
  ns.print(`started on ${host} - watching for infiltrations (tick ${CFG.tickMs}ms)`);

  // Per-game scratch that must persist across ticks: minesweeper mine positions
  // (captured in its memorise phase) and the symbol game's self-tracked cursor /
  // target index. All reset between games/infiltrations via resetGameState.
  // `dbg` holds throttled-logging bookkeeping (never reset between games).
  const state = {
    mines: /** @type {any} */ (null),
    symCursor: /** @type {any} */ (null),
    symIdx: 0,
    stuck: 0,
    lastSig: "",
    dbg: { active: /** @type {boolean|null} */ (null), lastGame: "", lastBeat: 0, status: "starting up" },
  };

  while (true) {
    try {
      await step(ns, state);
    } catch (e) {
      // Never let a DOM hiccup kill the loop - the next tick re-reads fresh.
      ns.print(`tick error: ${String(e)}`);
    }
    maybeHeartbeat(ns, state);
    await ns.sleep(CFG.tickMs);
  }
}

/** Print the current status line at most once per HEARTBEAT_MS - proof of life. */
function maybeHeartbeat(ns, state) {
  const now = Date.now();
  if (now - state.dbg.lastBeat < HEARTBEAT_MS) return;
  state.dbg.lastBeat = now;
  ns.print(`heartbeat: ${state.dbg.status}`);
}

/**
 * Publish gordInfiltrating and log the transition. Centralising this here means
 * every active/inactive flip is logged exactly once (deduped), and the daemon's
 * yield flag can never drift from what we logged.
 * @param {NS} ns
 */
function setActive(ns, state, active) {
  if (state.dbg.active !== active) {
    state.dbg.active = active;
    ns.print(active ? "infiltration DETECTED on screen" : "no infiltration on screen (idle)");
  }
  globalThis.gordInfiltrating = active;
}

/** @param {NS} ns */
async function step(ns, state) {
  const doc = DOC();
  const area = findInfilArea(doc);

  if (!area) {
    setActive(ns, state, false);
    resetGameState(state);
    const btn = buttonPresent(doc);
    if (CFG.autoStart && btn) {
      clickByText(doc, "Infiltrate Company");
      ns.print("clicked 'Infiltrate Company' - starting a run");
    }
    // The common "nothing happens" cause: the daemon hasn't parked us on a company
    // page, so there's no button to click. Make that visible in the heartbeat.
    state.dbg.status = CFG.autoStart
      ? `idle - Infiltrate button ${btn ? "PRESENT (starting)" : "NOT found (daemon hasn't opened a company page?)"}`
      : "idle - autoStart off";
    return;
  }

  const text = area.innerText || "";

  // Reward screen: infiltration finished, choose what to take.
  if (/Infiltration successful/i.test(text) || /Sell for/i.test(text)) {
    setActive(ns, state, true);
    takeReward(ns, doc);
    ns.print(`reward screen -> taking ${CFG.rewardMode}`);
    resetGameState(state);
    state.dbg.status = "reward screen";
    return;
  }

  setActive(ns, state, true);

  // Loop-guard: if the same screen persists far too long, something changed in
  // the DOM and our solver isn't landing keys - stop hammering.
  const sig = text.slice(0, 120);
  state.stuck = sig === state.lastSig ? state.stuck + 1 : 0;
  state.lastSig = sig;
  if (state.stuck === CFG.maxStuckTicks) {
    ns.print("infiltrate: stuck on a screen - a mini-game may be unsupported or the DOM changed. Solve it manually; auto-solve paused for this screen.");
  }
  if (state.stuck >= CFG.maxStuckTicks) return;

  const game = GAMES.find(g => text.includes(g.match));
  if (!game) {
    state.dbg.status = "waiting (countdown / between games)";
    state.dbg.lastGame = "";
    return; // "Get ready!" between games - just wait
  }

  // Log each new game we start solving (deduped) + keep the heartbeat current.
  if (state.dbg.lastGame !== game.key) {
    ns.print(`solving mini-game: ${game.key}`);
    state.dbg.lastGame = game.key;
  }
  state.dbg.status = `solving ${game.key}`;

  // Per-game state is only meaningful within one game; clear it when the game
  // changes so a stale grid/cursor never leaks into the next.
  if (game.key !== "minesweep" && game.key !== "minesweepMemo") state.mines = null;
  if (game.key !== "symbols") { state.symCursor = null; state.symIdx = 0; }

  switch (game.key) {
    case "slash":         return solveSlash(ns, text);
    case "bracket":       return solveBracket(ns, text);
    case "backward":      return solveBackward(ns, area, text);
    case "bribe":         return solveBribe(ns, text);
    case "cheat":         return solveCheatCode(ns, text);
    case "wires":         return solveWires(ns, area, text);
    case "minesweepMemo": return rememberMines(ns, area, state);
    case "minesweep":     return solveMines(ns, area, state);
    case "symbols":       return solveSymbols(ns, area, state);
  }
}

/** Clear all per-game scratch state (between games / infiltrations). */
function resetGameState(state) {
  state.mines = null;
  state.symCursor = null;
  state.symIdx = 0;
}

// ── Per-game solvers ─────────────────────────────────────────────────────────

/**
 * SlashGame - "Slash when his guard is down!". The guard cycles through
 * "Preparing?" -> "Distracted!" -> "Attacking!"; slash (Space) only while
 * distracted (attacking = you lose, preparing = too early).
 */
function solveSlash(ns, text) {
  if (/Distracted/i.test(text)) press(ns, " ", "Space", 32);
}

/**
 * BracketGame - "Close the brackets". A run of openers like "([{<" is shown; the
 * answer is the matching closers in reverse order. We dispatch the whole closer
 * sequence; the game consumes them left-to-right.
 */
function solveBracket(ns, text) {
  const openers = (text.match(/[([{<]/g) || []);
  if (!openers.length) return;
  const closers = openers.reverse().map(o => CLOSE_BRACKET[o]);
  for (const c of closers) press(ns, c, bracketCode(c), c.charCodeAt(0));
}

/**
 * BackwardGame - "Type it backward". The target word is shown (uppercase); type
 * its letters. The visible string is what the game expects typed, so we send each
 * letter as displayed. (If a future build truly reverses it, reverse `letters`.)
 */
function solveBackward(ns, area, text) {
  // Grab the shown word: the largest run of letters after the instruction line.
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const word = lines.find(l => /^[A-Za-z]{2,}$/.test(l) && !/backward/i.test(l));
  if (!word) return;
  for (const ch of word) {
    const up = ch.toUpperCase();
    press(ns, up, `Key${up}`, up.charCodeAt(0));
  }
}

/**
 * BribeGame - "Say something nice about the guard.". One adjective is shown and
 * cycles with Up/Down; confirm a positive one with Space, else cycle up.
 */
function solveBribe(ns, text) {
  const lines = text.split("\n").map(l => l.trim().toLowerCase()).filter(Boolean);
  const word = lines.find(l => /^[a-z]{3,}$/.test(l) && l !== "say" && !l.includes("guard") && !l.includes("nice"));
  if (!word) return;
  if (POSITIVE_WORDS.has(word)) press(ns, " ", "Space", 32);
  else press(ns, "ArrowUp", "ArrowUp", 38);
}

/**
 * CheatCodeGame - "Enter the Code!". A single arrow glyph is shown; press the
 * matching arrow key.
 */
function solveCheatCode(ns, text) {
  for (const [glyph, key] of Object.entries(ARROW_TO_KEY)) {
    if (text.includes(glyph)) {
      press(ns, key, key, arrowCode(key));
      return;
    }
  }
}

/**
 * WireCuttingGame - "Cut the wires with the following properties!". Rules read as
 * "Cut wires colored X." and/or "Cut the wire number N.". We cut every wire that
 * matches ANY rule by pressing its number key. Colour rules need each wire's
 * rendered colour, read from the wire elements' inline/computed style.
 */
function solveWires(ns, area, text) {
  // Number rules: "wire number 3".
  const numberRules = [...text.matchAll(/number\s+(\d+)/gi)].map(m => Number(m[1]));

  // Colour rules: "colored red/blue/white/yellow". Map English -> the CSS colour
  // the game uses so we can compare against computed styles.
  const COLOR_WORDS = { red: "red", blue: "blue", white: "white", yellow: "yellow" };
  const colorRules = Object.keys(COLOR_WORDS).filter(c => new RegExp(`colou?red?\\s+${c}`, "i").test(text));

  const toCut = new Set(numberRules);

  if (colorRules.length) {
    // Wire cells render coloured glyphs; find elements whose colour matches a rule
    // and map their column index (1-based) to a wire number.
    const cells = [...area.querySelectorAll("span, p, div")].filter(el => (el.textContent || "").trim().length === 1);
    for (const el of cells) {
      const col = normColor(colorOf(el));
      if (!col) continue;
      if (colorRules.some(r => COLOR_WORDS[r] === col)) {
        const n = wireIndexOf(el);
        if (n > 0) toCut.add(n);
      }
    }
  }

  for (const n of toCut) press(ns, String(n), `Digit${n}`, 48 + n);
}

/** Minesweeper memorise phase - capture the mine grid so solveMines can mark them. */
function rememberMines(ns, area, state) {
  const grid = readMineGrid(area);
  if (grid && grid.mines.length) state.mines = grid;
}

/**
 * Minesweeper mark phase - navigate the cursor to each remembered mine and mark
 * it (Space). We track the cursor via the rendered grid and step toward the next
 * unmarked mine one key per tick.
 */
function solveMines(ns, area, state) {
  const grid = state.mines;
  if (!grid) return; // never saw the memorise phase - can't solve reliably
  const cur = readCursor(area) ?? { r: 0, c: 0 };
  const next = grid.mines.find(m => !m.marked);
  if (!next) return;

  if (cur.r === next.r && cur.c === next.c) {
    press(ns, " ", "Space", 32);
    next.marked = true;
    return;
  }
  if (cur.r < next.r) return press(ns, "ArrowDown", "ArrowDown", 40);
  if (cur.r > next.r) return press(ns, "ArrowUp", "ArrowUp", 38);
  if (cur.c < next.c) return press(ns, "ArrowRight", "ArrowRight", 39);
  if (cur.c > next.c) return press(ns, "ArrowLeft", "ArrowLeft", 37);
}

/**
 * "Match the symbols!" (Cyberpunk2077Game). A grid of glyphs plus a short target
 * row at the top; you move a cursor over the grid with the arrows and press Space
 * on the current target glyph, in the target order. We read every single-glyph
 * leaf element with its on-screen position, split off the top row as the targets
 * and treat the rest as the grid, then:
 *   - current target  = the highlighted target cell (distinct colour) if we can
 *     detect it, else the next one we haven't cleared (self-tracked index);
 *   - cursor position = the highlighted grid cell if detectable, else where our
 *     last move landed (self-tracked);
 * then burst the exact arrow deltas to the nearest matching grid cell and Space.
 * Re-read each tick self-corrects, so a mis-detected start still recovers.
 *
 * This is the most layout-sensitive solver here (grid + colour highlight); if a
 * build renders it differently it simply won't find cells and no-ops (the step()
 * stuck-guard then flags it for manual play).
 */
function solveSymbols(ns, area, state) {
  const cells = glyphCells(area);
  if (cells.length < 3) return;

  const rows = groupRows(cells);
  if (rows.length < 2) return;

  const targetRow = rows[0];      // short sequence to match, in order
  const grid = rows.slice(1);     // 2D grid, grid[y][x]
  const gridCells = grid.flat();

  // Current target glyph: prefer the highlighted target; else self-track an index.
  const hiTarget = distinctStyled(targetRow);
  let want;
  if (hiTarget) {
    want = hiTarget.sym;
  } else {
    if (!state.symIdx) state.symIdx = 0;
    want = targetRow[Math.min(state.symIdx, targetRow.length - 1)]?.sym;
  }
  if (!want) return;

  // Cursor: prefer the highlighted grid cell; else where our last move landed.
  const cur = distinctStyled(gridCells) ?? state.symCursor ?? grid[0]?.[0];
  const from = gridCoord(grid, cur);
  if (!from) return;

  // Nearest grid cell holding the wanted glyph.
  const matches = gridCells.filter(c => c.sym === want);
  if (!matches.length) return;
  let dest = matches[0], best = Infinity;
  for (const m of matches) {
    const p = gridCoord(grid, m);
    if (!p) continue;
    const d = Math.abs(p.x - from.x) + Math.abs(p.y - from.y);
    if (d < best) { best = d; dest = m; }
  }
  const to = gridCoord(grid, dest);
  if (!to) return;

  moveCursor(ns, from, to);
  press(ns, " ", "Space", 32);

  // Self-tracking fallbacks (ignored next tick if detection succeeds).
  state.symCursor = dest;
  if (!hiTarget) state.symIdx = (state.symIdx ?? 0) + 1;
}

// ── Reward screen ────────────────────────────────────────────────────────────

/** @param {NS} ns */
function takeReward(ns, doc) {
  if (CFG.rewardMode === "rep" && CFG.rewardFaction) {
    // Best-effort: the rep path needs a faction chosen in a dropdown, which varies
    // by build. Try to click a "reputation" button; if the faction isn't preset
    // the game keeps its default. Fall through to cash if no such button.
    if (clickByText(doc, "reputation")) return;
  }
  clickByText(doc, "Sell for") || clickByText(doc, "Sell");
}

// ── DOM helpers ──────────────────────────────────────────────────────────────

/**
 * Locate the infiltration area: the element wrapping a known instruction phrase.
 * Returns the nearest sensible container (a few levels up) or null when no
 * infiltration is on screen.
 */
function findInfilArea(doc) {
  const body = doc?.body;
  if (!body) return null;
  const text = body.innerText || "";
  const active = /Infiltrating/i.test(text)
    || /Infiltration successful/i.test(text)
    || GAMES.some(g => text.includes(g.match));
  if (!active) return null;

  // Prefer the tightest container that still holds the whole mini-game (keeps the
  // solvers' text reads free of sidebar/terminal noise). One DOM walk for whichever
  // game matches; fall back to body (e.g. the reward screen matches no game).
  const g = GAMES.find(gg => text.includes(gg.match));
  const node = g ? findByText(body, g.match) : null;
  return (node && (node.closest("div") || node.parentElement)) || body;
}

/** Depth-first search for the deepest element whose text includes `needle`. */
function findByText(root, needle) {
  const walker = DOC().createTreeWalker(root, 0x1 /* SHOW_ELEMENT */);
  let best = null;
  let node = walker.currentNode;
  while (node) {
    const t = node.textContent || "";
    if (t.includes(needle) && (node.children?.length ?? 0) <= 4) best = node;
    node = walker.nextNode();
  }
  return best;
}

/** True if any <button> text includes "infiltrate company" (case-insensitive). */
function buttonPresent(doc) {
  const btns = doc?.querySelectorAll?.("button") ?? [];
  for (const b of btns) {
    if ((b.textContent || "").toLowerCase().includes("infiltrate company")) return true;
  }
  return false;
}

/** Click the first <button> whose text includes `substr`. Returns true if clicked. */
function clickByText(doc, substr) {
  const btns = doc?.querySelectorAll?.("button") ?? [];
  for (const b of btns) {
    if ((b.textContent || "").toLowerCase().includes(substr.toLowerCase())) {
      b.click();
      return true;
    }
  }
  return false;
}

/** Computed text colour of an element. */
function colorOf(el) {
  try {
    return WIN().getComputedStyle(el).color;
  } catch {
    return el.style?.color || "";
  }
}

/** Normalise an rgb()/name colour string to one of red/blue/white/yellow, or "". */
function normColor(c) {
  if (!c) return "";
  const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) {
    const s = c.toLowerCase();
    return ["red", "blue", "white", "yellow"].find(k => s.includes(k)) || "";
  }
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (r > 180 && g > 180 && b > 180) return "white";
  if (r > 180 && g > 180 && b < 120) return "yellow";
  if (r > 150 && g < 100 && b < 100) return "red";
  if (b > 150 && r < 120 && g < 150) return "blue";
  return "";
}

/** 1-based column index of a single-glyph wire cell within its row. */
function wireIndexOf(el) {
  const row = el.parentElement;
  if (!row) return -1;
  const sibs = [...row.children].filter(c => (c.textContent || "").trim().length === 1);
  return sibs.indexOf(el) + 1;
}

// ── Symbol-grid ("Match the symbols") helpers ─────────────────────────────────

/** Single-glyph leaf elements within `area`, each with its on-screen centre and a
 *  style signature (for highlight detection). */
function glyphCells(area) {
  const out = [];
  for (const el of area.querySelectorAll("span, p, div, td, h1, h2, h3, h4, h5, h6")) {
    if (el.children && el.children.length) continue;   // leaves only
    const sym = (el.textContent || "").trim();
    if (sym.length !== 1) continue;
    const r = el.getBoundingClientRect?.();
    if (!r || r.width === 0 || r.height === 0) continue;
    out.push({ sym, cx: r.left + r.width / 2, cy: r.top + r.height / 2, style: styleSig(el) });
  }
  return out;
}

/** Group glyph cells into rows by y (each sorted left->right), rows top->bottom. */
function groupRows(cells, tol = 8) {
  const rows = [];
  for (const c of [...cells].sort((a, b) => a.cy - b.cy)) {
    let row = rows.find(r => Math.abs(r[0].cy - c.cy) <= tol);
    if (!row) { row = []; rows.push(row); }
    row.push(c);
  }
  for (const r of rows) r.sort((a, b) => a.cx - b.cx);
  return rows;
}

/** The one cell whose style signature is rarest - i.e. the highlighted target /
 *  cursor - or null if styles are uniform or too ambiguous to trust. */
function distinctStyled(cells) {
  if (!cells || cells.length < 2) return null;
  const freq = {};
  for (const c of cells) freq[c.style] = (freq[c.style] || 0) + 1;
  let best = null, bestFreq = Infinity;
  for (const c of cells) if (freq[c.style] < bestFreq) { bestFreq = freq[c.style]; best = c; }
  return bestFreq <= Math.max(1, Math.floor(cells.length / 3)) ? best : null;
}

/** {x,y} of a cell within the grid rows (by identity, then by position match). */
function gridCoord(grid, cell) {
  if (!cell) return null;
  for (let y = 0; y < grid.length; y++) {
    const x = grid[y].indexOf(cell);
    if (x >= 0) return { x, y };
  }
  for (let y = 0; y < grid.length; y++) {
    const x = grid[y].findIndex(c => Math.abs(c.cx - cell.cx) < 2 && Math.abs(c.cy - cell.cy) < 2);
    if (x >= 0) return { x, y };
  }
  return null;
}

/** Dispatch the exact arrow deltas to walk the cursor from `from` to `to`. */
function moveCursor(ns, from, to) {
  for (let i = from.x; i < to.x; i++) press(ns, "ArrowRight", "ArrowRight", 39);
  for (let i = from.x; i > to.x; i--) press(ns, "ArrowLeft", "ArrowLeft", 37);
  for (let i = from.y; i < to.y; i++) press(ns, "ArrowDown", "ArrowDown", 40);
  for (let i = from.y; i > to.y; i--) press(ns, "ArrowUp", "ArrowUp", 38);
}

/** Text+background+weight style signature of an element, for highlight detection. */
function styleSig(el) {
  try {
    const cs = WIN().getComputedStyle(el);
    return `${cs.color}|${cs.backgroundColor}|${cs.fontWeight}`;
  } catch {
    return "";
  }
}

/** Parse the minesweeper grid; mines are the marked/bomb cells. Best-effort. */
function readMineGrid(area) {
  const rows = (area.innerText || "").split("\n").map(l => l.replace(/\s+$/,"")).filter(l => /[.?\[\]O]/.test(l));
  const mines = [];
  rows.forEach((line, r) => {
    const cells = line.trim().split(/\s+/);
    cells.forEach((cell, c) => {
      if (cell.includes("?") || cell.includes("O")) mines.push({ r, c, marked: false });
    });
  });
  return mines.length ? { mines } : null;
}

/** Current cursor {r,c} in the minesweeper grid (the highlighted cell), or null. */
function readCursor(area) {
  const rows = (area.innerText || "").split("\n").filter(l => /[.?\[\]O]/.test(l));
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r].trim().split(/\s+/);
    const c = cells.findIndex(cell => cell.includes("[") && cell.includes("]"));
    if (c >= 0) return { r, c };
  }
  return null;
}

// ── Keyboard dispatch ─────────────────────────────────────────────────────────

const KeyboardEventCtor = () => /** @type {any} */ (globalThis["KeyboardEvent"]);

/**
 * Dispatch a synthetic keydown+keyup for `key` on the document (Bitburner's
 * infiltration listens on window keydown, which document events bubble to). We set
 * key/code/keyCode/which for maximum compatibility with the handlers.
 * @param {NS} ns
 */
function press(ns, key, code, keyCode) {
  const doc = DOC();
  const KE = KeyboardEventCtor();
  if (!doc || !KE) return;
  for (const type of ["keydown", "keyup"]) {
    const ev = new KE(type, {
      key, code, keyCode, which: keyCode,
      bubbles: true, cancelable: true, view: WIN(),
    });
    // keyCode/which are non-writable on the constructed event in some engines;
    // redefine so handlers reading them still see the right value.
    try {
      Object.defineProperty(ev, "keyCode", { get: () => keyCode });
      Object.defineProperty(ev, "which", { get: () => keyCode });
    } catch {}
    doc.dispatchEvent(ev);
  }
}

function bracketCode(ch) {
  return { ")": "Digit0", "]": "BracketRight", "}": "BracketRight", ">": "Period" }[ch] || "";
}
function arrowCode(key) {
  return { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 }[key] || 0;
}
