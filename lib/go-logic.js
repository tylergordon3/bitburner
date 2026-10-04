// lib/go-logic.js
//
// The PURE IPvGO player: rules, analysis and move choice with no `ns` anywhere,
// so it costs 0GB and is unit-tested under Node (tests/go-logic.test.mjs).
// lib/go.js is the Netscript I/O shell around it.
//
// WHY everything is computed here rather than asked of the game: the analysis
// calls are the expensive part of ns.go - getChains, getLiberties and
// getControlledEmptyNodes are 16GB each and getValidMoves is 8GB - while the
// board itself is one 4GB getBoardState. Chains, liberties, legality (suicide
// and the repeat rule), territory and eyes are all a flood fill away from that
// board, so the helper stays under 10GB instead of over 60GB.
//
// Rules as the game implements them (bitburner-src src/Go, read 2026-10):
//   - getBoardState() is an array of COLUMN strings: board[x][y], "X" black (us),
//     "O" white (the faction), "." empty, "#" a dead node that is not part of the
//     subnet at all (never playable, never a liberty, never territory).
//   - A move captures every ENEMY chain left without liberties, and only then is
//     tested for suicide (evaluateIfMoveIsValid / updateCaptures).
//   - The repeat rule is positional superko: a move may not recreate ANY earlier
//     board of this game (previousBoards.includes(...)), not just the last one.
//   - Scoring is area scoring (scoring.ts getScore): a point per stone, plus every
//     empty region bordered by one colour only, plus komi for white. A region
//     larger than size^2 - 3 belongs to nobody. Black wins a TIE (the loss test is
//     black < white), and - the part that shapes the endgame - a single uncaptured
//     enemy stone inside a region makes the WHOLE region neutral.
//   - Node power, the thing this is played for, is black's final score times a
//     difficulty and a win-streak multiplier, so a bigger win pays more than a
//     narrow one and a loss still pays half.
//
// The player is a one-ply heuristic, deliberately: the faction AIs are one-ply
// themselves ("aware of chains, liberties and eyes ... do not know about larger
// jump moves, nor about frameworks" - goAI.ts). Each candidate move is played on
// a copy of the board and the resulting POSITION is scored; the move's value is
// the change. The position score is a Voronoi territory estimate (which stones is
// each empty point nearest to) plus what is hanging in atari on either side, so
// capturing, rescuing, expanding into open space and walling the opponent off all
// fall out of one number instead of a ladder of special cases.
//
// NAMING: Bitburner's static RAM analyser bills by identifier NAME, whatever
// object it hangs off. Nothing in this file may be called makeMove, passTurn,
// getBoardState, getChains, getLiberties, getValidMoves or getControlledEmptyNodes
// (or any other API name), or the 0GB module would start charging for them.

export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;
export const DEAD = 3;

const CELL_OF_CHAR = { ".": EMPTY, X: BLACK, O: WHITE, "#": DEAD };
const CHAR_OF_CELL = [".", "X", "O", "#"];

/** Tunables of the evaluation. Exported so tests (and a curious reader) can see
 *  what a move is worth; lib/config.js carries only the operational knobs. */
