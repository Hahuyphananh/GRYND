/**
 * Chess VS-AI — Stage 3: the server-authoritative AI turn.
 *
 * WHAT THIS PROVES
 * ----------------
 * The AI's move is decided, validated and persisted by the SERVER, and exactly
 * once per turn, no matter what the client sends, how many requests arrive at
 * once, or how the retries line up.
 *
 * Everything here runs against an injected store whose `run` is a genuine
 * MUTEX — one transaction at a time, which is what `SELECT … FOR UPDATE` gives a
 * real request — so the ordering rules that prevent a duplicate AI move are
 * exercised for real rather than asserted from their source. The engine is
 * injected too (except for one end-to-end case that uses the real Stockfish
 * chooser), so failures, timeouts and junk answers can be driven deliberately.
 *
 * No database and no production data are involved.
 *
 * Run: npm run test:chess-ai-turn
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { Chess } from "chess.js";

import {
  AI_TURN_REFUSALS,
  advanceAiTurn,
  assessAiTurn,
  claimAiMove,
  parseAiTurnRequest,
  positionAfter,
  terminalResultFor,
} from "../src/lib/chessAiTurn.ts";
import { chessSeatsForHumanColor, CHESS_AI_PLAYER_ID } from "../src/lib/chessAiSeat.ts";
import { ChessGameplayEngineError } from "../src/lib/chessGameplayEngine.ts";
import { disposeChessEngine } from "../src/lib/evaluation/engine/stockfishEngine.ts";
import { MIN_EVALUABLE_PLIES } from "../src/lib/evaluation/games/chessEvaluator.ts";

// The real-engine case below boots the shared Stockfish instance; release it so
// the process can exit on its own.
after(async () => {
  await disposeChessEngine();
});

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const AI_MOVE_ROUTE = read("src/app/api/chess/ai-move/route.js");
const MOVE_ROUTE = read("src/app/api/chess/move/route.js");
const END_GAME_ROUTE = read("src/app/api/chess/end-game/route.js");
const AI_LIB = read("src/lib/chessAiTurn.ts");

const HUMAN = "user_2humanSeat";
const UUID = "11111111-1111-4111-8111-111111111111";
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** A game row with the seats a given human colour implies. */
function gameRow(humanColor, overrides = {}) {
  return {
    id: UUID,
    ...chessSeatsForHumanColor(HUMAN, humanColor),
    status: "in_progress",
    isAiGame: true,
    aiDifficulty: "medium",
    ...overrides,
  };
}

/**
 * Persisted move rows produced by actually PLAYING the moves with chess.js — so
 * every `fenAfter` is a real position and every ply is attributed to the seat
 * that moved.
 */
function playedMoves(ucis, humanColor = "white") {
  const whiteSeat = humanColor === "white" ? HUMAN : CHESS_AI_PLAYER_ID;
  const blackSeat = humanColor === "black" ? HUMAN : CHESS_AI_PLAYER_ID;
  const chess = new Chess();
  return ucis.map((uci, index) => {
    const move = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci.slice(4, 5) : undefined,
    });
    if (!move) throw new Error(`test fixture: ${uci} is illegal`);
    return {
      id: index + 1,
      playedBy: index % 2 === 0 ? whiteSeat : blackSeat,
      moveUci: uci,
      moveSan: move.san,
      fenAfter: chess.fen(),
    };
  });
}

/**
 * An in-memory database with a REAL row lock: `run` chains every transaction, so
 * two concurrent turns serialize exactly as `SELECT … FOR UPDATE` serializes
 * them. That is what makes the duplicate-move tests meaningful.
 */
