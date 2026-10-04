// tests/go-logic.test.mjs
// Unit tests for the pure IPvGO player (lib/go-logic.js). Run: npm test  (needs Node >=20).
//
// Boards are written the way ns.go.getBoardState() returns them: an array of
// COLUMN strings, board[x][y], "X" black, "O" white, "." empty, "#" dead node.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EMPTY,
  BLACK,
  WHITE,
  DEAD,
  BANK_WIN_BELOW,
  parseBoard,
  boardColumns,
  boardKey,
  historyKeys,
  chainAt,
  allChains,
  playStone,
  moveVerdict,
  legalPoints,
  isEyeOf,
  emptyRegions,
  areaScore,
  territoryEstimate,
  rateMove,
  candidatePoints,
  chooseMove,
  pickOpponent,
} from "../lib/go-logic.js";
import { CONFIG, forNode } from "../lib/config.js";

const N = 5;
const at = (x, y, n = N) => x * n + y;
/** Pad a few leading columns out to a full 5x5 board. */
const board5 = (...columns) => parseBoard([...columns, ...Array(N - columns.length).fill(".....")]);

/** Deterministic rng for the games below. */
function rngOf(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ── Board, chains, liberties ─────────────────────────────────────────────────

test("parseBoard: column strings round-trip, dead nodes included", () => {
  const columns = ["XX.O.", "X..OO", ".XO..", "XXO.#", ".XO.#"];
  const board = parseBoard(columns);
  assert.equal(board.n, 5);
  assert.equal(board.cells[at(0, 0)], BLACK);
  assert.equal(board.cells[at(0, 3)], WHITE);
  assert.equal(board.cells[at(0, 2)], EMPTY);
  assert.equal(board.cells[at(3, 4)], DEAD);
  assert.deepEqual(boardColumns(board), columns);
  assert.equal(boardKey(board), columns.join(""));
  // getMoveHistory() hands back boards in the same form; both forms make the same key.
  assert.deepEqual([...historyKeys([columns, columns.join("")])], [columns.join("")]);
});

test("chainAt: stones and liberties of a chain", () => {
  const board = board5(".....", ".XX..", ".O...");
  const chain = chainAt(board, at(1, 1));
  assert.deepEqual(chain.stones.sort((a, b) => a - b), [at(1, 1), at(1, 2)]);
  // (2,1) is white, so the chain breathes through the other five points.
  assert.deepEqual(chain.liberties.sort((a, b) => a - b), [at(0, 1), at(0, 2), at(1, 0), at(1, 3), at(2, 2)]);
  assert.equal(chainAt(board, at(2, 1)).liberties.length, 3);
});

test("liberties: a dead node is a wall, not a liberty", () => {
  // The corner stone has (0,1) and (1,0) as neighbours; one of them is dead.
  const board = board5("X#...", ".....");
  assert.deepEqual(chainAt(board, at(0, 0)).liberties, [at(1, 0)]);
});

test("allChains: every stone belongs to exactly one chain", () => {
  const board = board5("XX.O.", "X..OO", ".XO..");
  const { chains, chainOf } = allChains(board);
  assert.equal(chains.length, 4); // XX/X, the lone X, OOO, the lone O
  for (let i = 0; i < board.cells.length; i++) {
    const stone = board.cells[i] === BLACK || board.cells[i] === WHITE;
    assert.equal(chainOf[i] !== -1, stone);
    if (stone) assert.ok(chains[chainOf[i]].stones.includes(i));
  }
});

// ── Captures, suicide, ko ────────────────────────────────────────────────────

test("capture: filling a chain's last liberty removes it", () => {
  const board = board5(".X...", "XO...", ".X...");
  const result = playStone(board, at(1, 2), BLACK);
  assert.ok(result.ok);
  assert.deepEqual(result.captured, [at(1, 1)]);
  assert.equal(result.board.cells[at(1, 1)], EMPTY);
  // The original is untouched - every candidate is tried on a copy.
  assert.equal(board.cells[at(1, 1)], WHITE);
});

test("capture: a whole chain goes at once", () => {
  // White (1,1)-(1,2) is down to its last liberty at (1,3).
  const board = board5(".XX..", "XOO..", ".XX..");
  const result = playStone(board, at(1, 3), BLACK);
  assert.ok(result.ok);
  assert.deepEqual(result.captured.sort((a, b) => a - b), [at(1, 1), at(1, 2)]);
});

test("suicide: a stone with no liberty that captures nothing is refused", () => {
  const board = board5(".O...", "O.O..", ".O...");
  assert.deepEqual(playStone(board, at(1, 1), BLACK), { ok: false, reason: "suicide" });
  assert.ok(!legalPoints(board, BLACK).includes(at(1, 1)));
  // ...but white may fill its own point.
  assert.ok(playStone(board, at(1, 1), WHITE).ok);
});

test("capture comes before the suicide test", () => {
  // (0,0) has no liberty of its own, but playing it takes both white stones.
  const board = board5(".OX..", "OX...", "X....");
  const result = playStone(board, at(0, 0), BLACK);
  assert.ok(result.ok);
  assert.deepEqual(result.captured.sort((a, b) => a - b), [at(0, 1), at(1, 0)]);
  assert.equal(result.chain.liberties.length, 2);
});

test("playStone refuses occupied points, dead nodes and off-board indices", () => {
  const board = board5("X#...");
  assert.equal(playStone(board, at(0, 0), WHITE).reason, "occupied");
  assert.equal(playStone(board, at(0, 1), WHITE).reason, "dead-node");
  assert.equal(playStone(board, 25, WHITE).reason, "off-board");
  assert.equal(playStone(board, -1, WHITE).reason, "off-board");
});

test("ko: the immediate recapture recreates an earlier board and is refused", () => {
  const start = board5(".X...", "XOX..", "O.O..", ".O...");
  const history = new Set([boardKey(start)]);
  const taken = playStone(start, at(2, 1), BLACK);
  assert.ok(taken.ok);
  assert.deepEqual(taken.captured, [at(1, 1)]);

  // White retaking at (1,1) would put the board back exactly as it started.
  assert.ok(playStone(taken.board, at(1, 1), WHITE).ok, "legal by capture alone");
  assert.deepEqual(moveVerdict(taken.board, at(1, 1), WHITE, history), { ok: false, reason: "repeat" });
  assert.ok(!legalPoints(taken.board, WHITE, history).includes(at(1, 1)));
  assert.ok(legalPoints(taken.board, WHITE).includes(at(1, 1)), "no history, no ko");

  // Superko: it stays illegal however far back that board is in the history.
  const longer = new Set([boardKey(start), "some-other-position", boardKey(board5("X...."))]);
  assert.equal(moveVerdict(taken.board, at(1, 1), WHITE, longer).reason, "repeat");

  // After an exchange elsewhere the same recapture makes a NEW position: legal.
  const b2 = playStone(taken.board, at(4, 4), WHITE);
  const b3 = playStone(b2.board, at(4, 0), BLACK);
  history.add(boardKey(taken.board)).add(boardKey(b2.board));
  assert.ok(moveVerdict(b3.board, at(1, 1), WHITE, history).ok);
});

test("ko: the chooser never picks the forbidden recapture", () => {
  const start = board5(".X...", "XOX..", "O.O..", ".O...");
  const taken = playStone(start, at(2, 1), BLACK);
  const decision = chooseMove(taken.board, { color: WHITE, history: [boardColumns(start)] });
  assert.notEqual(decision.index, at(1, 1));
});

// ── Eyes, territory, score ───────────────────────────────────────────────────

test("isEyeOf: every real neighbour is ours; edges and dead nodes are walls", () => {
  assert.ok(isEyeOf(board5(".X...", "X...."), at(0, 0), BLACK));
  assert.ok(!isEyeOf(board5(".X...", "X...."), at(0, 0), WHITE));
  assert.ok(!isEyeOf(board5(".X...", "O...."), at(0, 0), BLACK), "an enemy neighbour is no eye");
  assert.ok(!isEyeOf(board5(".X...", "....."), at(0, 0), BLACK), "an open side is no eye");
  assert.ok(isEyeOf(board5(".#...", "X...."), at(0, 0), BLACK), "a dead node is a wall");
  assert.ok(!isEyeOf(board5(".#...", "#...."), at(0, 0), BLACK), "nothing but walls is nobody's");
});

test("areaScore: stones plus regions bordered by one colour, komi to white", () => {
  const split = parseBoard([".X.O.", ".X.O.", ".X.O.", ".X.O.", ".X.O."]);
  // Row y=0 is black's, row y=4 white's, the middle row touches both.
  assert.deepEqual(areaScore(split, 5.5), { black: 10, white: 15.5 });
  assert.deepEqual(areaScore(split), { black: 10, white: 10 });
  const { regions } = emptyRegions(split);
  assert.deepEqual(regions.map(r => r.owner).sort(), [EMPTY, BLACK, WHITE].sort());
});

test("areaScore: one enemy stone inside a region makes the whole region neutral", () => {
  const invaded = parseBoard([".X.O.", ".X.O.", "OX.O.", ".X.O.", ".X.O."]);
  assert.deepEqual(areaScore(invaded), { black: 5, white: 11 });
});

test("areaScore: a region bigger than n*n - 3 belongs to nobody", () => {
  assert.deepEqual(areaScore(board5("X....")), { black: 1, white: 0 });
  // Three stones leave 22 = n*n - 3 empty points: that IS territory.
  assert.deepEqual(areaScore(board5("XXX..")), { black: 25, white: 0 });
});

/** A random position: `fill` of the points stones, a few dead nodes. */
function randomBoard(n, rng, fill) {
  const cells = new Uint8Array(n * n);
  for (let i = 0; i < cells.length; i++) {
    const r = rng();
    cells[i] = r < 0.04 ? DEAD : r < 0.04 + fill / 2 ? BLACK : r < 0.04 + fill ? WHITE : EMPTY;
  }
  return { n, cells };
}

test("areaScore counts exactly the regions emptyRegions lists (it no longer builds them)", () => {
  const rng = rngOf(41);
  for (let i = 0; i < 300; i++) {
    // Sizes interleaved on purpose: the fills share scratch buffers per board size.
    const n = [5, 13, 7, 9][i % 4];
    const board = randomBoard(n, rng, 0.2 + 0.6 * rng());
    let black = 0;
    let white = 5.5;
    for (const c of board.cells) {
      if (c === BLACK) black++;
      else if (c === WHITE) white++;
    }
    for (const region of emptyRegions(board).regions) {
      if (region.owner === BLACK) black += region.points.length;
      else if (region.owner === WHITE) white += region.points.length;
    }
    assert.deepEqual(areaScore(board, 5.5), { black, white }, boardColumns(board).join("/"));
  }
});

test("shared scratch buffers: an analysis is not disturbed by the ones run in between", () => {
  const rng = rngOf(43);
  const small = randomBoard(5, rng, 0.5);
  const large = randomBoard(13, rng, 0.5);
  const read = (board) => ({
    chains: allChains(board).chains,
    estimate: territoryEstimate(board),
    score: areaScore(board, 5.5),
    move: chooseMove(board, { komi: 5.5 }),
  });
  const smallFirst = read(small);
  const largeFirst = read(large);
  // Again, the other way round and with the other board's fills in between.
  assert.deepEqual(read(large), largeFirst);
  assert.deepEqual(read(small), smallFirst);
  // A chain read survives later fills (it is returned as plain arrays).
  const stone = large.cells.findIndex(c => c === BLACK);
  const chain = chainAt(large, stone);
  const copy = structuredClone(chain);
  read(small);
  read(large);
  assert.deepEqual(chain, copy);
});

test("territoryEstimate: nearer stones claim a point; a chain short of liberties claims nothing", () => {
  const even = parseBoard([".....", "..X..", ".....", "..O..", "....."]);
  assert.equal(territoryEstimate(even), 0);
  assert.ok(territoryEstimate(board5(".....", "..X..")) > 20);
  // The black stone in the corner has two liberties: it counts as a stone and no
  // more, so all 23 empty points are the centre white stone's.
  assert.equal(territoryEstimate(parseBoard(["X....", ".....", "..O..", ".....", "....."])), 1 - 1 - 23);
});

// ── Move choice ──────────────────────────────────────────────────────────────

test("chooseMove: captures a chain in atari", () => {
  const decision = chooseMove(board5(".X...", "XO...", ".X..."));
  assert.equal(decision.pass, false);
  assert.deepEqual([decision.x, decision.y], [1, 2]);
});

test("chooseMove: rescues its own chain in atari", () => {
  const decision = chooseMove(board5(".O...", "OX...", ".O..."));
  assert.equal(decision.pass, false);
  assert.deepEqual([decision.x, decision.y], [1, 2]);
});

test("chooseMove: does not walk into self-atari", () => {
  // (1,1) would be a stone with one liberty and nothing captured.
  const board = board5(".O...", "O....", ".O...");
  assert.ok(rateMove(board, at(1, 1), BLACK) < 0);
  assert.notEqual(chooseMove(board).index, at(1, 1));
});

test("chooseMove: accepts column strings as well as a parsed board", () => {
  const columns = [".X...", "XO...", ".X...", ".....", "....."];
  assert.deepEqual(chooseMove(columns), chooseMove(parseBoard(columns)));
});

test("chooseMove: honours the exclude set (moves the game refused)", () => {
  const board = board5(".X...", "XO...", ".X...");
  const decision = chooseMove(board, { exclude: new Set([at(1, 2)]) });
  assert.notEqual(decision.index, at(1, 2));
});

test("eyes: never a candidate, never chosen", () => {
  // Black lives with eyes at (0,0) and (0,4); white owns the right, a dame row between.
  const board = parseBoard([".XXX.", "XXXXX", ".....", "OOOOO", "....."]);
  const candidates = candidatePoints(board, BLACK);
  assert.ok(!candidates.includes(at(0, 0)) && !candidates.includes(at(0, 4)));
  const decision = chooseMove(board);
  assert.equal(decision.pass, false);
  assert.equal(decision.x, 2, "plays the contested row instead");

  // Nothing left but its own eyes: pass rather than fill one.
  const full = parseBoard([".XXX.", "XXXXX", "XXXXX", "XXXXX", "XXXXX"]);
  assert.deepEqual(candidatePoints(full, BLACK), []);
  assert.equal(chooseMove(full).pass, true);
});

test("eyes: the one exception - connecting through the point saves a chain in atari", () => {
  // (0,1) is in atari and (0,0) is its last liberty; (0,0) looks like an eye.
  const board = board5(".XO..", "XO...", "X....");
  assert.ok(isEyeOf(board, at(0, 0), BLACK));
  assert.equal(chainAt(board, at(0, 1)).liberties.length, 1);
  assert.ok(candidatePoints(board, BLACK).includes(at(0, 0)));
});

test("candidatePoints: skips sealed territory of either side, unless desperate", () => {
  const sealed = parseBoard([".XXO.", ".XXO.", ".XXO.", ".XXO.", ".XXO."]);
  assert.deepEqual(candidatePoints(sealed, BLACK), []);
  assert.deepEqual(candidatePoints(sealed, WHITE), []);
  // Behind with the game about to end, the opponent's five points are worth a try.
  const desperate = candidatePoints(sealed, BLACK, { desperate: true });
  assert.deepEqual(desperate, [at(0, 4), at(1, 4), at(2, 4), at(3, 4), at(4, 4)]);
});

// ── Passing ──────────────────────────────────────────────────────────────────

test("pass: nothing left to play", () => {
  const sealed = parseBoard([".XXO.", ".XXO.", ".XXO.", ".XXO.", ".XXO."]);
  const decision = chooseMove(sealed, { komi: 0.5 });
  assert.equal(decision.pass, true);
  assert.equal(decision.ahead, true);
});

test("pass: opponent passed and we are ahead - bank the win instead of playing for crumbs", () => {
  // One dame point left at (2,2).
  const board = parseBoard([".XXO.", ".XXO.", ".X.O.", ".XXO.", ".XXO."]);
  const playing = chooseMove(board, { komi: 0.5 });
  assert.equal(playing.pass, false, "mid-game the dame is worth taking");
  assert.deepEqual([playing.x, playing.y], [2, 2]);
  assert.ok(playing.value < BANK_WIN_BELOW, "...but it is a crumb");

  const banked = chooseMove(board, { komi: 0.5, opponentPassed: true });
  assert.equal(banked.pass, true);
  assert.equal(banked.ahead, true);
});

test("pass: opponent passed and we are BEHIND - passing would resign, so play on", () => {
  const board = parseBoard([".XXO.", ".XXO.", ".X.O.", ".XXO.", ".XXO."]);
  const decision = chooseMove(board, { komi: 20, opponentPassed: true });
  assert.equal(decision.ahead, false);
  assert.equal(decision.pass, false);
});

test("pass: a tie counts as ahead for black (the game's own rule), not for white", () => {
  const sealed = parseBoard([".XXO.", ".XXO.", ".XXO.", ".XXO.", ".XXO."]);
  assert.equal(chooseMove(sealed, { komi: 5 }).ahead, true); // 15 v 15
  assert.equal(chooseMove(sealed, { komi: 5, color: WHITE }).ahead, false);
  assert.equal(chooseMove(sealed, { komi: 5.5 }).ahead, false);
});

// ── Whole games ──────────────────────────────────────────────────────────────

/**
 * Referee a game between two move pickers. Every move is checked independently
 * of the chooser: legal by the rules, and never recreating an earlier position.
 */
function playGame(start, pickBlack, pickWhite, komi) {
  let board = parseBoard(start);
  const history = new Set();
  let color = BLACK;
  let passes = 0;
  let opponentPassed = false;
  let moves = 0;
  const limit = board.n * board.n * 4;
  while (passes < 2 && moves < limit) {
    const decision = (color === BLACK ? pickBlack : pickWhite)(board, { color, history, komi, opponentPassed });
    if (decision.pass) {
      passes++;
      opponentPassed = true;
    } else {
      const verdict = moveVerdict(board, decision.index, color, history);
      assert.ok(verdict.ok, `illegal move ${decision.x},${decision.y}: ${verdict.reason}`);
      history.add(boardKey(board));
      board = verdict.board;
      assert.ok(!history.has(boardKey(board)), "position repeated");
      for (const chain of allChains(board).chains) assert.ok(chain.liberties.length > 0, "a dead chain was left on the board");
      passes = 0;
      opponentPassed = false;
    }
    color = color === BLACK ? WHITE : BLACK;
    moves++;
  }
  assert.ok(passes === 2, `game did not end within ${limit} moves`);
  return { board, moves, score: areaScore(board, komi) };
}

const heuristic = (seed) => {
  const rng = rngOf(seed);
  return (board, opts) => chooseMove(board, { ...opts, rng, jitter: 0.25 });
};

const randomPlayer = (seed) => {
  const rng = rngOf(seed);
  return (board, { color, history }) => {
    const points = legalPoints(board, color, history).filter(i => !isEyeOf(board, i, color));
    if (points.length === 0) return { pass: true };
    const index = points[Math.floor(rng() * points.length)];
    return { pass: false, index, x: Math.floor(index / board.n), y: index % board.n };
  };
};

test("self-play: games run to two passes with no illegal move and no repeated position", () => {
  const empty7 = Array(7).fill(".......");
  // A subnet with dead nodes, as the game deals them.
  const holes9 = ["##.......", "#........", ".........", "....#....", ".........", ".........", "........#", ".......##", "......###"];
  for (const [start, seed] of [[empty7, 1], [empty7, 2], [holes9, 3]]) {
    const { board, moves, score } = playGame(start, heuristic(seed), heuristic(seed + 100), 5.5);
    assert.ok(moves > start.length, "a real game was played");
    assert.ok(score.black + score.white > 0);
    // Dead nodes are never played on.
    const before = parseBoard(start);
    for (let i = 0; i < before.cells.length; i++) {
      if (before.cells[i] === DEAD) assert.equal(board.cells[i], DEAD);
    }
  }
});

test("sanity: the player beats a random legal-move opponent every time", () => {
  const empty7 = Array(7).fill(".......");
  let total = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const { score } = playGame(empty7, heuristic(seed), randomPlayer(seed + 50), 5.5);
    assert.ok(score.black >= score.white, `seed ${seed}: ${score.black} v ${score.white}`);
    total += score.black;
  }
  // Most of these end with the whole board (49); a random player that stumbles
  // into two eyes keeps a corner.
  assert.ok(total / 6 >= 40, `averaged ${(total / 6).toFixed(1)} of 49 points`);
});