export const WEIGHTS = {
  // One point of Voronoi territory swing (see territoryEstimate).
  territory: 1,
  // Chains with this many liberties or fewer claim no territory around them.
  weakLiberties: 2,
  // Really sealed area (the game's own count) on top of the estimate: closing the
  // last gap of a region is worth a little more than an ordinary boundary point.
  sealed: 0.5,
  // A chain of ours left in atari costs this much, plus `perStone` each. Larger
  // than any territory a single move gains, so we rescue before we expand and
  // never walk into self-atari for a point.
  ownAtari: 8,
  ownAtariPerStone: 4,
  // An enemy chain put in atari. Smaller than ownAtari: they get to answer.
  foeAtari: 4,
  foeAtariPerStone: 2,
  // A chain of ours down to TWO liberties is one move from atari: a small charge,
  // on top of it claiming no territory (weakLiberties), so it gets extended.
  ownShort: 2,
  ownShortPerStone: 1,
  foeShort: 0,
  foeShortPerStone: 0,
  // Captured stones, beyond the territory they free up (which positionValue
  // already counts - hence small).
  captureFlat: 3,
  capturePerStone: 2,
  // Liberties of the chain we just played into, capped. Prefers open shapes and
  // is the whole reason the first line is avoided early (a corner stone has 2).
  liberty: 0.6,
  libertyCap: 5,
  // Joining two of our chains.
  join: 1.5,
  // Leaning on a short-of-liberties enemy chain (1.2 / its liberties left).
  press: 1.2,
  // A new single-point eye of ours.
  eye: 2.5,
  // Opening shape: third/fourth line good, first line bad. Fades as the board fills.
  line: [-1.5, -0.5, 0.6, 0.4],
};

/** Two-ply look-ahead: how many one-ply favourites get the opponent's best reply
 *  charged against them, and how much of that reply counts. */
export const LOOKAHEAD = { width: 6, replyWeight: 0.8 };

/** A candidate must be worth more than this to be played at all; otherwise pass. */
export const PASS_BELOW = 0.05;
/** Opponent passed and we are ahead: bank the win unless a move is worth this. */
export const BANK_WIN_BELOW = 3;

// ── Board ────────────────────────────────────────────────────────────────────

/**
 * @typedef {{ n: number, cells: Uint8Array }} Board  cells[x * n + y]
 */

/**
 * Parse ns.go.getBoardState()'s column strings.
 * @param {string[]} columns
 * @returns {Board}
 */
export function parseBoard(columns) {
  const n = columns.length;
  const cells = new Uint8Array(n * n);
  for (let x = 0; x < n; x++) {
    const col = String(columns[x] ?? "");
    for (let y = 0; y < n; y++) {
      // Anything we do not recognise is treated as a dead node: unplayable is the
      // safe reading of a character a future version might add.
      cells[x * n + y] = CELL_OF_CHAR[col[y]] ?? DEAD;
    }
  }
  return { n, cells };
}

/** @param {Board} board @returns {string[]} the game's column-string form */
export function boardColumns(board) {
  const { n, cells } = board;
  const out = [];
  for (let x = 0; x < n; x++) {
    let col = "";
    for (let y = 0; y < n; y++) col += CHAR_OF_CELL[cells[x * n + y]];
    out.push(col);
  }
  return out;
}

/** One string per position - the form history is compared in. @param {Board} board */
export function boardKey(board) {
  return boardColumns(board).join("");
}

/**
 * History as a Set of position keys, from ns.go.getMoveHistory() (an array of
 * column-string boards) or from keys already made.
 * @param {Iterable<string[] | string> | null | undefined} history
 * @returns {Set<string>}
 */
export function historyKeys(history) {
  const keys = new Set();
  for (const entry of history ?? []) keys.add(Array.isArray(entry) ? entry.join("") : String(entry));
  return keys;
}

/** @param {number} color */
export function opposite(color) {
  return color === BLACK ? WHITE : BLACK;
}

/** @type {Map<number, number[][]>} */
const ADJACENT = new Map();
let lastAdjacentSize = -1;
/** @type {number[][]} */
let lastAdjacent = [];

/** Orthogonal neighbours of every point of an n x n board (cached per size). */
function adjacency(n) {
  // Asked for on every flood fill, almost always for the board being played.
  if (n === lastAdjacentSize) return lastAdjacent;
  let table = ADJACENT.get(n);
  if (!table) table = buildAdjacency(n);
  lastAdjacentSize = n;
  lastAdjacent = table;
  return table;
}

function buildAdjacency(n) {
  /** @type {number[][]} */
  const table = [];
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      const list = [];
      if (x > 0) list.push((x - 1) * n + y);
      if (x < n - 1) list.push((x + 1) * n + y);
      if (y > 0) list.push(x * n + y - 1);
      if (y < n - 1) list.push(x * n + y + 1);
      table.push(list);
    }
  }
  ADJACENT.set(n, table);
  return table;
}

