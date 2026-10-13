/**
 * Chess VS-AI gameplay engine — the SERVER-side move chooser.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Stage 1 adds the interface that will generate the AI's move server-side. Every
 * guarantee it makes is checked here against the REAL Stockfish WASM engine,
 * because the interesting failures are engine failures: an answer that is not
 * legal in the position, a search that never returns, and — the subtle one —
 * a gameplay search's beginner `Skill Level` LEAKING into a later evaluation on
 * the same shared instance, which would produce a confidently wrong report.
 *
 * The difficulty claims are tested, not assumed from search duration (that was
 * an explicit decision): a shorter clock does NOT make a chess engine weak, so
 * the suite proves the two dials that do — the tier's search settings, and the
 * slip that lets a weaker tier take a worse ENGINE move — and measures the
 * CONSEQUENCE of a slip with a full-strength search of the resulting position.
 *
 * The deterministic cases inject the engine (`deps.analyze`) so boot failures,
 * timeouts, malformed responses and illegal output are all reachable without
 * having to break a real engine. One control case runs the same seam with valid
 * output, so those failure assertions are not vacuous.
 *
 * Run: npm run test:chess-gameplay-engine
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { Chess } from "chess.js";

import {
  ChessGameplayEngineError,
  MATE_SCORE_CP,
  candidateScore,
  chooseGameplayMove,
  parseUci,
  resolveMoveTimeMs,
} from "../src/lib/chessGameplayEngine.ts";
import {
  CHESS_AI_DIFFICULTIES,
  CHESS_AI_SEARCH_SETTINGS,
  DEFAULT_CHESS_AI_DIFFICULTY,
  MAX_CHESS_AI_DEPTH,
  MAX_CHESS_AI_MOVE_TIME_MS,
  MAX_CHESS_AI_SKILL_LEVEL,
  MIN_CHESS_AI_SKILL_LEVEL,
  chessAiDifficultyFromMatch,
  chessAiSlipRate,
  coerceChessAiDifficulty,
  isChessAiDifficulty,
  settingsForChessAiDifficulty,
} from "../src/lib/chessDifficulty.ts";
import {
  FULL_SKILL_LEVEL,
  MAX_ENGINE_DEPTH,
  MAX_ENGINE_MULTIPV,
  MAX_ENGINE_SKILL_LEVEL,
  MIN_ENGINE_MULTIPV,
  MIN_ENGINE_SKILL_LEVEL,
  analyzePosition,
  disposeChessEngine,
} from "../src/lib/evaluation/engine/stockfishEngine.ts";

// One shared, stateful WASM instance: release it so the process can exit.
after(async () => {
  await disposeChessEngine();
});

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/**
 * White Ke1/Rh1/Nb5/Ph2 vs Black Ke8/Qa8.
 *
 * `1.Nc7+` forks the king and the queen, so `2...K moves 3.Nxa8` wins a QUEEN —
 * and, unlike a bare rook (which would leave K+N vs K, a draw), the queen leaves
 * White with R+N+P vs K, which is decisively won. Stockfish reports it as roughly
 * +3500, while every other legal move is around 0, which is what makes the slip's
 * cost measurable.
 */
const QUEEN_FORK = "q3k3/8/8/1N6/8/8/7P/4K2R w K - 0 1";

/** A back-rank mate in one — every tier must find a legal move here. */
const MATE_IN_1 = "6k1/5ppp/8/8/8/8/5PPP/1R4K1 w - - 0 1";

/**
 * Black is checkmated (the position MATE_IN_1 becomes after `Rb8#`), so there
 * is nothing to choose. Verified with chess.js: `isCheckmate() === true` and
 * `moves().length === 0`.
 */
const CHECKMATE = "1R4k1/5ppp/8/8/8/8/5PPP/6K1 b - - 1 1";

/**
 * A draw with legal moves still available: the fifty-move counter is spent, so
 * `isGameOver()` is true while 20 moves exist. This is the second, distinct
 * fail-closed branch — "the position is over" is NOT the same as "no legal
 * moves", and a search here would be spent on a game that cannot continue.
 */
const DRAWN_WITH_MOVES = "6k1/5ppp/8/8/8/8/5PPP/1R4K1 w - - 100 60";

