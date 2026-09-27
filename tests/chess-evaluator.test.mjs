/**
 * Chess objective evaluator (src/lib/evaluation/games/chessEvaluator.ts).
 *
 * The evaluator is the "no hallucination" half of the Game Evaluation feature:
 * every number it returns must come from the stored move history plus a real
 * Stockfish search, never from a model. So this file has to pin three things:
 *
 *   1. The PUBLISHED maths. Accuracy is Lichess's centipawn → Win% curve and
 *      their per-move accuracy formula; the thresholds are the standard
 *      >100 cp = blunder / 50–100 cp = mistake bands. If a constant drifts, the
 *      reported accuracy silently becomes a different (and unverifiable) number.
 *   2. The SANITY of a real game's output. The fixture is Légal's mate — the
 *      oldest trap in chess, where 5...Bxd1 is objectively losing to mate. A
 *      position evaluator that does not call that a blunder, or that gets the
 *      sign of the evaluation backwards, fails here.
 *   3. The INSUFFICIENT-DATA contract. A game that is too short or whose move
 *      history does not replay must come back flagged, with no stats invented.
 *
 * The engine assertions run a real WASM Stockfish in-process (see
 * src/lib/evaluation/engine/stockfishEngine.ts) — ~14 searches, a few seconds.
 *
 * Run: npm run test:chess-evaluator
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";

import { Chess } from "chess.js";

import {
  BLUNDER_CP,
  MATE_CP,
  MISTAKE_CP,
  MIN_EVALUABLE_MOVES,
  analyzeChessGame,
  classifyMove,
  evaluateChessMatch,
  moveAccuracyPercent,
  winPercent,
} from "../src/lib/evaluation/games/chessEvaluator.ts";
import { disposeChessEngine } from "../src/lib/evaluation/engine/stockfishEngine.ts";

// The engine is one shared, stateful WASM instance; release it so the test
// process can exit on its own.
after(async () => {
  await disposeChessEngine();
});

const WHITE = "user_white";
const BLACK = "user_black";

// Légal's mate: 5.Nxe5!! offers the queen, and 5...Bxd1?? walks into mate.
// Every move after that is forced — Black cannot avoid 7.Nd5#.
const LEGAL_MATE_SANS = [
  "e4",
  "e5",
  "Nf3",
  "Nc6",
  "Bc4",
  "d6",
  "Nc3",
  "Bg4",
  "Nxe5",
  "Bxd1",
  "Bxf7+",
  "Ke7",
  "Nd5#",
];

const GAP_MS = 3000;

/**
 * Builds the evaluator's input from SAN moves, replaying them with chess.js so
 * the FENs and the legality of the fixture are guaranteed rather than typed
 * out by hand.
 */
function buildInput(sans, { timestamps = true } = {}) {
  const chess = new Chess();
  const startMs = Date.UTC(2026, 0, 1, 12, 0, 0);
  const moves = sans.map((san, index) => {
    const played = chess.move(san);
    if (!played) throw new Error(`fixture move "${san}" is illegal`);
    return {
      san: played.san,
      uci: `${played.from}${played.to}${played.promotion || ""}`,
      fenAfter: chess.fen(),
      playedBy: index % 2 === 0 ? WHITE : BLACK,
      createdAtIso: timestamps
        ? new Date(startMs + GAP_MS * (index + 1)).toISOString()
        : null,
    };
  });

  return {
    gameId: "fixture-game",
    playerWhiteId: WHITE,
    playerBlackId: BLACK,
    startedAtIso: timestamps ? new Date(startMs).toISOString() : null,
    createdAtIso: timestamps ? new Date(startMs).toISOString() : null,
    moves,
  };
}

/** The ply (1-based) at which Black plays a given SAN. */
function plyOfSan(sans, san) {
  return sans.indexOf(san) + 1;
}

// ════════════════════════════════════════════════════════════════════
// 1. The published maths + thresholds
// ════════════════════════════════════════════════════════════════════