function memoryDb({ game, moves = [] }) {
  const rows = moves.map((row) => ({ ...row }));
  let nextId = rows.length > 0 ? Math.max(...rows.map((r) => r.id)) + 1 : 1;
  let chain = Promise.resolve();
  const appends = [];
  const finishes = [];
  const state = { status: game.status, winnerId: null, result: null };

  const tx = {
    lockGame: async () => ({ ...game, status: state.status }),
    loadMoves: async () => rows.map((row) => ({ ...row })),
    appendMove: async (move) => {
      const row = { id: nextId++, ...move };
      rows.push(row);
      appends.push(row);
    },
    finishGame: async ({ winnerId, result }) => {
      state.status = "finished";
      state.winnerId = winnerId;
      state.result = result;
      finishes.push({ winnerId, result, appendsSoFar: appends.length });
    },
  };

  return {
    reader: {
      loadGame: async () => ({ ...game, status: state.status }),
      loadMoves: async () => rows.map((row) => ({ ...row })),
    },
    store: {
      run: (fn) => {
        const next = chain.then(() => fn(tx));
        chain = next.then(
          () => {},
          () => {},
        );
        return next;
      },
    },
    appends,
    finishes,
    rows: () => rows.map((row) => ({ ...row })),
    state,
  };
}

const humanMatches = (id) => id === HUMAN;
const neverCalledEngine = async () => {
  throw new Error("the engine must not be reached in this case");
};

// ════════════════════════════════════════════════════════════════════
// 1. The request body carries a game id and nothing else
// ════════════════════════════════════════════════════════════════════

test("only a uuid game id is read from the body — everything else is ignored", () => {
  assert.deepEqual(parseAiTurnRequest({ gameId: UUID }), { ok: true, gameId: UUID });

  for (const bad of [undefined, null, {}, { gameId: "nope" }, { gameId: 42 }, []]) {
    assert.equal(parseAiTurnRequest(bad).ok, false, `${JSON.stringify(bad)} must be refused`);
  }

  // A body stuffed with everything a client might try to decide for itself,
  // alongside a valid game id, resolves to THAT GAME ID and nothing else.
  const smuggled = parseAiTurnRequest({
    gameId: UUID,
    fen: "8/8/8/8/8/8/8/K6k w - - 0 1",
    move: "a1a8",
    difficulty: "hard",
    playerId: "user_attacker",
    turn: "b",
    isAiGame: false,
  });
  assert.deepEqual(smuggled, { ok: true, gameId: UUID });
});

// ════════════════════════════════════════════════════════════════════
// 2. Who may advance the game, and which games may be advanced
// ════════════════════════════════════════════════════════════════════

test("a caller who holds neither seat is refused and learns nothing", () => {
  const assessed = assessAiTurn({
    game: gameRow("white"),
    moves: playedMoves(["e2e4"]),
    humanMatches: (id) => id === "user_someone_else",
  });
  assert.equal(assessed.ok, false);
  assert.equal(assessed.reason, "not_a_seat");
  assert.equal(assessed.state, null, "a non-seat must not receive game state");
});

test("a PvP game can never be advanced by this endpoint", async () => {
  const pvp = gameRow("white", {
    isAiGame: false,
    playerWhiteId: HUMAN,
    playerBlackId: "user_opponent",
    aiDifficulty: null,
  });
  const db = memoryDb({ game: pvp, moves: playedMoves(["e2e4"]) });

  const result = await advanceAiTurn(
    { gameId: UUID, humanMatches },
    { reader: db.reader, store: db.store, chooseMove: neverCalledEngine },
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.reason, "not_ai_game");
  assert.equal(db.appends.length, 0);
  assert.equal(db.state.status, "in_progress", "a PvP row is untouched");
});

