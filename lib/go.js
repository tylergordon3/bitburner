// lib/go.js
//
// IPvGO player, run OFF-home by every daemon (lib/daemon-core.js, optional - it
// waits for a host with ~10GB to spare). It plays the subnet game against the
// configured factions, back to back, for as long as the node lasts.
//
// WHY: every finished game adds "node power" for that faction, and node power is
// a permanent-until-reset multiplier on a stat that depends on WHO you played
// (bitburner-src src/Go/effects/effect.ts): Tetrads raise all four combat stat
// levels, Daedalus faction and company reputation gain, The Black Hand hacking
// money, Illuminati hack/grow/weaken speed, Netburners hacknet production, Slum
// Snakes crime success. The bonus is 1 + ln(p+1) * (p+1)^0.3 * 0.002 * power, so
// ~1,000 node power against Tetrads is +7.7% to every combat stat and ~10,000 is
// +20%. It needs no Source-File (SF14 only doubles it and adds the cheat API,
// which this does not use), and - the reason this runs CONTINUOUSLY rather than
// once - an aug install wipes node power back to zero (Go.prestigeAugmentation),
// so the bonus has to be re-earned after every reset. Winning two in a row with a
// faction you belong to also adds favor with it, which does survive.
//
// A game pays black's final score x a difficulty multiplier ((komi + 0.5) / 4)
// x a streak multiplier (1 + 0.25 per consecutive win, capped at 3x; 0.5x on a
// loss). So wins compound, a big win beats a narrow one, and an abandoned game -
// resetBoardState with moves on the board - throws the streak away: this loop
// always FINISHES the game it finds, whoever it is against.
//
// RAM: 9.6GB = 1.6 base + getBoardState (4) + makeMove (4). Everything else it
// calls is free - passTurn, getCurrentPlayer, getGameState, getMoveHistory,
// getOpponent, resetBoardState, analysis.getStats. The 16GB analysis calls
// (getChains / getLiberties / getControlledEmptyNodes) and the 8GB getValidMoves
// are deliberately never touched: lib/go-logic.js (pure, 0GB, unit-tested)
// derives chains, liberties, legality, territory and eyes from the board itself,
// and holds every decision. This file is only the I/O around it.
//
// It cannot die: each turn is wrapped in try/catch (makeMove THROWS on a move the
// game considers illegal, and on "not your turn" if a human is clicking the same
// board), a refused point is excluded and another chosen, and a wait that never
// ends is cut off by starting a new game. Publishes globalThis.gordGoState.
//
// Args (from lib/daemon-core.js, which already pays for getResetInfo):
//   [0] the current BitNode number - the opponent list is per node (lib/config.js).

import { forNode } from "./config.js";
import { emitEvent } from "./events.js";
import { boardKey, chooseMove, historyKeys, parseBoard, pickOpponent } from "./go-logic.js";

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  // Resolved through forNode, not read off CONFIG: `opponents` is exactly the kind
  // of key a BITNODE entry overrides (tests/config-captures.test.mjs).
  const node = Number(ns.args[0] ?? 0);
  const G = forNode(Number.isFinite(node) ? node : 0).go;
  if (!G.enabled) {
    ns.tprint("go.js: disabled in config (go.enabled) - exiting.");
    return;
  }

  // (Named `tally`, not `run`: the RAM analyser bills by identifier NAME, so a
  // variable called `run` risks being charged as ns.run's 1GB.)
  const tally = {
    status: "starting",
    opponent: /** @type {string | null} */ (null),
    boardSize: 0,
    games: 0,
    wins: 0,
    losses: 0,
    moves: 0, // our turns in the current game
    rejected: 0, // moves the game refused (our legality disagreed with its own)
    errors: 0,
    lastResult: /** @type {null | { opponent: string, won: boolean, black: number, white: number, moves: number, at: number }} */ (null),
    lastJournalAt: 0,
    startedAt: Date.now(),
  };
  // A game WE have moved in is under way, so its ending is ours to record.
  let playing = false;
  // Points the game refused on the current position (reset when the board changes).
  let refusedOn = "";
  /** @type {Set<number>} */
  let refused = new Set();
  // How long it has been the opponent's turn without them moving.
  let waitingSince = 0;

  while (true) {
    try {
      const turn = ns.go.getCurrentPlayer();
      if (turn === "None") {
        // Game over (or nothing on the board yet). Record ours, then deal again.
        if (playing) recordResult(ns, tally, G);
        playing = false;
        waitingSince = 0;
        startGame(ns, tally, G);
      } else if (turn === "White") {
        // Only reachable when we pick up a board mid-move (a reload, a restart, a
        // human's game): makeMove/passTurn below resolve only after the opponent
        // has answered. passTurn() would throw "not your turn" here and awaiting
        // opponentNextTurn() could wait forever, so just watch - and if the
        // opponent never moves, deal a fresh board rather than sit here all node.
        waitingSince = waitingSince || Date.now();
        tally.status = "waiting for the opponent's move";
        if (Date.now() - waitingSince > G.stuckMs) {
          waitingSince = 0;
          playing = false;
          startGame(ns, tally, G);
        }
      } else {
        waitingSince = 0;
        const columns = ns.go.getBoardState();
        const history = ns.go.getMoveHistory();
        // An untouched board costs nothing to swap (the streak only breaks when
        // moves have been made), so make sure it is the game config asks for.
        const want = history.length === 0 ? nextOpponent(ns, G) : null;
        // A "No AI" practice board is never ours to finish: nobody answers a move
        // there, so makeMove would wait for ever - and it has no streak to lose.
        const wrongBoard = ns.go.getOpponent() === "No AI" || (!!want &&
          (ns.go.getOpponent() !== want.name || columns.length !== Number(want.boardSize ?? G.boardSize)));
        if (wrongBoard) {
          // Deal the right one and play it next tick (NOT `continue`: a swap that
          // somehow never took would then spin without ever yielding).
          startGame(ns, tally, G);
        } else {
          if (history.length === 0) tally.moves = 0;
          tally.opponent = ns.go.getOpponent();
          tally.boardSize = columns.length;

          const board = parseBoard(columns);
          const key = boardKey(board);
          if (key !== refusedOn) {
            refusedOn = key;
            refused = new Set();
          }
          const state = ns.go.getGameState();
          const decision = chooseMove(board, {
            history: historyKeys(history),
            komi: state.komi,
            // previousMove is null after a pass (and on a fresh board); it is our
            // turn, so a null with moves on the board means the opponent passed.
            opponentPassed: state.previousMove === null && history.length > 0,
            exclude: refused,
            rng: Math.random,
            jitter: G.jitter,
            lookahead: G.lookahead,
          });

          playing = true;
          tally.moves++;
          let reply = null;
          // After too many refusals stop arguing with the game and pass.
          if (decision.pass || refused.size >= G.maxRejects) {
            tally.status = `passing (${decision.pass ? decision.reason : "too many refused moves"})`;
            reply = await ns.go.passTurn();
          } else {
            tally.status = `playing ${decision.x},${decision.y}`;
            try {
              reply = await ns.go.makeMove(decision.x, decision.y);
            } catch (e) {
              // The game refused the point. Never retry it on this position.
              refused.add(decision.index);
              tally.rejected++;
              ns.print(`WARN: move ${decision.x},${decision.y} refused: ${String(e)}`);
            }
          }
          if (reply?.type === "gameOver") {
            recordResult(ns, tally, G);
            playing = false;
          }
        }
      }
    } catch (e) {
      // Anything else (a human moving on the same board, an API change): note it,
      // back off, and look at the board again from scratch.
      tally.errors++;
      tally.status = `error: ${String(e).slice(0, 120)}`;
      ns.print(`ERROR: ${String(e)}`);
      publish(ns, tally);
      await ns.sleep(G.errorBackoffMs);
    }

    publish(ns, tally);
    // Always yield: every branch above can complete without awaiting anything.
    await ns.sleep(G.moveDelayMs);
  }
}