// ── Scratch space ────────────────────────────────────────────────────────────
//
// chooseMove rates about a thousand positions per turn on a 13x13 board (every
// candidate, then every reply to the best few), and each rating flood-fills the
// board a couple of dozen times: one fill per chain, one per empty region, two
// distance fields. Each fill used to allocate its own visited/queue arrays; they
// share these instead, which took a turn from ~13ms to ~7ms with the same moves
// played. The one rule: a function that borrows a buffer must be done with it
// before calling another that borrows the same one (noted at each use).
const SCRATCH = {
  cells: 0,
  /** visited marks: a point is visited when seen[i] === the current mark */
  seen: new Int32Array(0),
  mark: 0,
  queue: new Int16Array(0),
  fromBlack: new Int16Array(0),
  fromWhite: new Int16Array(0),
};

/** The scratch buffers, sized for a board of `cells` points. */
function scratchFor(cells) {
  if (SCRATCH.cells !== cells) {
    SCRATCH.cells = cells;
    SCRATCH.seen = new Int32Array(cells);
    SCRATCH.mark = 0;
    SCRATCH.queue = new Int16Array(cells);
    SCRATCH.fromBlack = new Int16Array(cells);
    SCRATCH.fromWhite = new Int16Array(cells);
  }
  return SCRATCH;
}

/** A fresh "visited" mark: nothing in `seen` carries it yet. */
function nextMark(scratch) {
  if (scratch.mark >= 0x7fffffff) {
    scratch.seen.fill(0);
    scratch.mark = 0;
  }
  return ++scratch.mark;
}

// ── Chains and liberties ─────────────────────────────────────────────────────

/**
 * The chain containing `start` (a stone) and its liberties.
 * @param {Board} board @param {number} start
 * @returns {{ color: number, stones: number[], liberties: number[] }}
 */
export function chainAt(board, start) {
  const { n, cells } = board;
  const adj = adjacency(n);
  const color = cells[start];
  // Borrows `seen` (calls nothing).
  const scratch = scratchFor(cells.length);
  const seen = scratch.seen;
  const mark = nextMark(scratch);
  const stones = [start];
  const liberties = [];
  seen[start] = mark;
  for (let k = 0; k < stones.length; k++) {
    for (const j of adj[stones[k]]) {
      if (seen[j] === mark) continue;
      seen[j] = mark;
      if (cells[j] === color) stones.push(j);
      else if (cells[j] === EMPTY) liberties.push(j);
    }
  }
  return { color, stones, liberties };
}

/**
 * Every chain on the board, and which chain each stone belongs to (-1 elsewhere).
 * @param {Board} board
 * @returns {{ chains: { color: number, stones: number[], liberties: number[] }[], chainOf: Int16Array }}
 */
export function allChains(board) {
  const { cells } = board;
  const chainOf = new Int16Array(cells.length).fill(-1);
  const chains = [];
  for (let i = 0; i < cells.length; i++) {
    if ((cells[i] !== BLACK && cells[i] !== WHITE) || chainOf[i] !== -1) continue;
    const chain = chainAt(board, i);
    for (const s of chain.stones) chainOf[s] = chains.length;
    chains.push(chain);
  }
  return { chains, chainOf };
}

// ── Playing a stone ──────────────────────────────────────────────────────────

/**
 * Play `color` at `index` on a COPY of the board: enemy chains left without
 * liberties are captured first, then the move is refused if our own chain has
 * none (suicide). The repeat rule is not checked here - see moveVerdict.
 * @param {Board} board @param {number} index @param {number} color
 * @returns {{ ok: false, reason: string } |
 *           { ok: true, board: Board, captured: number[], chain: { color: number, stones: number[], liberties: number[] } }}
 */