// ── Opponent rotation and config ─────────────────────────────────────────────

test("pickOpponent: weighted round-robin on games played, ties to config order", () => {
  const order = [{ name: "Tetrads", weight: 3 }, { name: "Daedalus", weight: 1 }];
  assert.equal(pickOpponent(order, {}).name, "Tetrads");
  assert.equal(pickOpponent(order, { Tetrads: { wins: 2, losses: 1 } }).name, "Daedalus");
  assert.equal(pickOpponent(order, { Tetrads: { wins: 3 }, Daedalus: { losses: 1 } }).name, "Tetrads");
  assert.equal(pickOpponent(order, { Tetrads: { wins: 4 }, Daedalus: { losses: 1 } }).name, "Daedalus");
  // A zero weight parks an opponent without deleting the line.
  assert.equal(pickOpponent([{ name: "Illuminati", weight: 0 }, { name: "Daedalus" }], {}).name, "Daedalus");
  assert.equal(pickOpponent([], {}), null);
  assert.equal(pickOpponent(undefined, {}), null);
});

test("config: every node has a playable go section; BN6/BN7 lead with Tetrads", () => {
  const FACTIONS = new Set(["Netburners", "Slum Snakes", "The Black Hand", "Tetrads", "Daedalus", "Illuminati"]);
  for (const node of [0, 1, 2, 3, 4, 5, 6, 7, 9, 10]) {
    const go = forNode(node).go;
    assert.ok([5, 7, 9, 13].includes(go.boardSize), `BN${node} board size`);
    assert.ok(go.opponents.length > 0, `BN${node} has opponents`);
    for (const o of go.opponents) {
      assert.ok(FACTIONS.has(o.name), `BN${node}: ${o.name}`);
      assert.ok(o.weight > 0);
    }
    assert.ok(pickOpponent(go.opponents, {}));
  }
  assert.equal(forNode(6).go.opponents[0].name, "Tetrads");
  assert.equal(forNode(7).go.opponents[0].name, "Tetrads");
  assert.equal(CONFIG.paths.go, "/lib/go.js");
});