test("a finished or expired row is refused without any write", async () => {
  for (const status of ["finished", "expired", "waiting"]) {
    const db = memoryDb({ game: gameRow("white", { status }), moves: playedMoves(["e2e4"]) });
    const result = await advanceAiTurn(
      { gameId: UUID, humanMatches },
      { reader: db.reader, store: db.store, chooseMove: neverCalledEngine },
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.equal(result.reason, "not_active");
    assert.equal(db.appends.length, 0);
  }
});

test("a request that arrives on the human's turn is refused (the retry case)", async () => {
  // Human is White, both plies are in: 1.e4 e5 was played and the turn is back
  // with the human. This is exactly the state a retry finds AFTER a successful
  // turn, and it must never append a second AI move.
  const db = memoryDb({ game: gameRow("white"), moves: playedMoves(["e2e4", "e7e5"]) });
  const result = await advanceAiTurn(
    { gameId: UUID, humanMatches },
    { reader: db.reader, store: db.store, chooseMove: neverCalledEngine },
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.reason, "not_ai_turn");
  assert.equal(db.appends.length, 0);
  assert.equal(result.state.turn, "white", "the snapshot says whose turn it really is");
});

// ════════════════════════════════════════════════════════════════════
// 3. The turn itself — both colours, every tier
// ════════════════════════════════════════════════════════════════════

test("a valid human move is followed by a server-generated, legal AI move", async () => {
  // The human (White) played 1.e4; the row holds that ply.
  const db = memoryDb({ game: gameRow("white"), moves: playedMoves(["e2e4"]) });
  const result = await advanceAiTurn(
    { gameId: UUID, humanMatches },
    { reader: db.reader, store: db.store, chooseMove: async () => ({ uci: "e7e5" }) },
  );

  assert.equal(result.ok, true);
  assert.equal(result.data.outcome, "moved");
  assert.equal(result.data.status, "in_progress", "the row is still open");
  assert.deepEqual(result.data.aiMove, {
    san: "e5",
    uci: "e7e5",
    from: "e7",
    to: "e5",
    promotion: null,
  });

  // Exactly one row, written as the BOT's, and the position it stores is the
  // position that actually results from the engine's move.
  assert.equal(db.appends.length, 1);
  const [appended] = db.appends;
  assert.equal(appended.playedBy, CHESS_AI_PLAYER_ID);
  assert.equal(appended.moveUci, "e7e5");
  assert.equal(appended.moveSan, "e5");
  assert.equal(
    appended.fenAfter,
    "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
  );
  assert.equal(result.data.fen, appended.fenAfter);
  assert.equal(result.data.turn, "white", "the turn is back with the human");
  assert.equal(result.data.moveCount, 2);
  assert.equal(result.data.isGameOver, false);
  assert.equal(result.data.humanColor, "white");
  assert.equal(result.data.aiColor, "black");
});

test("the bot opens the game when the human plays Black", async () => {
  // No moves yet: the human holds Black, so White — the bot — moves first.
  const db = memoryDb({ game: gameRow("black") });
  const result = await advanceAiTurn(
    { gameId: UUID, humanMatches },
    { reader: db.reader, store: db.store, chooseMove: async () => ({ uci: "d2d4" }) },
  );

  assert.equal(result.ok, true);
  assert.equal(db.appends.length, 1);
  assert.equal(db.appends[0].playedBy, CHESS_AI_PLAYER_ID);
  assert.equal(db.appends[0].moveUci, "d2d4");
  assert.equal(result.data.humanColor, "black");
  assert.equal(result.data.aiColor, "white");
  assert.equal(result.data.turn, "black", "the human is to move after White's first move");
});

test("each stored difficulty is the one the search runs at", async () => {
  for (const tier of ["easy", "medium", "hard"]) {
    const calls = [];
    const db = memoryDb({ game: gameRow("white", { aiDifficulty: tier }), moves: playedMoves(["e2e4"]) });
    const result = await advanceAiTurn(
      { gameId: UUID, humanMatches },
      {
        reader: db.reader,
        store: db.store,
        chooseMove: async (search) => {
          calls.push(search);
          return { uci: "g8f6" };
        },
      },
    );

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].difficulty, tier, "the ROW's tier is what the search gets");
    assert.equal(result.data.difficulty, tier);
    // The search position is the persisted one, not anything from the caller.
    assert.equal(calls[0].fen, db.rows()[0].fenAfter);
  }
});