export function playStone(board, index, color) {
  const { n, cells } = board;
  if (!Number.isInteger(index) || index < 0 || index >= cells.length) return { ok: false, reason: "off-board" };
  if (cells[index] === DEAD) return { ok: false, reason: "dead-node" };
  if (cells[index] !== EMPTY) return { ok: false, reason: "occupied" };

  const next = cells.slice();
  next[index] = color;
  const after = { n, cells: next };
  const foe = opposite(color);
  /** @type {number[]} */
  const captured = [];
  for (const j of adjacency(n)[index]) {
    if (next[j] !== foe) continue; // also skips stones an earlier neighbour's capture removed
    const chain = chainAt(after, j);
    if (chain.liberties.length > 0) continue;
    for (const s of chain.stones) {
      next[s] = EMPTY;
      captured.push(s);
    }
  }
  const chain = chainAt(after, index);
  if (chain.liberties.length === 0) return { ok: false, reason: "suicide" };
  return { ok: true, board: after, captured, chain };
}

/**
 * Full legality: playStone plus the repeat rule against every earlier position.
 * @param {Board} board @param {number} index @param {number} color
 * @param {Set<string>} [history] position keys of every earlier board this game
 */
export function moveVerdict(board, index, color, history) {
  const result = playStone(board, index, color);
  if (!result.ok) return result;
  if (history && history.size > 0 && history.has(boardKey(result.board))) {
    return /** @type {{ ok: false, reason: string }} */ ({ ok: false, reason: "repeat" });
  }
  return result;
}

/**
 * Every legal point for `color`, as indices (x * n + y).
 * @param {Board} board @param {number} color @param {Set<string>} [history]
 */
export function legalPoints(board, color, history) {
  const out = [];
  for (let i = 0; i < board.cells.length; i++) {
    if (board.cells[i] === EMPTY && moveVerdict(board, i, color, history).ok) out.push(i);
  }
  return out;
}

// ── Eyes, regions, score ─────────────────────────────────────────────────────

/**
 * A single-point eye of `color`: an empty point whose every real neighbour is a
 * stone of that colour (board edges and dead nodes count as walls). Filling one
 * is how a living group kills itself, so the chooser never does - see
 * candidatePoints for the one exception.
 * @param {Board} board @param {number} index @param {number} color
 */
export function isEyeOf(board, index, color) {
  const { n, cells } = board;
  if (cells[index] !== EMPTY) return false;
  let walls = 0;
  for (const j of adjacency(n)[index]) {
    if (cells[j] === DEAD) continue;
    if (cells[j] !== color) return false;
    walls++;
  }
  return walls > 0;
}

/** How many single-point eyes `color` has. */
function eyeCount(board, color) {
  let count = 0;
  for (let i = 0; i < board.cells.length; i++) if (isEyeOf(board, i, color)) count++;
  return count;
}

/**
 * The connected empty regions and who borders them. `owner` is BLACK/WHITE when
 * the region touches that colour only AND is small enough to be territory by the
 * game's rule (at most n*n - 3 points), else EMPTY.
 * @param {Board} board
 * @returns {{ regions: { points: number[], owner: number }[], regionOf: Int16Array }}
 */
export function emptyRegions(board) {
  const { n, cells } = board;
  const adj = adjacency(n);
  const regionOf = new Int16Array(cells.length).fill(-1);
  const regions = [];
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== EMPTY || regionOf[i] !== -1) continue;
    const points = [i];
    regionOf[i] = regions.length;
    let black = false;
    let white = false;
    for (let k = 0; k < points.length; k++) {
      for (const j of adj[points[k]]) {
        const c = cells[j];
        if (c === BLACK) black = true;
        else if (c === WHITE) white = true;
        else if (c === EMPTY && regionOf[j] === -1) {
          regionOf[j] = regions.length;
          points.push(j);
        }
      }
    }
    const small = points.length <= n * n - 3;
    const owner = !small ? EMPTY : black && !white ? BLACK : white && !black ? WHITE : EMPTY;
    regions.push({ points, owner });
  }
  return { regions, regionOf };
}