/** True when `uci` is a legal move in `fen`. Re-validated independently of the module. */
function isLegal(fen, uci) {
  const parsed = parseUci(uci);
  if (!parsed) return false;
  const chess = new Chess(fen);
  try {
    return Boolean(
      chess.move({
        from: parsed.from,
        to: parsed.to,
        promotion: parsed.promotion ?? undefined,
      }),
    );
  } catch {
    return false;
  }
}

/** Applies `uci` to `fen` and returns the resulting FEN, or null. */
function fenAfterUci(fen, uci) {
  const parsed = parseUci(uci);
  if (!parsed) return null;
  const chess = new Chess(fen);
  try {
    chess.move({
      from: parsed.from,
      to: parsed.to,
      promotion: parsed.promotion ?? undefined,
    });
  } catch {
    return null;
  }
  return chess.fen();
}

/**
 * WHITE's centipawns for a position, measured at FULL strength. Mate scores are
 * folded in, so "White is mating" compares sensibly with "White is +900".
 */
async function whiteCp(fen) {
  const score = await analyzePosition(fen, { depth: 10, moveTimeMs: 300 });
  const toMove = fen.split(/\s+/)[1] === "b" ? "b" : "w";
  const perspective = toMove === "w" ? 1 : -1;
  if (score.mate !== null) {
    const magnitude =
      score.mate === 0
        ? MATE_SCORE_CP
        : MATE_SCORE_CP - Math.min(Math.abs(score.mate), 50) * 100;
    const signed = score.mate === 0 ? -MATE_SCORE_CP : Math.sign(score.mate) * magnitude;
    return perspective * signed;
  }
  return perspective * (score.cp ?? 0);
}

// ════════════════════════════════════════════════════════════════════
// 1. The difficulty vocabulary and what each tier resolves to
// ════════════════════════════════════════════════════════════════════

test("the three shipped tiers are the only canonical values", () => {
  assert.deepEqual([...CHESS_AI_DIFFICULTIES], ["easy", "medium", "hard"]);
  for (const tier of CHESS_AI_DIFFICULTIES) {
    assert.ok(isChessAiDifficulty(tier));
  }
  // The shared scale's `normal` is chess's `medium`, so it is NOT a chess value.
  assert.equal(isChessAiDifficulty("normal"), false);
  assert.equal(isChessAiDifficulty("MEDIUM"), false);
  assert.equal(isChessAiDifficulty(3), false);
  assert.equal(isChessAiDifficulty(undefined), false);
});

test("stronger tiers search stronger — and every tier stays inside the engine's bounds", () => {
  const easy = settingsForChessAiDifficulty("easy");
  const medium = settingsForChessAiDifficulty("medium");
  const hard = settingsForChessAiDifficulty("hard");

  // The primary dial, strictly ordered. Easy is the engine's own floor; hard is
  // full strength, so nothing can be stronger than it.
  assert.equal(easy.skillLevel, MIN_CHESS_AI_SKILL_LEVEL);
  assert.equal(hard.skillLevel, FULL_SKILL_LEVEL);
  assert.ok(
    easy.skillLevel < medium.skillLevel && medium.skillLevel < hard.skillLevel,
    `skill levels must increase with the tier: ${easy.skillLevel}/${medium.skillLevel}/${hard.skillLevel}`,
  );

  // The budget is a CEILING, never the difficulty dial: no tier may exceed the
  // approved 500 ms, and every tier must be a positive search.
  for (const tier of CHESS_AI_DIFFICULTIES) {
    const s = CHESS_AI_SEARCH_SETTINGS[tier];
    assert.ok(s.moveTimeMs > 0 && s.moveTimeMs <= MAX_CHESS_AI_MOVE_TIME_MS, `${tier} budget`);
    assert.ok(s.depth >= 1 && s.depth <= MAX_CHESS_AI_DEPTH, `${tier} depth`);
    assert.ok(
      s.skillLevel >= MIN_ENGINE_SKILL_LEVEL && s.skillLevel <= MAX_ENGINE_SKILL_LEVEL,
      `${tier} skill level must be inside the engine's clamp`,
    );
    assert.ok(
      s.multiPv >= MIN_ENGINE_MULTIPV && s.multiPv <= MAX_ENGINE_MULTIPV,
      `${tier} multiPv must be inside the engine's clamp`,
    );
  }

  // The module's mirrored bounds must equal the engine's — a drift guard, since
  // this module is deliberately pure and does not import the engine.
  assert.equal(MIN_CHESS_AI_SKILL_LEVEL, MIN_ENGINE_SKILL_LEVEL);
  assert.equal(MAX_CHESS_AI_SKILL_LEVEL, MAX_ENGINE_SKILL_LEVEL);
  assert.ok(MAX_CHESS_AI_DEPTH <= MAX_ENGINE_DEPTH);

  // Only the weakest tiers may take a worse move on purpose; hard never does.
  assert.ok(chessAiSlipRate("easy") > chessAiSlipRate("medium"));
  assert.equal(chessAiSlipRate("hard"), null);
  assert.equal(easy.slipTier, "easy");
  assert.equal(medium.slipTier, "normal");
  assert.equal(hard.slipTier, null);
});