test("a legacy row with no stored tier plays at the documented default", async () => {
  const calls = [];
  const db = memoryDb({
    game: gameRow("white", { aiDifficulty: null }),
    moves: playedMoves(["e2e4"]),
  });
  await advanceAiTurn(
    { gameId: UUID, humanMatches },
    {
      reader: db.reader,
      store: db.store,
      chooseMove: async (search) => {
        calls.push(search);
        return { uci: "e7e5" };
      },
    },
  );
  assert.equal(calls[0].difficulty, "medium");
});

test("END TO END with the real Stockfish chooser", async () => {
  // The strongest available evidence: the default (non-injected) engine produces
  // and persists a legal move from the PERSISTED history alone.
  const db = memoryDb({ game: gameRow("white", { aiDifficulty: "easy" }), moves: playedMoves(["e2e4"]) });
  const result = await advanceAiTurn({ gameId: UUID, humanMatches }, { reader: db.reader, store: db.store });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(db.appends.length, 1);

  // The stored move is legal in the position it was played in, and the stored
  // FEN is the position after it.
  const [appended] = db.appends;
  const replay = new Chess(db.rows()[0].fenAfter);
  const played = replay.move({
    from: appended.moveUci.slice(0, 2),
    to: appended.moveUci.slice(2, 4),
    promotion: appended.moveUci.length > 4 ? appended.moveUci.slice(4, 5) : undefined,
  });
  assert.ok(played, "the AI's stored move must be legal in the stored position");
  assert.equal(replay.fen(), appended.fenAfter);
  assert.equal(result.data.aiMove.uci, appended.moveUci);
});

// ════════════════════════════════════════════════════════════════════
// 4. Concurrency, retries and duplicates
// ════════════════════════════════════════════════════════════════════

test("concurrent requests for the same turn produce exactly ONE AI move", async () => {
  const db = memoryDb({ game: gameRow("white"), moves: playedMoves(["e2e4"]) });
  const engine = async () => ({ uci: "e7e5" });

  const results = await Promise.all([
    advanceAiTurn({ gameId: UUID, humanMatches }, { reader: db.reader, store: db.store, chooseMove: engine }),
    advanceAiTurn({ gameId: UUID, humanMatches }, { reader: db.reader, store: db.store, chooseMove: engine }),
    advanceAiTurn({ gameId: UUID, humanMatches }, { reader: db.reader, store: db.store, chooseMove: engine }),
  ]);

  assert.equal(db.appends.length, 1, "only one AI move may be persisted");
  assert.equal(results.filter((r) => r.ok).length, 1, "exactly one caller may win");

  const losers = results.filter((r) => !r.ok);
  assert.equal(losers.length, 2);
  for (const loser of losers) {
    assert.equal(loser.status, 409);
    assert.ok(
      ["stale", "not_ai_turn"].includes(loser.reason),
      `a loser must be refused for a race reason, got ${loser.reason}`,
    );
  }
});

test("a sequential retry after success is refused, not appended twice", async () => {
  const db = memoryDb({ game: gameRow("white"), moves: playedMoves(["e2e4"]) });
  const engine = async () => ({ uci: "e7e5" });

  const first = await advanceAiTurn(
    { gameId: UUID, humanMatches },
    { reader: db.reader, store: db.store, chooseMove: engine },
  );
  const second = await advanceAiTurn(
    { gameId: UUID, humanMatches },
    { reader: db.reader, store: db.store, chooseMove: engine },
  );

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.status, 409);
  assert.equal(second.reason, "not_ai_turn");
  assert.equal(db.appends.length, 1);
  assert.equal(second.state.moveCount, 2);
});