/**
 * The game's own score for a position (scoring.ts getScore).
 * @param {Board} board @param {number} [komi] white's bonus
 * @returns {{ black: number, white: number }}
 */
export function areaScore(board, komi = 0) {
  const { n, cells } = board;
  const adj = adjacency(n);
  // Borrows `seen` and `queue` (calls nothing). The regions are emptyRegions'
  // - same fill, same ownership rule - counted without being listed: this runs
  // for every position chooseMove rates.
  const scratch = scratchFor(cells.length);
  const { seen, queue } = scratch;
  const mark = nextMark(scratch);
  let black = 0;
  let white = komi;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c === BLACK) black++;
    else if (c === WHITE) white++;
    if (c !== EMPTY || seen[i] === mark) continue;
    let size = 1;
    let touchesBlack = false;
    let touchesWhite = false;
    queue[0] = i;
    seen[i] = mark;
    for (let k = 0; k < size; k++) {
      for (const j of adj[queue[k]]) {
        const cj = cells[j];
        if (cj === BLACK) touchesBlack = true;
        else if (cj === WHITE) touchesWhite = true;
        else if (cj === EMPTY && seen[j] !== mark) {
          seen[j] = mark;
          queue[size++] = j;
        }
      }
    }
    if (size > n * n - 3) continue; // too large to be anyone's territory
    if (touchesBlack && !touchesWhite) black += size;
    else if (touchesWhite && !touchesBlack) white += size;
  }
  return { black, white };
}

/**
 * Distance from every empty point to the nearest `color` stone, through empties,
 * written into `dist` (-1 = unreachable).
 * @param {Board} board @param {number} color @param {Uint8Array} weak
 * @param {Int16Array} dist @param {Int16Array} queue
 */
function distanceField(board, color, weak, dist, queue) {
  const { n, cells } = board;
  const adj = adjacency(n);
  dist.fill(-1);
  let size = 0;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === color && !weak[i]) {
      dist[i] = 0;
      queue[size++] = i;
    }
  }
  for (let k = 0; k < size; k++) {
    const d = dist[queue[k]] + 1;
    for (const j of adj[queue[k]]) {
      if (cells[j] !== EMPTY || dist[j] !== -1) continue; // stones block the way
      dist[j] = d;
      queue[size++] = j;
    }
  }
  return dist;
}

/**
 * Voronoi territory estimate, black minus white: a point for each stone, and for
 * each empty point strictly nearer to one colour's stones than the other's (an
 * empty point only one colour can reach at all is that colour's). Unlike the real
 * score this is meaningful from move one, and it moves the right way for every
 * kind of good move - a capture hands the freed points back, a wall claims the
 * open space behind it, a stone between the opponent and an empty corner takes
 * the corner.
 *
 * Chains short of liberties (WEIGHTS.weakLiberties or fewer) still count as
 * stones but claim NOTHING around them. That one rule is most of the player's
 * strength against the stronger factions: without it the estimate happily
 * scatters lone stones across the board, each "owning" a neighbourhood, and
 * Tetrads - who attach to and cut everything - collect them one by one. With it,
 * a stone that can be pressed is worth little until it is extended or connected,
 * and pressing an enemy chain takes its claim away.
 * @param {Board} board
 * @param {ReturnType<typeof allChains>} [chains] the board's chains, if already computed
 */
export function territoryEstimate(board, chains = allChains(board)) {
  const { cells } = board;
  const weak = new Uint8Array(cells.length);
  for (const chain of chains.chains) {
    if (chain.liberties.length > WEIGHTS.weakLiberties) continue;
    for (const s of chain.stones) weak[s] = 1;
  }
  // Borrows `fromBlack`, `fromWhite` and `queue`; `chains` was computed above,
  // before any of them is written.
  const scratch = scratchFor(cells.length);
  const fromBlack = distanceField(board, BLACK, weak, scratch.fromBlack, scratch.queue);
  const fromWhite = distanceField(board, WHITE, weak, scratch.fromWhite, scratch.queue);
  let balance = 0;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c === BLACK) balance++;
    else if (c === WHITE) balance--;
    else if (c === EMPTY) {
      const b = fromBlack[i];
      const w = fromWhite[i];
      if (b !== -1 && (w === -1 || b < w)) balance++;
      else if (w !== -1 && (b === -1 || w < b)) balance--;
    }
  }
  return balance;
}