test("an unknown or hostile tier coerces to the documented default instead of throwing", () => {
  // A game must never break because a tier came in wrong; `isChessAiDifficulty`
  // is the strict test a ROUTE uses when it wants to reject the input.
  for (const hostile of [undefined, null, "", "   ", "not-a-tier", {}, [], NaN, Infinity]) {
    assert.equal(
      coerceChessAiDifficulty(hostile),
      DEFAULT_CHESS_AI_DIFFICULTY,
      `${JSON.stringify(hostile)} should coerce to the default`,
    );
  }

  // The spellings this repo actually shipped, including chess's own 1–5 levels.
  assert.equal(coerceChessAiDifficulty("normal"), "medium");
  assert.equal(coerceChessAiDifficulty("NORMAL"), "medium");
  assert.equal(coerceChessAiDifficulty("beginner"), "easy");
  assert.equal(coerceChessAiDifficulty("insane"), "hard");
  assert.equal(coerceChessAiDifficulty("expert"), "hard");
  assert.equal(coerceChessAiDifficulty(1), "easy");
  assert.equal(coerceChessAiDifficulty(2), "easy");
  assert.equal(coerceChessAiDifficulty(3), "medium");
  assert.equal(coerceChessAiDifficulty(4), "hard");
  assert.equal(coerceChessAiDifficulty(5), "hard");
  assert.equal(coerceChessAiDifficulty("4"), "hard");

  // A missing (or unrecognised) tier resolves to the same settings as an
  // explicit `medium`. `insane` is deliberately NOT used here: it is an alias
  // for the hardest tier, which is asserted in the coercion test above.
  assert.deepEqual(settingsForChessAiDifficulty(undefined), settingsForChessAiDifficulty("medium"));
  assert.deepEqual(settingsForChessAiDifficulty("not-a-tier"), CHESS_AI_SEARCH_SETTINGS[DEFAULT_CHESS_AI_DIFFICULTY]);
});

test("a row with no tier reads as the default, which is what the migration backfills", () => {
  assert.equal(DEFAULT_CHESS_AI_DIFFICULTY, "medium");
  assert.equal(chessAiDifficultyFromMatch(null), "medium");
  assert.equal(chessAiDifficultyFromMatch({}), "medium");
  assert.equal(chessAiDifficultyFromMatch({ aiDifficulty: null }), "medium");
  assert.equal(chessAiDifficultyFromMatch({ aiDifficulty: "hard" }), "hard");
  assert.equal(chessAiDifficultyFromMatch({ aiDifficulty: "nonsense" }), "medium");
});

// ════════════════════════════════════════════════════════════════════
// 2. Pure helpers (the pieces the engine path leans on)
// ════════════════════════════════════════════════════════════════════