/**
 * Per-faction results as the game keeps them (free). Reset by an aug install,
 * together with the node power they describe.
 * @param {NS} ns
 */
function factionStats(ns) {
  try { return ns.go.analysis.getStats() ?? {}; }
  catch { return {}; }
}

/** The configured opponent that is furthest behind its share of the games. */
function nextOpponent(ns, G) {
  return pickOpponent(G.opponents, /** @type {any} */ (factionStats(ns)));
}

/** Deal a new board against the next opponent in the rotation. */
function startGame(ns, tally, G) {
  const want = nextOpponent(ns, G);
  if (!want) {
    tally.status = "no opponents configured (go.opponents)";
    return;
  }
  const size = Number(want.boardSize ?? G.boardSize);
  // checkJs wants the GoOpponent / board-size unions; config holds plain values.
  ns.go.resetBoardState(/** @type {any} */ (want.name), /** @type {any} */ (size));
  tally.opponent = want.name;
  tally.boardSize = size;
  tally.moves = 0;
  tally.status = `new game vs ${want.name} (${size}x${size})`;
}

/** Count a finished game and, sparingly, tell the journal. */
function recordResult(ns, tally, G) {
  const state = ns.go.getGameState();
  const opponent = String(ns.go.getOpponent());
  // The game's own rule: black loses only when strictly behind (a tie is a win).
  const won = state.blackScore >= state.whiteScore;
  tally.games++;
  if (won) tally.wins++;
  else tally.losses++;
  tally.lastResult = {
    opponent,
    won,
    black: state.blackScore,
    white: state.whiteScore,
    moves: tally.moves,
    at: Date.now(),
  };
  const stats = /** @type {any} */ (factionStats(ns))[opponent];
  const bonus = stats ? ` - ${stats.bonusPercent.toFixed(2)}% ${stats.bonusDescription}` : "";
  const line = `${won ? "Won" : "Lost"} vs ${opponent} ${state.blackScore}-${state.whiteScore}` +
    ` (${tally.wins}W/${tally.losses}L so far)${bonus}`;
  ns.print(line);
  // A game ends every minute or two; the journal gets one line per journalEveryMs.
  if (Date.now() - tally.lastJournalAt >= G.journalEveryMs) {
    tally.lastJournalAt = Date.now();
    emitEvent(`[go] ${line}`, "event", { factions: [opponent] });
  }
}

/** @param {NS} ns */
function publish(ns, tally) {
  const stats = /** @type {Record<string, any>} */ (factionStats(ns));
  globalThis.gordGoState = {
    status: tally.status,
    opponent: tally.opponent,
    boardSize: tally.boardSize,
    games: tally.games,
    wins: tally.wins,
    losses: tally.losses,
    moves: tally.moves,
    rejected: tally.rejected,
    errors: tally.errors,
    lastResult: tally.lastResult,
    // What the games have bought so far, per faction (the game's own numbers).
    bonuses: Object.entries(stats).map(([name, s]) => ({
      opponent: name,
      percent: s.bonusPercent,
      description: s.bonusDescription,
      wins: s.wins,
      losses: s.losses,
      winStreak: s.winStreak,
    })),
    startedAt: tally.startedAt,
    updatedAt: Date.now(),
  };
}