test("accuracy maths is Lichess's published formula, not a local approximation", () => {
  // Win% = 50 + 50 * (2 / (1 + exp(-0.00368208 * cp)) - 1)
  assert.equal(winPercent(0), 50, "a dead-equal position is a coin flip");
  assert.ok(winPercent(100) > 50 && winPercent(100) < 100);
  assert.ok(winPercent(-100) < 50 && winPercent(-100) > 0);
  assert.ok(winPercent(1000) > winPercent(100), "the curve is monotonic");
  assert.ok(winPercent(-1000) < winPercent(-100), "and symmetric-ish either side");
  // The curve is anchored: ±1000 cp is not yet a certainty.
  assert.ok(winPercent(1000) < 100);
  assert.ok(winPercent(-1000) > 0);

  // Accuracy% = 103.1668 * exp(-0.04354 * (winBefore - winAfter)) - 3.1669
  const perfect = moveAccuracyPercent(50, 50);
  assert.ok(Math.abs(perfect - 100) < 0.001, "no win% lost must mean ~100%");
  assert.ok(
    moveAccuracyPercent(50, 0) < 15,
    "collapsing from level to lost scores near the floor (the formula bottoms out well above 0)",
  );
  assert.equal(
    moveAccuracyPercent(100, 0),
    0,
    "the published formula goes negative for a total collapse, so it must be clamped",
  );
  const mild = moveAccuracyPercent(50, 45);
  assert.ok(mild > 70 && mild < 100, `a small drop is still accurate (got ${mild})`);
  assert.ok(
    moveAccuracyPercent(50, 45) > moveAccuracyPercent(50, 10),
    "bigger drops must score lower",
  );
});

test("thresholds are the standard >100 blunder / 50-100 mistake bands", () => {
  assert.equal(BLUNDER_CP, 100);
  assert.equal(MISTAKE_CP, 50);
  assert.equal(classifyMove(0), "good");
  assert.equal(classifyMove(49), "good");
  assert.equal(classifyMove(50), "mistake", "50 cp is the mistake floor");
  assert.equal(classifyMove(100), "mistake", "100 cp is still a mistake, not a blunder");
  assert.equal(classifyMove(101), "blunder", "only MORE than 100 cp is a blunder");
  assert.equal(classifyMove(1200), "blunder");
});

// ════════════════════════════════════════════════════════════════════
// 2. Insufficient data — never fabricate
// ════════════════════════════════════════════════════════════════════

test("a game with too few moves is flagged, not analysed", async () => {
  // Resignation on move 1 (2 plies) — the case named in the spec.
  const short = await analyzeChessGame(buildInput(["e4", "c5"]));
  assert.equal(short.sufficient, false);
  assert.equal(short.reason, "too_few_moves");
  assert.equal(short.moveCount, 2);
  assert.match(short.detail, /at least 5/);
  assert.equal(short.moves, undefined, "no stats may be invented for a short game");
  assert.equal(short.players, undefined);

  // One ply short of the minimum is still refused.
  const boundary = await analyzeChessGame(
    buildInput(["e4", "e5", "Nf3", "Nc6"]),
  );
  assert.equal(boundary.sufficient, false);
  assert.equal(boundary.reason, "too_few_moves");
  assert.equal(MIN_EVALUABLE_MOVES, 5);
});