test("UCI parsing accepts only well-formed square pairs", () => {
  assert.deepEqual(parseUci("e2e4"), { from: "e2", to: "e4", promotion: null });
  assert.deepEqual(parseUci("E7E8Q"), { from: "e7", to: "e8", promotion: "q" });
  assert.deepEqual(parseUci(" e1g1 "), { from: "e1", to: "g1", promotion: null });
  // Everything an engine might answer with that is NOT a move.
  for (const bad of ["", "(none)", "0000", "hello", "e2", "e2e9", "i2i4", null, undefined]) {
    assert.equal(parseUci(bad), null, `${JSON.stringify(bad)} must not parse as a move`);
  }
});

test("candidate ranking folds mate in above any material score", () => {
  assert.ok(candidateScore({ rank: 1, uci: "a1a2", cp: null, mate: 3 }) > candidateScore({ rank: 2, uci: "b1b2", cp: 9000, mate: null }));
  assert.ok(candidateScore({ rank: 1, uci: "a1a2", cp: 900, mate: null }) > candidateScore({ rank: 2, uci: "b1b2", cp: 100, mate: null }));
  // Being mated right now is the worst possible line.
  assert.equal(candidateScore({ rank: 1, uci: null, cp: null, mate: 0 }), -MATE_SCORE_CP);
  // A missing score must not outrank a real one.
  assert.ok(candidateScore({ rank: 1, uci: "a1a2", cp: 5, mate: null }) > candidateScore({ rank: 2, uci: null, cp: null, mate: null }));
});

test("the search budget can only ever be lowered, never raised", () => {
  const hard = settingsForChessAiDifficulty("hard");
  // A request above the tier's budget is clamped DOWN to it...
  assert.equal(resolveMoveTimeMs(hard, 60_000), hard.moveTimeMs);
  // ...and the ceiling holds even for a tier whose budget were misconfigured.
  assert.ok(resolveMoveTimeMs(hard, 60_000) <= MAX_CHESS_AI_MOVE_TIME_MS);
  // A smaller request is honoured.
  assert.equal(resolveMoveTimeMs(hard, 120), 120);
  // Garbage falls back to the tier's own budget rather than disabling the cap.
  for (const bad of [undefined, null, NaN, "fast", {}, Infinity]) {
    assert.equal(resolveMoveTimeMs(hard, bad), hard.moveTimeMs);
  }
});

// ════════════════════════════════════════════════════════════════════
// 3. The real engine: legality, bounds, and the per-call option reset
// ════════════════════════════════════════════════════════════════════

test("every tier returns a LEGAL move, with a consistent SAN and resulting position", async () => {
  for (const tier of CHESS_AI_DIFFICULTIES) {
    const started = Date.now();
    const move = await chooseGameplayMove({ fen: QUEEN_FORK, difficulty: tier });
    const elapsed = Date.now() - started;

    assert.ok(isLegal(QUEEN_FORK, move.uci), `${tier} returned an illegal move: ${move.uci}`);
    assert.equal(move.difficulty, tier);
    assert.equal(move.color, "white", "White is to move in this position");
    assert.equal(move.fen, new Chess(QUEEN_FORK).fen(), "the searched FEN is the normalised position");
    assert.equal(move.fenAfter, fenAfterUci(QUEEN_FORK, move.uci), "fenAfter must be the position the move produces");
    // The UCI handed back is the one /api/chess/move would store, so it must
    // describe the move that was actually applied — promotion suffix included
    // only when the move promotes.
    assert.match(move.uci, /^[a-h][1-8][a-h][1-8][qrbn]?$/);
    assert.equal(move.uci.length, move.promotion ? 5 : 4);

    // SAN is generated by chess.js from the applied move, so re-applying the
    // same squares must produce the same SAN and the same position.
    const replayed = new Chess(QUEEN_FORK);
    const applied = replayed.move({
      from: move.from,
      to: move.to,
      promotion: move.promotion ?? undefined,
    });
    assert.equal(applied.san, move.san, "the returned SAN must describe the applied move");
    assert.equal(replayed.fen(), move.fenAfter);

    // Bounded: the tier's budget, and the engine's own watchdog are the only
    // things that may stop it. 4 s of slack is the engine's documented watchdog,
    // so this bound is the failure mode, not a performance gate.
    assert.ok(move.moveTimeMs > 0 && move.moveTimeMs <= move.settings.moveTimeMs);
    assert.ok(move.moveTimeMs <= MAX_CHESS_AI_MOVE_TIME_MS);
    assert.ok(elapsed < move.moveTimeMs + 6_000, `${tier} took ${elapsed}ms — the search overran its watchdog`);
  }
});