/**
 * The position's value to `color`: territory, plus chains hanging in atari.
 * A move is scored by how much it changes this (see rateMove).
 * @param {Board} board @param {number} color
 */
export function positionValue(board, color) {
  const sign = color === BLACK ? 1 : -1;
  const score = areaScore(board);
  const chains = allChains(board);
  let value = WEIGHTS.territory * sign * territoryEstimate(board, chains)
    + WEIGHTS.sealed * (color === BLACK ? score.black : score.white);
  for (const chain of chains.chains) {
    const libs = chain.liberties.length;
    const size = chain.stones.length;
    if (libs === 1) {
      if (chain.color === color) value -= WEIGHTS.ownAtari + WEIGHTS.ownAtariPerStone * size;
      else value += WEIGHTS.foeAtari + WEIGHTS.foeAtariPerStone * size;
    } else if (libs === 2) {
      if (chain.color === color) value -= WEIGHTS.ownShort + WEIGHTS.ownShortPerStone * size;
      else value += WEIGHTS.foeShort + WEIGHTS.foeShortPerStone * size;
    }
  }
  return value + WEIGHTS.eye * eyeCount(board, color);
}

// ── Choosing a move ──────────────────────────────────────────────────────────

/**
 * Value of playing `color` at `index`: positionValue after minus before, plus
 * the terms that belong to the move rather than the position. null if illegal.
 * @param {Board} board @param {number} index @param {number} color
 * @param {{ history?: Set<string>, before?: number, chains?: ReturnType<typeof allChains> }} [ctx]
 */
export function rateMove(board, index, color, ctx = {}) {
  return rateMoveOn(board, index, color, ctx)?.value ?? null;
}

/** rateMove, also handing back the board the move leaves (for the look-ahead). */
function rateMoveOn(board, index, color, ctx) {
  const result = moveVerdict(board, index, color, ctx.history);
  if (!result.ok) return null;
  const { n, cells } = board;
  const before = ctx.before ?? positionValue(board, color);
  const chains = ctx.chains ?? allChains(board);
  let value = positionValue(result.board, color) - before;

  if (result.captured.length > 0) {
    value += WEIGHTS.captureFlat + WEIGHTS.capturePerStone * result.captured.length;
    // A capture that leaves the capturing stone in atari is a ko or a snapback
    // shape, not a blunder: give back half of what positionValue charged for it.
    if (result.chain.liberties.length === 1) {
      value += 0.5 * (WEIGHTS.ownAtari + WEIGHTS.ownAtariPerStone * result.chain.stones.length);
    }
  }

  // Liberties gained (or spent) by the chain this stone joins.
  const joined = new Set();
  const pressed = new Set();
  let bestBefore = 0;
  for (const j of adjacency(n)[index]) {
    const id = chains.chainOf[j];
    if (id === -1) continue;
    if (cells[j] === color) {
      joined.add(id);
      bestBefore = Math.max(bestBefore, chains.chains[id].liberties.length);
    } else {
      pressed.add(id);
    }
  }
  const cap = WEIGHTS.libertyCap;
  value += WEIGHTS.liberty * (Math.min(result.chain.liberties.length, cap) - Math.min(bestBefore, cap));
  if (joined.size > 1) value += WEIGHTS.join * (joined.size - 1);
  for (const id of pressed) {
    const left = chains.chains[id].liberties.length - 1;
    if (left > 0) value += WEIGHTS.press / left; // left === 0 was a capture, paid above
  }

  // Opening shape, fading out as the board fills up.
  let empties = 0;
  let playable = 0;
  for (const c of cells) {
    if (c === DEAD) continue;
    playable++;
    if (c === EMPTY) empties++;
  }
  const x = Math.floor(index / n);
  const y = index % n;
  const line = Math.min(x, y, n - 1 - x, n - 1 - y);
  value += WEIGHTS.line[Math.min(line, WEIGHTS.line.length - 1)] * (empties / Math.max(1, playable));
  return { value, board: result.board };
}