test("a stale optimistic token is refused even when it IS the bot's turn", async () => {
  // Something was appended after the caller assessed the game: the claim must
  // back off rather than write a move for a position that no longer exists.
  const game = gameRow("white");
  const moves = playedMoves(["e2e4"]);

  const db = {
    reader: {
      // The read the caller assesses against…
      loadGame: async () => game,
      loadMoves: async () => moves.map((row) => ({ ...row })),
    },
    store: {
      // …and a lock that sees an EXTRA ply nobody assessed.
      run: (fn) =>
        fn({
          lockGame: async () => game,
          loadMoves: async () => [...moves.map((row) => ({ ...row })), { id: 99, playedBy: HUMAN, moveUci: "g1f3", moveSan: "Nf3", fenAfter: moves[0].fenAfter }],
          appendMove: async () => {
            throw new Error("must not append");
          },
          finishGame: async () => {
            throw new Error("must not finish");
          },
        }),
    },
  };

  const result = await advanceAiTurn(
    { gameId: UUID, humanMatches },
    { reader: db.reader, store: db.store, chooseMove: async () => ({ uci: "e7e5" }) },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "stale");
  assert.equal(result.status, 409);
});

test("an engine move that is illegal in the authoritative position is never stored", async () => {
  const db = memoryDb({ game: gameRow("white"), moves: playedMoves(["e2e4"]) });
  const result = await advanceAiTurn(
    { gameId: UUID, humanMatches },
    // "e7e6" is legal, "a1a8" is not — the search result is not trusted.
    { reader: db.reader, store: db.store, chooseMove: async () => ({ uci: "a1a8" }) },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_move");
  assert.equal(result.status, 409);
  assert.equal(db.appends.length, 0);
});

// ════════════════════════════════════════════════════════════════════
// 5. Engine failure and recovery
// ════════════════════════════════════════════════════════════════════

test("an engine failure writes nothing and is retryable in place", async () => {
  const db = memoryDb({ game: gameRow("white"), moves: playedMoves(["e2e4"]) });

  const failed = await advanceAiTurn(
    { gameId: UUID, humanMatches },
    {
      reader: db.reader,
      store: db.store,
      chooseMove: async () => {
        throw new ChessGameplayEngineError("the engine could not produce a move: boom");
      },
    },
  );

  assert.equal(failed.ok, false);
  assert.equal(failed.status, 503);
  assert.equal(failed.reason, "engine_failed");
  assert.equal(db.appends.length, 0, "a failed search must not write a move");
  assert.equal(db.state.status, "in_progress", "the game stays exactly as it was");
  assert.equal(failed.state.turn, "black", "the snapshot still says it is the bot's turn");

  // …and the SAME turn can then be played: nothing was consumed.
  const recovered = await advanceAiTurn(
    { gameId: UUID, humanMatches },
    { reader: db.reader, store: db.store, chooseMove: async () => ({ uci: "e7e5" }) },
  );
  assert.equal(recovered.ok, true);
  assert.equal(db.appends.length, 1);
});

test("a non-engine error is not swallowed as a retryable failure", async () => {
  const db = memoryDb({ game: gameRow("white"), moves: playedMoves(["e2e4"]) });
  await assert.rejects(
    () =>
      advanceAiTurn(
        { gameId: UUID, humanMatches },
        {
          reader: db.reader,
          store: db.store,
          chooseMove: async () => {
            throw new TypeError("a bug, not an engine failure");
          },
        },
      ),
    TypeError,
  );
  assert.equal(db.appends.length, 0);
});

// ════════════════════════════════════════════════════════════════════
// 6. Terminal positions
// ════════════════════════════════════════════════════════════════════

test("an AI move that mates the human finishes the game in the same transaction", async () => {
  // Fool's mate: the human (White) has just played 1.f3 e5 2.g4, and the bot
  // (Black) plays …Qh4#.
  const moves = playedMoves(["f2f3", "e7e5", "g2g4"], "white");
  const db = memoryDb({ game: gameRow("white"), moves });

  const result = await advanceAiTurn(
    { gameId: UUID, humanMatches },
    { reader: db.reader, store: db.store, chooseMove: async () => ({ uci: "d8h4" }) },
  );

  assert.equal(result.ok, true);
  assert.equal(result.data.outcome, "finished");
  assert.equal(result.data.status, "finished");
  assert.equal(result.data.isGameOver, true);
  assert.equal(result.data.aiMove.san, "Qh4#");

  assert.equal(db.appends.length, 1);
  assert.equal(db.finishes.length, 1);
  assert.equal(db.finishes[0].winnerId, CHESS_AI_PLAYER_ID, "the bot delivered it");
  assert.equal(db.finishes[0].result, "win");
  assert.equal(db.finishes[0].appendsSoFar, 1, "the finish runs in the same transaction as the move");
  assert.equal(result.data.winnerId, CHESS_AI_PLAYER_ID);
  assert.equal(result.data.result, "win");
});

test("a drawing AI move finishes the game as a draw with no winner", async () => {
  // A stalemate the bot walks into: the human (Black) has just played …Kh8, and
  // the bot (White) plays Qg6, leaving the black king with no legal move and no
  // check.
  const fen = "7k/5Q2/8/8/8/8/6K1/8 w - - 0 1";
  const moves = [
    { id: 1, playedBy: HUMAN, moveUci: "h7h8", moveSan: "Kh8", fenAfter: fen },
  ];
  const db = memoryDb({ game: gameRow("black"), moves });

  const result = await advanceAiTurn(
    { gameId: UUID, humanMatches },
    // Qg6 is the only legal move (the f7 queen would be captured otherwise) and
    // it stalemates Black — the bot itself creates the draw.
    { reader: db.reader, store: db.store, chooseMove: async () => ({ uci: "f7g6" }) },
  );

  assert.equal(result.ok, true);
  assert.equal(result.data.outcome, "finished");
  assert.equal(result.data.isGameOver, true);
  assert.equal(result.data.status, "finished");
  assert.equal(result.data.winnerId, null);
  assert.equal(result.data.result, "draw");
  assert.equal(db.finishes.length, 1);
  assert.equal(db.finishes[0].winnerId, null);
});

test("an open row whose position is already over is repaired, with no invented move", async () => {
  // The human's mating move was persisted (by /api/chess/move) but the row is
  // still open — the finish never ran. The endpoint records it and writes
  // nothing else.
  const moves = playedMoves(["f2f3", "e7e5", "g2g4", "d8h4"], "black");
  const db = memoryDb({ game: gameRow("black"), moves });

  const result = await advanceAiTurn(
    { gameId: UUID, humanMatches },
    { reader: db.reader, store: db.store, chooseMove: neverCalledEngine },
  );

  assert.equal(result.ok, true);
  assert.equal(result.data.outcome, "repaired");
  assert.equal(result.data.aiMove, null);
  assert.equal(db.appends.length, 0, "no move is fabricated for a finished game");
  assert.equal(db.finishes.length, 1);
  assert.equal(db.finishes[0].winnerId, HUMAN, "the human delivered it");
  assert.equal(db.finishes[0].result, "win");
});

test("terminal classification names the seat that owns the result", () => {
  const seats = chessSeatsForHumanColor(HUMAN, "black");
  // White mated (Black delivered it) → the BLACK seat wins.
  const mateOnWhite = new Chess("rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3");
  assert.deepEqual(terminalResultFor(mateOnWhite, seats), {
    winnerId: seats.playerBlackId,
    result: "win",
  });

  const stalemate = new Chess("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1");
  assert.deepEqual(terminalResultFor(stalemate, seats), { winnerId: null, result: "draw" });

  const bareKings = new Chess("8/8/4k3/8/8/4K3/8/8 w - - 0 1");
  assert.deepEqual(terminalResultFor(bareKings, seats), { winnerId: null, result: "draw" });
});

// ════════════════════════════════════════════════════════════════════
// 7. The stored history, and the evaluation pipeline
// ════════════════════════════════════════════════════════════════════

test("the persisted history is exactly what the evaluation pipeline reads", async () => {
  // The human plays Black, so the bot (White) owns the ODD plies: four plies are
  // already persisted (…Bb5 will be the fifth) and it is the bot's turn.
  const db = memoryDb({
    game: gameRow("black"),
    moves: playedMoves(["e2e4", "e7e5", "g1f3", "b8c6"], "black"),
  });
  const result = await advanceAiTurn(
    { gameId: UUID, humanMatches },
    { reader: db.reader, store: db.store, chooseMove: async () => ({ uci: "f1b5" }) },
  );
  assert.equal(result.ok, true);

  const history = db.rows();
  assert.equal(history.length, 5);
  assert.ok(history.length >= MIN_EVALUABLE_PLIES, "the game is now analysable");

  for (const row of history) {
    // The evaluator compares `move_uci` byte-for-byte against Stockfish's own
    // `bestmove`, so the stored encoding must be UCI — no stray promotion
    // suffix, no SAN.
    assert.match(row.moveUci, /^[a-h][1-8][a-h][1-8][qrbn]?$/, row.moveUci);
    assert.ok(row.moveSan.length > 0);
    assert.ok(row.fenAfter.startsWith("rnbqkbnr") || row.fenAfter.includes("/"));
  }

  // Every ply is attributed to a seat of the game, and the AI's are the bot's —
  // never the human's, and never the human's submitted as the bot's.
  for (const row of history) {
    assert.ok(
      [CHESS_AI_PLAYER_ID, HUMAN].includes(row.playedBy),
      `unexpected playedBy ${row.playedBy}`,
    );
  }
  assert.equal(history[4].playedBy, CHESS_AI_PLAYER_ID, "the 5th ply is the bot's");
  assert.equal(history[3].playedBy, HUMAN, "the human's plies stay the human's");
  assert.equal(history[2].playedBy, CHESS_AI_PLAYER_ID);

  // The stored FENs form ONE legal game, which is what the evaluator replays.
  const replay = new Chess();
  for (const row of history) {
    const played = replay.move({
      from: row.moveUci.slice(0, 2),
      to: row.moveUci.slice(2, 4),
      promotion: row.moveUci.length > 4 ? row.moveUci.slice(4, 5) : undefined,
    });
    assert.ok(played, `ply ${row.id} must be legal`);
    assert.equal(replay.fen(), row.fenAfter, `ply ${row.id} must store its own position`);
    assert.equal(played.san, row.moveSan);
  }
  assert.equal(replay.fen(), result.data.fen);
});

test("the engine's answer is what gets stored — the client's is never consulted", async () => {
  const db = memoryDb({ game: gameRow("white"), moves: playedMoves(["e2e4"]) });
  // The injected engine returns one move; nothing in the request can change it,
  // because the request carries no move at all.
  const result = await advanceAiTurn(
    { gameId: UUID, humanMatches },
    { reader: db.reader, store: db.store, chooseMove: async () => ({ uci: "c7c5" }) },
  );
  assert.equal(result.ok, true);
  assert.equal(db.rows()[1].moveUci, "c7c5");
  assert.equal(result.data.aiMove.uci, "c7c5");
});

test("positionAfter rebuilds from the persisted history, and refuses junk", () => {
  assert.equal(positionAfter([]).fen(), START_FEN);
  const moves = playedMoves(["e2e4"]);
  assert.equal(positionAfter(moves).fen(), moves[0].fenAfter);

  assert.throws(
    () => positionAfter([{ id: 1, playedBy: HUMAN, moveUci: "e2e4", moveSan: "e4", fenAfter: "not-a-fen" }]),
    /unusable position/,
  );
});

// ════════════════════════════════════════════════════════════════════
// 8. The route wires it safely, and PvP is untouched
// ════════════════════════════════════════════════════════════════════

test("the route is a thin shell over the tested turn logic", () => {
  assert.match(AI_MOVE_ROUTE, /import \{\s*advanceAiTurn,\s*parseAiTurnRequest,\s*\} from "\.\.\/\.\.\/\.\.\/\.\.\/lib\/chessAiTurn";/);
  assert.match(AI_MOVE_ROUTE, /const parsed = parseAiTurnRequest\(body\);/);
  assert.match(AI_MOVE_ROUTE, /await advanceAiTurn\(/);
  assert.match(AI_MOVE_ROUTE, /\{ gameId, humanMatches: \(id\) => userAliases\.has\(id\) \}/);
  // Nothing from the body is passed on.
  assert.ok(!/body\.(fen|move|difficulty|playerId|turn)/.test(AI_MOVE_ROUTE));
  assert.match(AI_MOVE_ROUTE, /import \{ requirePracticePlayer \}/);
});

test("the atomic claim is a transaction with a row lock", () => {
  assert.match(AI_MOVE_ROUTE, /db\.transaction\(async \(tx\) =>/);
  assert.match(AI_MOVE_ROUTE, /\.for\("update"\)/);
  // The lock is taken inside the claim, and the move is applied to the position
  // re-read under it.
  assert.match(AI_LIB, /const game = await tx\.lockGame\(\);/);
  assert.match(AI_LIB, /await tx\.appendMove\(/);
  assert.match(AI_LIB, /await tx\.finishGame\(/);
});

test("the AI turn awards no rating, trophies or counters, and never moves a PvP game", () => {
  for (const forbidden of [
    "applyRatingResult",
    "applyTrophyResult",
    "applyLeaderboardCounters",
    "applyLeaderboard",
  ]) {
    assert.ok(
      !AI_MOVE_ROUTE.includes(forbidden) && !AI_LIB.includes(forbidden),
      `${forbidden} must not be reached from an AI turn`,
    );
  }
  // The game must be an AI game before anything else can happen.
  assert.match(AI_LIB, /if \(!game\.isAiGame\) return \{ ok: false, reason: "not_ai_game", state: null \};/);
});

test("the human move route and its authorization are unchanged", () => {
  // The AI turn is triggered by the EXISTING route: the seats still authorize,
  // and the mover is still the authenticated caller.
  assert.match(MOVE_ROUTE, /const isWhitePlayer = userAliases\.has\(String\(game\.playerWhiteId\)\)/);
  assert.match(MOVE_ROUTE, /const isBlackPlayer = userAliases\.has\(String\(game\.playerBlackId\)\)/);
  assert.match(MOVE_ROUTE, /if \(!isWhitePlayer && !isBlackPlayer\) \{/);
  assert.match(MOVE_ROUTE, /playedBy: userId,/);
  // AI games still never move Elo or trophies on a played finish.
  assert.match(MOVE_ROUTE, /if \(!isDraw && !lockedGame\.isAiGame && winnerId\) \{/);
});

test("ending an AI game still expires it and never fabricates a finish", () => {
  assert.match(END_GAME_ROUTE, /inArray\(chessGames\.status, \["waiting", "active", "in_progress"\]\)/);
  assert.match(
    END_GAME_ROUTE,
    /if \(lockedGame\.isAiGame\) \{\s*await tx[\s\S]{0,200}\{ status: "expired", endedAt: new Date\(\) \}/,
  );
  // A row the server already closed is not even selected, so a finished result
  // cannot be overwritten by the abandonment path.
  assert.ok(
    END_GAME_ROUTE.indexOf("openGame.length === 0") < END_GAME_ROUTE.indexOf("if (lockedGame.isAiGame)"),
    "the status filter must run before the AI branch",
  );
  assert.equal(AI_TURN_REFUSALS.not_a_seat.status, 404, "a non-seat cannot probe for games");
});