test("the engine's options are set per call, and are RESET for the next caller", async () => {
  // A beginner gameplay search: the weakest skill, the widest candidate window.
  const beginner = await chooseGameplayMove({ fen: START, difficulty: "easy" });
  assert.equal(beginner.sentEngineSettings.skillLevel, MIN_CHESS_AI_SKILL_LEVEL);
  assert.equal(beginner.sentEngineSettings.multiPv, CHESS_AI_SEARCH_SETTINGS.easy.multiPv);
  // ENGINE-SIDE evidence that the MultiPV width actually took effect: the engine
  // emitted this many ranked lines. If the option had been ignored, a search
  // would report one line no matter what we asked for.
  assert.equal(beginner.candidates.length, CHESS_AI_SEARCH_SETTINGS.easy.multiPv);

  // Now an EVALUATION-shaped call: the evaluator passes no skill/MultiPV at all.
  // If the gameplay settings had leaked onto the shared instance, this search
  // would run at beginner strength and report a wrong number — the exact failure
  // this test exists to catch.
  const evaluationStyle = await analyzePosition(START, { depth: 4, moveTimeMs: 200 });
  assert.equal(evaluationStyle.settings.skillLevel, FULL_SKILL_LEVEL, "an option-free search must be issued at full strength");
  assert.equal(evaluationStyle.settings.multiPv, 1);
  // ...and the engine must have narrowed back to a single ranked line, which is
  // the observable half of that reset.
  assert.equal(
    evaluationStyle.candidates.length,
    1,
    "after a beginner search, an option-free search must still get ONE ranked line",
  );

  // And the reverse direction: a full-strength search must not leave MultiPV shut
  // for the next gameplay call.
  const narrower = await chooseGameplayMove({ fen: START, difficulty: "medium" });
  assert.equal(narrower.sentEngineSettings.multiPv, CHESS_AI_SEARCH_SETTINGS.medium.multiPv);
  assert.equal(narrower.sentEngineSettings.skillLevel, CHESS_AI_SEARCH_SETTINGS.medium.skillLevel);
  assert.equal(narrower.candidates.length, CHESS_AI_SEARCH_SETTINGS.medium.multiPv);
});

test("hard plays the engine's own best move and never slips", async () => {
  // An independent full-strength search is the reference for "the best move".
  const reference = await analyzePosition(QUEEN_FORK, { depth: 10, moveTimeMs: 300 });
  const hard = await chooseGameplayMove({ fen: QUEEN_FORK, difficulty: "hard" });

  assert.equal(hard.uci, reference.bestMoveUci);
  assert.equal(hard.selection, "best");
  assert.equal(hard.settings.slipTier, null);
  // Hard is one ranked line, so there is nothing to slip TO.
  assert.equal(hard.candidates.length, 1);
});

test("Easy is genuinely beginner-friendly: a slipped move is measurably worse at FULL strength", async () => {
  // `random: () => 0` forces the slip branch deterministically, so this asserts
  // the POLICY rather than hoping a random roll misbehaves.
  const slipped = await chooseGameplayMove({
    fen: QUEEN_FORK,
    difficulty: "easy",
    random: () => 0,
  });

  assert.ok(isLegal(QUEEN_FORK, slipped.uci), "even a slipped move must be legal");

  // The slip must pass over the strongest candidate the engine offered.
  const legalCandidates = slipped.candidates
    .filter((candidate) => candidate.uci !== null && isLegal(QUEEN_FORK, candidate.uci))
    .sort((a, b) => candidateScore(b) - candidateScore(a));
  assert.ok(legalCandidates.length >= 2, "this position must offer the slip somewhere to go");
  assert.notEqual(
    slipped.uci,
    legalCandidates[0].uci,
    "a forced slip must not play the best-scoring candidate",
  );

  // THE MEASUREMENT: judge both moves with a FULL-strength search of the
  // position each one produces. This is the "noticeably beginner-friendly"
  // claim tested rather than assumed from how long the search took.
  const afterSlipped = await whiteCp(slipped.fenAfter);
  const afterBest = await whiteCp(fenAfterUci(QUEEN_FORK, legalCandidates[0].uci));

  assert.ok(
    afterBest >= 1_000,
    `the strongest candidate should win the queen outright, measured ${afterBest} cp`,
  );
  assert.ok(
    afterBest - afterSlipped >= 1_000,
    `the slip must cost real material: best ${afterBest} cp vs slipped ${afterSlipped} cp`,
  );
});