/**
 * The best single reply `color` has on `board`, by the same one-ply rating - what
 * the look-ahead charges a candidate of ours for. 0 when there is nothing to play.
 * @param {Board} board @param {number} color @param {Set<string>} [history]
 */
export function bestReplyValue(board, color, history) {
  const chains = allChains(board);
  const before = positionValue(board, color);
  let best = 0;
  for (const i of candidatePoints(board, color, { chains })) {
    const rated = rateMoveOn(board, i, color, { history, before, chains });
    if (rated && rated.value > best) best = rated.value;
  }
  return best;
}

/**
 * The points worth rating at all for `color`. Legality is rateMove's job; this
 * drops the moves that are legal and wrong:
 *   - our own single-point eyes, and anywhere else inside territory we have
 *     already sealed (worth nothing under area scoring, and it is how eyes get
 *     filled) - UNLESS a neighbouring chain of ours is in atari, when connecting
 *     through the point may be the only way to save it;
 *   - the inside of small sealed ENEMY territory, where a stone just dies - unless
 *     the move captures something, or `desperate` (behind with the game ending).
 * @param {Board} board @param {number} color
 * @param {{ exclude?: Set<number>, desperate?: boolean, chains?: ReturnType<typeof allChains> }} [opts]
 */
export function candidatePoints(board, color, opts = {}) {
  const { n, cells } = board;
  const adj = adjacency(n);
  const chains = opts.chains ?? allChains(board);
  const { regions, regionOf } = emptyRegions(board);
  const foe = opposite(color);
  // Enemy territory this small has no room for two eyes; anything larger is not
  // really settled and is fair game.
  const hopeless = opts.desperate ? 3 : Math.max(6, n);
  const out = [];
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== EMPTY || opts.exclude?.has(i)) continue;
    let rescues = false;
    let captures = false;
    for (const j of adj[i]) {
      const id = chains.chainOf[j];
      if (id === -1 || chains.chains[id].liberties.length !== 1) continue;
      if (cells[j] === color) rescues = true;
      else captures = true;
    }
    const region = regions[regionOf[i]];
    if (!rescues && !captures) {
      if (region.owner === color || isEyeOf(board, i, color)) continue;
      if (region.owner === foe && region.points.length <= hopeless) continue;
    }
    out.push(i);
  }
  return out;
}

/**
 * Pick the move for `color`, or decide to pass.
 *
 * Passing: when nothing is worth playing (every candidate is worth less than
 * PASS_BELOW - the dame are filled and our territory is sealed), and also when
 * the opponent has just passed, we are ahead on the game's own count, and what
 * is left is crumbs (below BANK_WIN_BELOW): a second pass ends the game, which
 * banks the win and the win streak instead of playing on for a point or two.
 * Behind with the opponent's pass on the table, passing would be resigning, so
 * anything that is not an outright loss of stones gets tried first.
 *
 * @param {Board | string[]} position  a parsed Board, or getBoardState()'s columns
 * @param {{
 *   color?: number, history?: Set<string> | Iterable<string[] | string>, komi?: number,
 *   opponentPassed?: boolean, exclude?: Set<number>, rng?: () => number, jitter?: number,
 * }} [opts]
 * @returns {{ pass: boolean, index: number, x: number, y: number, value: number, reason: string, ahead: boolean }}
 */