// ── RAM lint ─────────────────────────────────────────────────────────────────
// Bitburner bills a script for every API NAME it mentions, on any object. These
// two files exist to stay off the 16GB/8GB analysis calls; a helper function
// innocently named getLiberties would put them straight back on the bill.

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("RAM: neither Go file mentions the expensive analysis calls", () => {
  for (const file of ["../lib/go-logic.js", "../lib/go.js"]) {
    const src = stripComments(readFileSync(new URL(file, import.meta.url), "utf8"));
    for (const name of ["getChains", "getLiberties", "getControlledEmptyNodes", "getValidMoves", "setTestingBoardState", "cheat"]) {
      assert.ok(!new RegExp(`\\b${name}\\b`).test(src), `${file} mentions ${name}`);
    }
    // ...and the everyday trap: a local called `run`, `exec`, `scan`, ... is
    // billed as the ns function of that name.
    for (const name of ["run", "exec", "spawn", "scan", "kill", "hack", "grow", "weaken", "share", "rm", "ls", "ps"]) {
      assert.ok(!new RegExp(`\\b${name}\\b`).test(src), `${file} has an identifier named ${name}`);
    }
  }
});

test("RAM: the pure module is pure - no ns, and none of the calls the shell pays for", () => {
  const src = stripComments(readFileSync(new URL("../lib/go-logic.js", import.meta.url), "utf8"));
  assert.ok(!/\bns\b/.test(src), "lib/go-logic.js references ns");
  assert.ok(!/^import /m.test(src), "lib/go-logic.js imports something");
  for (const name of ["makeMove", "getBoardState", "passTurn", "resetBoardState"]) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(src), `lib/go-logic.js mentions ${name}`);
  }
});

test("RAM: the shell's paid calls are exactly getBoardState and makeMove (9.6GB with the base)", () => {
  const src = stripComments(readFileSync(new URL("../lib/go.js", import.meta.url), "utf8"));
  const calls = new Set([...src.matchAll(/\bns\.go\.(?:analysis\.)?(\w+)/g)].map(m => m[1]));
  const FREE = ["passTurn", "getCurrentPlayer", "getGameState", "getMoveHistory", "getOpponent", "resetBoardState", "getStats"];
  const paid = [...calls].filter(name => !FREE.includes(name)).sort();
  assert.deepEqual(paid, ["getBoardState", "makeMove"]);
});