test("concurrent searches each answer for their OWN position", async () => {
  // The engine is one stateful instance serialised by its mutex. If gameplay and
  // evaluation ever interleaved their `go` commands, a search would come back
  // with another position's answer — so each request here must be legal in the
  // position it asked about, and nothing else.
  const requests = [
    { fen: START, difficulty: "hard" },
    { fen: QUEEN_FORK, difficulty: "easy" },
    { fen: MATE_IN_1, difficulty: "medium" },
    { fen: START, difficulty: "medium" },
    { fen: QUEEN_FORK, difficulty: "hard" },
    { fen: MATE_IN_1, difficulty: "easy" },
  ];

  const moves = await Promise.all(requests.map((request) => chooseGameplayMove(request)));

  moves.forEach((move, index) => {
    const { fen } = requests[index];
    assert.ok(
      isLegal(fen, move.uci),
      `request ${index} (${move.difficulty}) got "${move.uci}", which is not legal in its own position`,
    );
    assert.equal(move.fen, new Chess(fen).fen(), `request ${index} searched the wrong position`);
  });
});

// ════════════════════════════════════════════════════════════════════
// 4. Failing closed — no move is ever fabricated
// ════════════════════════════════════════════════════════════════════

/** An analyzer that must never be reached. */
function forbiddenAnalyzer(counter) {
  return async () => {
    counter.calls += 1;
    throw new Error("the engine must not be reached for this input");
  };
}

test("an unusable position fails before the engine is asked", async () => {
  const counter = { calls: 0 };
  // NOTE: chess.js TOLERATES a truncated FEN (`…RNBQKBNR w KQkq` is accepted),
  // so only genuinely unloadable strings are listed here.
  for (const bad of [
    "",
    "   ",
    "not a fen",
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR",
    "9/9/9/9/9/9/9/9 w - - 0 1",
    "8/8/8/8/8/8/8/8 w - - 0 1",
  ]) {
    await assert.rejects(
      () => chooseGameplayMove({ fen: bad, difficulty: "hard" }, { analyze: forbiddenAnalyzer(counter) }),
      ChessGameplayEngineError,
      `${JSON.stringify(bad)} must be rejected`,
    );
  }
  assert.equal(counter.calls, 0, "no search may be spent on an unusable position");
});

test("a position with nothing to play fails before the engine is asked", async () => {
  const counter = { calls: 0 };
  // Black is checkmated in CHECKMATE, so Black has no legal move at all.
  await assert.rejects(
    () => chooseGameplayMove({ fen: CHECKMATE, difficulty: "easy" }, { analyze: forbiddenAnalyzer(counter) }),
    (err) => {
      assert.ok(err instanceof ChessGameplayEngineError);
      assert.match(err.message, /no legal moves/);
      return true;
    },
  );
  assert.equal(counter.calls, 0, "a mate must never cost a search");
});

test("an already-drawn game fails before the engine is asked, even though moves exist", async () => {
  // Distinct from the checkmate case above: chess.js reports 20 legal moves
  // here, but the game is over on the fifty-move rule.
  const counter = { calls: 0 };
  await assert.rejects(
    () =>
      chooseGameplayMove(
        { fen: DRAWN_WITH_MOVES, difficulty: "hard" },
        { analyze: forbiddenAnalyzer(counter) },
      ),
    (err) => {
      assert.ok(err instanceof ChessGameplayEngineError);
      assert.match(err.message, /already over/);
      return true;
    },
  );
  assert.equal(counter.calls, 0, "a finished game must never cost a search");
});