export function chooseMove(position, opts = {}) {
  const board = Array.isArray(position) ? parseBoard(position) : position;
  const color = opts.color ?? BLACK;
  const history = opts.history instanceof Set ? opts.history : historyKeys(opts.history);
  const score = areaScore(board, opts.komi ?? 0);
  // A tie is a win for black, so "ahead" is strict only for white.
  const ahead = color === BLACK ? score.black >= score.white : score.white > score.black;
  const desperate = !!opts.opponentPassed && !ahead;

  const chains = allChains(board);
  const before = positionValue(board, color);
  const rng = opts.rng ?? (() => 0);
  const jitter = opts.jitter ?? 0;
  /** @type {{ index: number, value: number, board: Board }[]} */
  const rated = [];
  for (const i of candidatePoints(board, color, { exclude: opts.exclude, desperate, chains })) {
    const r = rateMoveOn(board, i, color, { history, before, chains });
    if (!r) continue;
    // Jitter only breaks near-ties, so the same opening is not replayed forever.
    rated.push({ index: i, value: r.value + (jitter > 0 ? rng() * jitter : 0), board: r.board });
  }
  rated.sort((a, b) => b.value - a.value);

  // Look-ahead: the faction AIs ALWAYS capture what is capturable and atari what
  // can be put in atari, so the one-ply favourite is re-ranked by what it leaves
  // the opponent - its value minus (a share of) their best reply to it. Only the
  // top few are worth the cost, and the reply's own history includes the board we
  // are leaving, so an illegal ko recapture is not counted as a threat.
  const width = Math.min(rated.length, opts.lookahead ?? LOOKAHEAD.width);
  let best = -1;
  let bestValue = -Infinity;
  if (width > 1) {
    const replyHistory = new Set(history);
    replyHistory.add(boardKey(board));
    const foe = opposite(color);
    let bestNet = -Infinity;
    for (let k = 0; k < width; k++) {
      const net = rated[k].value - LOOKAHEAD.replyWeight * bestReplyValue(rated[k].board, foe, replyHistory);
      if (net > bestNet) {
        bestNet = net;
        best = rated[k].index;
        bestValue = rated[k].value;
      }
    }
  } else if (rated.length > 0) {
    best = rated[0].index;
    bestValue = rated[0].value;
  }

  const pass = (reason) => ({ pass: true, index: -1, x: -1, y: -1, value: best === -1 ? 0 : bestValue, reason, ahead });
  if (best === -1) return pass("no playable point");
  if (desperate) {
    // Losing and about to be counted: play anything that does not throw stones away.
    if (bestValue <= -WEIGHTS.ownAtari) return pass("behind, and every move loses stones");
  } else {
    if (bestValue < PASS_BELOW) return pass("nothing worth playing");
    if (opts.opponentPassed && bestValue < BANK_WIN_BELOW) return pass("opponent passed and we are ahead");
  }
  return {
    pass: false,
    index: best,
    x: Math.floor(best / board.n),
    y: best % board.n,
    value: bestValue,
    reason: "best candidate",
    ahead,
  };
}

// ── Which faction to play ────────────────────────────────────────────────────

/**
 * Weighted round-robin over the configured opponents: the next game goes to
 * whoever has played the fewest games per unit of weight, ties to config order.
 * Games are counted from the game's own per-opponent stats, which an aug install
 * resets along with the node power - so the split restarts with the bonuses.
 * @param {{ name: string, weight?: number }[]} opponents
 * @param {Record<string, { wins?: number, losses?: number } | undefined>} [stats]
 * @returns {{ name: string, weight?: number, boardSize?: number } | null}
 */
export function pickOpponent(opponents, stats = {}) {
  let best = null;
  let bestLoad = Infinity;
  for (const entry of opponents ?? []) {
    const weight = Number(entry.weight ?? 1);
    if (!(weight > 0)) continue;
    const played = (stats[entry.name]?.wins ?? 0) + (stats[entry.name]?.losses ?? 0);
    const load = played / weight;
    if (load < bestLoad) {
      bestLoad = load;
      best = entry;
    }
  }
  return best;
}