test("a move history that does not replay is refused", async () => {
  // Tamper with a stored FEN: everything downstream would be a lie.
  const tampered = buildInput(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"]);
  tampered.moves[2].fenAfter = tampered.moves[1].fenAfter;

  const result = await analyzeChessGame(tampered);
  assert.equal(result.sufficient, false);
  assert.equal(result.reason, "invalid_move_history");
  assert.match(result.detail, /does not lead to the position stored after it/);
});

test("an illegal stored SAN is refused rather than scored", async () => {
  const input = buildInput(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"]);
  input.moves[2].san = "Qxd8"; // legal in no universe from that position

  const result = await analyzeChessGame(input);
  assert.equal(result.sufficient, false);
  assert.equal(result.reason, "invalid_move_history");
  assert.match(result.detail, /is not legal in the stored position/);
});

test("a non-uuid game id short-circuits without touching the database", async () => {
  // `chess_games.id` is a uuid column: passing "not-a-game" through to Postgres
  // would raise a driver error instead of answering "no such game".
  for (const id of ["not-a-game", "   ", ""]) {
    const result = await evaluateChessMatch(id);
    assert.equal(result.sufficient, false);
    assert.equal(result.reason, "game_not_found");
  }
});

// ════════════════════════════════════════════════════════════════════
// 3. A real game, judged by a real engine
// ════════════════════════════════════════════════════════════════════

test("Légal's mate: the queen grab that loses to mate is a blunder and the key moment", async () => {
  const input = buildInput(LEGAL_MATE_SANS);
  const result = await analyzeChessGame(input, { depth: 10, moveTimeMs: 250 });

  assert.equal(result.sufficient, true, `expected an analysis, got ${result.reason}: ${result.detail}`);
  assert.equal(result.moveCount, LEGAL_MATE_SANS.length);
  assert.equal(result.moves.length, LEGAL_MATE_SANS.length);

  // Which engine judged it — the audit trail behind every number below.
  assert.match(result.engine.id, /Stockfish/i);
  assert.equal(result.engine.depth, 10);
  assert.equal(result.engine.moveTimeMs, 250);

  // ── The eval curve is sane ─────────────────────────────────────────
  for (const move of result.moves) {
    assert.ok(Number.isInteger(move.evalBeforeCp), "evals are integer centipawns");
    assert.ok(Number.isInteger(move.evalAfterCp));
    assert.ok(move.cpLoss >= 0, "a move can never be credited with a gain");
    assert.equal(move.thinkTimeMs, GAP_MS, "one 3s gap between consecutive moves");
  }
  // White is not winning in the opening...
  assert.ok(Math.abs(result.moves[0].evalBeforeCp) < 100, "the start position is level");
  // ...but is mating at the end: mate is folded to +MATE_CP for the mating side.
  const final = result.moves[result.moves.length - 1];
  assert.ok(
    final.evalAfterCp >= MATE_CP - 1000,
    `the final position must read as won for White (got ${final.evalAfterCp})`,
  );

  // ── The blunder ────────────────────────────────────────────────────
  const blunderPly = plyOfSan(LEGAL_MATE_SANS, "Bxd1");
  const blunder = result.moves.find((m) => m.ply === blunderPly);
  assert.ok(blunder, "the queen grab must be in the move list");
  assert.equal(blunder.san, "Bxd1");
  assert.equal(blunder.color, "black");
  assert.equal(blunder.playedBy, BLACK);
  assert.equal(blunder.moveNumber, 5, "5...Bxd1 is a fifth-move blunder");
  assert.ok(
    blunder.cpLoss > BLUNDER_CP,
    `taking the queen must lose more than ${BLUNDER_CP} cp (got ${blunder.cpLoss})`,
  );
  assert.equal(blunder.classification, "blunder");
  assert.ok(
    blunder.evalAfterCp > blunder.evalBeforeCp,
    "the evaluation must swing TOWARDS White after Black's blunder",
  );

  // ── Classification is consistent with the reported swings ──────────
  assert.ok(result.blunders.length >= 1);
  assert.ok(
    result.blunders.some((m) => m.ply === blunderPly),
    "the blunder must appear in the blunder list",
  );
  for (const move of result.blunders) {
    assert.ok(move.cpLoss > BLUNDER_CP, `${move.san} is listed as a blunder`);
    assert.equal(move.classification, "blunder");
  }
  for (const move of result.mistakes) {
    assert.ok(
      move.cpLoss >= MISTAKE_CP && move.cpLoss <= BLUNDER_CP,
      `${move.san} is listed as a mistake (${move.cpLoss} cp)`,
    );
    assert.equal(move.classification, "mistake");
  }
  assert.equal(result.thresholds.blunderCp, BLUNDER_CP);
  assert.equal(result.thresholds.mistakeCp, MISTAKE_CP);

  // ── Key moment = the single largest swing against the mover ────────
  assert.ok(result.keyMoment, "a game with a blunder has a key moment");
  assert.equal(result.keyMoment.ply, blunderPly);
  assert.equal(result.keyMoment.san, "Bxd1");
  assert.equal(result.keyMoment.color, "black");
  assert.equal(result.keyMoment.cpLoss, blunder.cpLoss);
  assert.equal(
    result.moves.filter((m) => m.isKeyMoment).length,
    1,
    "exactly one move may be flagged as the key moment",
  );
  const maxLoss = Math.max(...result.moves.map((m) => m.cpLoss));
  assert.equal(result.keyMoment.cpLoss, maxLoss, "it is the largest swing, not just a large one");

  // ── Accuracy + per-player stats ────────────────────────────────────
  const { white, black } = result.players;
  assert.equal(white.playedBy, WHITE);
  assert.equal(black.playedBy, BLACK);
  assert.equal(white.moveCount, 7, "White made 7 moves in this game");
  assert.equal(black.moveCount, 6);
  for (const player of [white, black]) {
    assert.ok(
      player.accuracyPercent >= 0 && player.accuracyPercent <= 100,
      `accuracy is a percentage (got ${player.accuracyPercent})`,
    );
    assert.ok(player.averageCpLoss >= 0);
    assert.equal(player.blunders, result.moves.filter((m) => m.color === player.color && m.classification === "blunder").length);
    assert.equal(player.mistakes, result.moves.filter((m) => m.color === player.color && m.classification === "mistake").length);
    // Timing comes from the stored timestamps: 6 gaps per side × 3s … minus
    // Black's, which has one gap fewer because White moved last.
    assert.equal(player.longestThinkMs, GAP_MS);
    assert.equal(player.averageThinkTimeMs, GAP_MS);
    assert.equal(player.totalThinkTimeMs, player.moveCount * GAP_MS);
  }
  assert.ok(black.blunders >= 1, "Black is the side that blundered");
  // NOTE: accuracy on its own does NOT identify the blunderer. It is derived
  // from WIN% loss, and once the queen is grabbed Black is already lost — the
  // forced moves that follow surrender almost none of the win% that was left,
  // so Black can post a HIGHER accuracy than the side that mated them (Lichess
  // documents this exact effect). The robust signal is per-move centipawn loss
  // next to the swing size, which is why the objective data reports accuracy,
  // averageCpLoss, the blunder list and the key moment rather than accuracy
  // alone.
  assert.ok(
    black.averageCpLoss > white.averageCpLoss,
    `the blundering side must lose more centipawns per move (black ${black.averageCpLoss} vs white ${white.averageCpLoss})`,
  );
  // The real blunder has to DWARF every other swing in the game. This is the
  // assertion that stays true regardless of search depth: a depth-limited
  // engine cannot see the Légal sac itself (verified — even at depth 14 it
  // prefers h2h3 and rates the position as level), so White's trap move can be
  // labelled a blunder by the same shallow search. That is a property of
  // depth-limited analysis, not of this pipeline, and it is exactly why the
  // engine's identity and depth are returned alongside the numbers.
  const otherLosses = result.moves
    .filter((move) => move.ply !== blunderPly)
    .map((move) => move.cpLoss);
  assert.ok(
    blunder.cpLoss > 10 * Math.max(...otherLosses),
    `the queen grab must dwarf every other swing (${blunder.cpLoss} cp vs next-worst ${Math.max(...otherLosses)} cp)`,
  );
  assert.ok(
    white.bestMoves + black.bestMoves >= 1,
    "at least one move must match the engine's own choice in a forced line",
  );
  assert.ok(result.analysisMs >= 0);
});

test("booting the engine does not leave the process without a global fetch", async () => {
  // Regression: the Emscripten glue runs a bare `fetch && (fetch = null)` at
  // boot, which nulls the GLOBAL fetch for the rest of the process. The route
  // that calls this engine then calls the LLM provider with `fetch`, so losing
  // it would fail every evaluation with "fetch is not a function" — and would
  // break any other route sharing the warm serverless instance.
  const before = globalThis.fetch;
  assert.equal(typeof before, "function", "the test environment must have fetch to begin with");

  // This has already booted the engine (and run searches) in earlier tests.
  const result = await analyzeChessGame(buildInput(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"]), {
    depth: 6,
    moveTimeMs: 120,
  });
  assert.equal(result.sufficient, true);

  assert.equal(
    globalThis.fetch,
    before,
    "the engine must not leave the global fetch nulled (stockfishEngine restores it)",
  );
  assert.equal(typeof globalThis.fetch, "function");
});

test("timing stats degrade to null, not NaN, when the history has no timestamps", async () => {
  const input = buildInput(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"], {
    timestamps: false,
  });
  const result = await analyzeChessGame(input, { depth: 8, moveTimeMs: 150 });

  assert.equal(result.sufficient, true, `expected an analysis, got ${result.reason}`);
  for (const move of result.moves) {
    assert.equal(move.thinkTimeMs, null);
  }
  for (const color of ["white", "black"]) {
    const player = result.players[color];
    assert.equal(player.totalThinkTimeMs, null);
    assert.equal(player.averageThinkTimeMs, null);
    assert.equal(player.longestThinkMs, null);
    // The absence of a clock must not take the accuracy maths down with it.
    assert.ok(Number.isFinite(player.accuracyPercent));
    assert.ok(Number.isFinite(player.averageCpLoss));
  }
});

test("a quiet, well-played opening produces no blunders", async () => {
  // 1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Ba4 Nf6 5.O-O Be7 — book moves only.
  const input = buildInput(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6", "O-O", "Be7"]);
  const result = await analyzeChessGame(input, { depth: 10, moveTimeMs: 250 });

  assert.equal(result.sufficient, true, `expected an analysis, got ${result.reason}`);
  assert.equal(result.blunders.length, 0, "no book move may be called a blunder");
  assert.ok(
    result.players.white.accuracyPercent > 80,
    `book play must score as accurate (got ${result.players.white.accuracyPercent})`,
  );
  assert.ok(
    result.players.black.accuracyPercent > 80,
    `book play must score as accurate (got ${result.players.black.accuracyPercent})`,
  );
});

// ════════════════════════════════════════════════════════════════════
// 4. Real-database run (opt-in)
// ════════════════════════════════════════════════════════════════════
//
// The fixture above is the deterministic guarantee. This test additionally runs
// the DB entry point against a REAL finished game, and is opt-in so the suite
// never hits a production database by accident:
//
//   CHESS_EVAL_TEST_GAME_ID=<uuid> npm run test:chess-evaluator
//
const realGameId = process.env.CHESS_EVAL_TEST_GAME_ID;

test(
  "evaluateChessMatch reads a real finished game from the database",
  { skip: realGameId ? false : "set CHESS_EVAL_TEST_GAME_ID to a chess_games.id" },
  async () => {
    const result = await evaluateChessMatch(realGameId, { depth: 10, moveTimeMs: 200 });
    assert.equal(result.sufficient, true, `expected an analysis, got ${result.reason}: ${result.detail}`);
    assert.equal(result.gameId, realGameId);
    assert.ok(result.moves.length >= MIN_EVALUABLE_MOVES);
    assert.equal(result.moves.length, result.plyCount);
    for (const move of result.moves) {
      assert.ok(Number.isInteger(move.evalAfterCp));
      assert.ok(move.cpLoss >= 0);
      assert.equal(typeof move.playedBy, "string");
      assert.ok(move.playedBy.length > 0);
    }
    // A real game must attribute its moves to the two real players.
    assert.notEqual(result.players.white.playedBy, "");
    assert.equal(result.players.white.color, "white");
    assert.equal(result.players.black.color, "black");
    console.log(
      "[chess-evaluator] real game",
      realGameId,
      JSON.stringify(
        {
          plies: result.plyCount,
          white: result.players.white,
          black: result.players.black,
          keyMoment: result.keyMoment,
          blunders: result.blunders.length,
          mistakes: result.mistakes.length,
        },
        null,
        2,
      ),
    );
  },
);