test("an engine that throws never becomes a move", async () => {
  await assert.rejects(
    () =>
      chooseGameplayMove(
        { fen: START, difficulty: "hard" },
        {
          analyze: async () => {
            throw new Error("stockfish booted but never answered");
          },
        },
      ),
    (err) => {
      assert.ok(err instanceof ChessGameplayEngineError);
      // The underlying reason is preserved for the log, not swallowed.
      assert.match(err.message, /could not produce a move/);
      assert.equal(err.cause?.message, "stockfish booted but never answered");
      return true;
    },
  );
});

test("a malformed engine response is refused", async () => {
  for (const malformed of [undefined, null, {}, { candidates: "nope" }, 42]) {
    await assert.rejects(
      () => chooseGameplayMove({ fen: START, difficulty: "easy" }, { analyze: async () => malformed }),
      ChessGameplayEngineError,
      `${JSON.stringify(malformed)} must be refused`,
    );
  }
});

test("illegal engine output is never played — no fabricated fallback", async () => {
  // The engine names a move that cannot be played and offers no alternative.
  await assert.rejects(
    () =>
      chooseGameplayMove(
        { fen: START, difficulty: "easy" },
        {
          analyze: async () => ({
            candidates: [],
            bestMoveUci: "a1a8",
            cp: 0,
            mate: null,
            ms: 1,
            settings: { skillLevel: 0, multiPv: 5 },
          }),
        },
      ),
    (err) => {
      assert.ok(err instanceof ChessGameplayEngineError);
      assert.match(err.message, /no legal move/);
      return true;
    },
  );

  // A non-UCI `bestmove` token is the same story.
  await assert.rejects(
    () =>
      chooseGameplayMove(
        { fen: START, difficulty: "easy" },
        {
          analyze: async () => ({
            candidates: [{ rank: 1, uci: "hello", cp: 0, mate: null }],
            bestMoveUci: "(none)",
            cp: 0,
            mate: null,
            ms: 1,
            settings: { skillLevel: 0, multiPv: 5 },
          }),
        },
      ),
    ChessGameplayEngineError,
  );
});

test("CONTROL: a legal engine answer with an illegal bestmove falls back to the legal candidate", async () => {
  // Same seam as the failures above, with one legal candidate present. It must
  // SUCCEED, which is what stops the failure assertions being vacuous — and it
  // proves the fallback picks engine output rather than inventing anything.
  const move = await chooseGameplayMove(
    { fen: START, difficulty: "easy" },
    {
      analyze: async () => ({
        candidates: [{ rank: 1, uci: "e2e4", cp: 24, mate: null }],
        bestMoveUci: "a1a8",
        cp: 24,
        mate: null,
        ms: 3,
        settings: { skillLevel: 0, multiPv: 5 },
      }),
    },
  );

  assert.equal(move.uci, "e2e4");
  assert.equal(move.san, "e4");
  assert.equal(isLegal(START, move.uci), true);
  assert.equal(move.sentEngineSettings.skillLevel, 0);
  assert.equal(move.selection, "best");
});

test("an unknown difficulty is coerced for the search, never thrown on", async () => {
  const move = await chooseGameplayMove(
    { fen: START, difficulty: "absolutely-not-a-tier" },
    {
      analyze: async () => ({
        candidates: [{ rank: 1, uci: "d2d4", cp: 20, mate: null }],
        bestMoveUci: "d2d4",
        cp: 20,
        mate: null,
        ms: 2,
        settings: { skillLevel: 20, multiPv: 1 },
      }),
    },
  );
  assert.equal(move.difficulty, DEFAULT_CHESS_AI_DIFFICULTY);
});

test("a slip is skipped when the engine offers only one candidate", async () => {
  // Nothing to slip to: the tier must still return the engine's best move
  // instead of failing or fabricating an alternative.
  const move = await chooseGameplayMove(
    { fen: START, difficulty: "easy", random: () => 0 },
    {
      analyze: async () => ({
        candidates: [{ rank: 1, uci: "g1f3", cp: 18, mate: null }],
        bestMoveUci: "g1f3",
        cp: 18,
        mate: null,
        ms: 2,
        settings: { skillLevel: 0, multiPv: 5 },
      }),
    },
  );
  assert.equal(move.uci, "g1f3");
  assert.equal(move.selection, "best");
});
