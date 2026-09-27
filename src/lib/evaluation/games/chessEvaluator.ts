/**
 * Chess — OBJECTIVE match evaluator (no LLM, no guessing).
 *
 * Turns a finished `chess_games` row plus its `chess_moves` history into real,
 * reproducible statistics: a centipawn evaluation after every move, per-player
 * accuracy, the mistakes/blunders, and the single biggest swing ("key moment").
 * Every number here is derived from the stored move history and a Stockfish
 * search — see src/lib/evaluation/engine/stockfishEngine.ts for why that engine
 * is serverless-safe. Nothing in this file calls a model.
 *
 * SOURCE OF TRUTH
 * ---------------
 * `chess_moves` already stores `fen_after` for every ply, so the position
 * sequence is read, not recomputed. chess.js is used only to VALIDATE that
 * history (every FEN must load, every stored SAN must be legal in the position
 * before it, and the position it produces must match the stored `fen_after`).
 * A history that does not replay is reported as insufficient data rather than
 * analysed — a wrong eval curve would be worse than none.
 *
 * SCORING CONVENTIONS
 * -------------------
 *   - The engine reports centipawns from the side to move's point of view
 *     (UCI). Everything returned by this module is normalised to WHITE's point
 *     of view; `cpLoss` is the drop from the MOVER's point of view, clamped at
 *     0, which is the number move classification is based on.
 *   - Mate scores are folded into centipawns at ±MATE_CP (±10000, decaying by
 *     100 cp per move to mate) so the accuracy maths stays continuous.
 *   - Accuracy uses Lichess's published formulas (lichess.org/page/accuracy):
 *       Win%      = 50 + 50 * (2 / (1 + exp(-0.00368208 * cp)) - 1)
 *       Accuracy% = 103.1668 * exp(-0.04354 * (Win%before - Win%after)) - 3.1669
 *     averaged over a player's moves. That is the plain per-move average, NOT
 *     Lichess's volatility-weighted game accuracy — it is documented here so
 *     the number is never mistaken for theirs.
 *   - Thresholds are the standard ones: a swing of >100 cp against the mover is
 *     a BLUNDER, 50–100 cp is a MISTAKE.
 *
 * COST: one engine search per position (plies + 1), ~100–250 ms each at the
 * defaults, serialised through the engine's mutex. A long game is therefore
 * bounded by `timeBudgetMs`; if the budget is exhausted the result is
 * insufficient data (never a partial, silently-wrong curve).
 */

import { asc, eq } from "drizzle-orm";
import { Chess } from "chess.js";

import { db } from "../../../db/client";
import { chessGames, chessMoves } from "../../../db/schema";
import {
  DEFAULT_ENGINE_DEPTH,
  DEFAULT_ENGINE_MOVE_TIME_MS,
  MAX_ENGINE_DEPTH,
  MIN_ENGINE_DEPTH,
  analyzePosition,
  getEngineIdentity,
} from "../engine/stockfishEngine";

// ════════════════════════════════════════════════════════════════════
// Thresholds + defaults
// ════════════════════════════════════════════════════════════════════

/** A swing of MORE than this many centipawns against the mover is a blunder. */
export const BLUNDER_CP = 100;
/** A swing of this many centipawns (inclusive) up to BLUNDER_CP is a mistake. */
export const MISTAKE_CP = 50;
/** Mate is folded into centipawns at this magnitude. */
export const MATE_CP = 10_000;
/** Below this many plies there is nothing meaningful to say about a game. */
export const MIN_EVALUABLE_MOVES = 5;
/** Default ceiling on total engine time for one game (ms). */
export const DEFAULT_TIME_BUDGET_MS = 20_000;

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════

export type ChessColor = "white" | "black";

/** How one move compares to the engine's view of the position before it. */
export type ChessMoveClassification = "blunder" | "mistake" | "good";

export type ChessMoveEvaluation = {
  /** 1-based ply index within the game (1 = White's first move). */
  ply: number;
  /** Chess move number (1-based full move; ply 3 and 4 are both move 2). */
  moveNumber: number;
  san: string;
  /** Played move in lowercase UCI, e.g. "e2e4" / "e7e8q". */
  uci: string;
  /** Clerk id of the player who made this move. */
  playedBy: string;
  color: ChessColor;
  /** Evaluation in centipawns, WHITE's point of view, before the move. */
  evalBeforeCp: number;
  /** Evaluation in centipawns, WHITE's point of view, after the move. */
  evalAfterCp: number;
  /** Centipawns lost by the mover (>= 0). The classification input. */
  cpLoss: number;
  classification: ChessMoveClassification;
  /** True for the highest-cpLoss move of the game (the "key moment"). */
  isKeyMoment: boolean;
  /** Whether the mover played the engine's own best move here. */
  wasEngineBestMove: boolean;
  /** The engine's best move in that position (lowercase UCI), if any. */
  engineBestMoveUci: string | null;
  /** Wall-clock ms between this move and the previous one, when known. */
  thinkTimeMs: number | null;
};

export type ChessPlayerSummary = {
  playedBy: string;
  color: ChessColor;
  moveCount: number;
  /** Plain average of per-move accuracy (see the file header). 0–100. */
  accuracyPercent: number;
  averageCpLoss: number;
  blunders: number;
  mistakes: number;
  /** Moves that matched the engine's best move. */
  bestMoves: number;
  /** Total time attributed to this player, or null if timestamps were unusable. */
  totalThinkTimeMs: number | null;
  averageThinkTimeMs: number | null;
  longestThinkMs: number | null;
};

export type ChessKeyMoment = {
  ply: number;
  moveNumber: number;
  san: string;
  uci: string;
  playedBy: string;
  color: ChessColor;
  cpLoss: number;
  evalBeforeCp: number;
  evalAfterCp: number;
};

/** Why a game could not be evaluated. Never a substitute for stats. */
export type ChessInsufficientReason =
  | "game_not_found"
  | "invalid_move_history"
  | "too_few_moves"
  | "engine_unavailable"
  | "time_budget_exceeded"
  | "database_error";

export type ChessObjectiveData =
  | {
      gameId: string;
      sufficient: true;
      moveCount: number;
      plyCount: number;
      /**
       * Which engine judged the game, and how hard it searched — the audit
       * trail that makes these numbers verifiable rather than asserted.
       */
      engine: { id: string; depth: number; moveTimeMs: number };
      players: { white: ChessPlayerSummary; black: ChessPlayerSummary };
      /** The largest single eval swing against the mover, if there was one. */
      keyMoment: ChessKeyMoment | null;
      blunders: ChessMoveEvaluation[];
      mistakes: ChessMoveEvaluation[];
      /** Every ply, in order. Doubles as the eval timeline. */
      moves: ChessMoveEvaluation[];
      thresholds: { blunderCp: number; mistakeCp: number };
      /** Total wall-clock time the engine spend analysing this game. */
      analysisMs: number;
    }
  | {
      gameId: string;
      sufficient: false;
      reason: ChessInsufficientReason;
      detail: string;
      moveCount: number;
    };

/** A stored move, reduced to what the analysis needs. */
export type ChessStoredMove = {
  san: string;
  uci: string;
  fenAfter: string;
  playedBy: string;
  createdAtIso: string | null;
};

export type ChessMatchInput = {
  gameId: string;
  playerWhiteId: string | null;
  playerBlackId: string | null;
  /** When the game started (fallback for the first move's think time). */
  startedAtIso: string | null;
  /** When the game row was created (second fallback). */
  createdAtIso: string | null;
  moves: ChessStoredMove[];
};

export type ChessAnalysisOptions = {
  /** Engine search depth ceiling (clamped to 1–24). Default 10. */
  depth?: number;
  /** Hard per-position time cap in ms. Default 200. */
  moveTimeMs?: number;
  /** Total engine budget for the game in ms. Default 20000. */
  timeBudgetMs?: number;
};

// ════════════════════════════════════════════════════════════════════
// Scoring maths (exported: the test file pins the published formulas)
// ════════════════════════════════════════════════════════════════════

/**
 * Lichess's centipawns → win-probability curve (lichess.org/page/accuracy).
 * Bounded 0–100; cp 0 => 50.
 */
export function winPercent(cp: number): number {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

/** Lichess's per-move accuracy from the win-probability drop, clamped 0–100. */
export function moveAccuracyPercent(winBefore: number, winAfter: number): number {
  const raw = 103.1668 * Math.exp(-0.04354 * (winBefore - winAfter)) - 3.1669;
  return Math.min(100, Math.max(0, raw));
}

/** Classifies a cp loss using the standard thresholds. */
export function classifyMove(cpLoss: number): ChessMoveClassification {
  if (cpLoss > BLUNDER_CP) return "blunder";
  if (cpLoss >= MISTAKE_CP) return "mistake";
  return "good";
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function round(value: number, decimals = 1): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function insufficient(
  gameId: string,
  reason: ChessInsufficientReason,
  detail: string,
  moveCount = 0,
): ChessObjectiveData {
  return { gameId, sufficient: false, reason, detail, moveCount };
}

// ════════════════════════════════════════════════════════════════════
// Pure analysis (no DB, no engine boot of its own — testable in isolation)
// ════════════════════════════════════════════════════════════════════

/** Loads a FEN, or returns null when chess.js rejects it. */
function tryLoad(fen: string): Chess | null {
  try {
    return new Chess(fen);
  } catch {
    return null;
  }
}

/** The piece placement + side to move — the part of a FEN that must match. */
function boardAndTurn(fen: string): string {
  return fen.trim().split(/\s+/).slice(0, 2).join(" ");
}

function colorOf(turn: "w" | "b"): ChessColor {
  return turn === "w" ? "white" : "black";
}

/**
 * Replays the stored history and checks it is internally consistent: every FEN
 * must load, every SAN must be legal in the position before it, and replaying
 * that move must land on the position stored after it.
 *
 * @returns null when the history is sound, else a human-readable reason.
 */
function validateHistory(input: ChessMatchInput): string | null {
  const positions = [START_FEN, ...input.moves.map((m) => m.fenAfter)];

  for (const [index, fen] of positions.entries()) {
    if (!tryLoad(fen)) {
      return `position ${index === 0 ? "at the start" : `after ply ${index}`} is not a valid FEN`;
    }
  }

  for (let index = 0; index < input.moves.length; index += 1) {
    const move = input.moves[index];
    const before = tryLoad(positions[index]) as Chess;
    try {
      before.move(move.san);
    } catch {
      return `ply ${index + 1} ("${move.san}") is not legal in the stored position`;
    }
    // `before` is now the position that move produced. Compare the substantive
    // part of the FEN (board + side to move) only — chess.js legitimately
    // normalises castling rights and counters on load, so the full string can
    // differ without the history being wrong.
    if (boardAndTurn(before.fen()) !== boardAndTurn(positions[index + 1])) {
      return `ply ${index + 1} ("${move.san}") does not lead to the position stored after it`;
    }
  }
  return null;
}

/**
 * The objective evaluation of a chess match, from an already-loaded history.
 * Split out from `evaluateChessMatch` so it can be exercised without a
 * database (see tests/chess-evaluator.test.mjs).
 */
export async function analyzeChessGame(
  input: ChessMatchInput,
  options: ChessAnalysisOptions = {},
): Promise<ChessObjectiveData> {
  const gameId = String(input?.gameId ?? "");
  const moves = input?.moves ?? [];
  const depth = clampInt(options.depth, MIN_ENGINE_DEPTH, MAX_ENGINE_DEPTH, DEFAULT_ENGINE_DEPTH);
  const moveTimeMs = clampInt(options.moveTimeMs, 1, 10_000, DEFAULT_ENGINE_MOVE_TIME_MS);
  const timeBudgetMs = clampInt(options.timeBudgetMs, 0, 300_000, DEFAULT_TIME_BUDGET_MS);

  // Nothing to say about a game that barely happened (resignation on move 1,
  // an aborted game, ...). Never fabricate: report the flag instead.
  if (moves.length < MIN_EVALUABLE_MOVES) {
    return insufficient(
      gameId,
      "too_few_moves",
      `only ${moves.length} move(s) were played; at least ${MIN_EVALUABLE_MOVES} are needed`,
      moves.length,
    );
  }

  const historyError = validateHistory(input);
  if (historyError) {
    return insufficient(gameId, "invalid_move_history", historyError, moves.length);
  }

  // The positions to evaluate: the start position, then every position the game
  // actually reached (so ply k's "before" is positions[k] and "after" is
  // positions[k + 1]).
  const positions = [START_FEN, ...moves.map((m) => m.fenAfter)];

  const startedAt = Date.now();
  const scores: { cpWhite: number; bestMoveUci: string | null }[] = [];
  try {
    for (const [index, fen] of positions.entries()) {
      if (Date.now() - startedAt > timeBudgetMs) {
        return insufficient(
          gameId,
          "time_budget_exceeded",
          `engine budget of ${timeBudgetMs} ms was exhausted after ${index} of ${positions.length} positions`,
          moves.length,
        );
      }
      // The side to move in each FEN is the player whose move created it.
      const turnMatch = /^\S+ ([wb]) /.exec(fen.trim());
      const score = await analyzePosition(fen, { depth, moveTimeMs });
      scores.push({
        cpWhite: whitePovCp(score, turnMatch?.[1] === "b" ? "b" : "w"),
        bestMoveUci: score.bestMoveUci,
      });
    }
  } catch (err) {
    return insufficient(
      gameId,
      "engine_unavailable",
      `stockfish could not analyse the game: ${err instanceof Error ? err.message : String(err)}`,
      moves.length,
    );
  }
  const analysisMs = Date.now() - startedAt;

  // ── Per-move evaluation ────────────────────────────────────────────
  const evaluated: ChessMoveEvaluation[] = moves.map((move, index) => {
    const ply = index + 1;
    const turn = /^\S+ ([wb]) /.exec(positions[index].trim())?.[1] === "b" ? "b" : "w";
    const color = colorOf(turn);
    const evalBeforeCp = scores[index].cpWhite;
    const evalAfterCp = scores[index + 1].cpWhite;
    const perspective = color === "white" ? 1 : -1;
    const cpLoss = Math.max(
      0,
      Math.round(perspective * (evalBeforeCp - evalAfterCp)),
    );
    const engineBest = scores[index].bestMoveUci;
    const playedUci = normalizeUci(move.uci);

    return {
      ply,
      moveNumber: Math.ceil(ply / 2),
      san: move.san,
      uci: playedUci,
      playedBy: move.playedBy,
      color,
      evalBeforeCp,
      evalAfterCp,
      cpLoss,
      classification: classifyMove(cpLoss),
      isKeyMoment: false,
      wasEngineBestMove: Boolean(engineBest) && engineBest === playedUci,
      engineBestMoveUci: engineBest,
      thinkTimeMs: thinkTimeFor(input, index),
    };
  });

  // ── Key moment: the single largest swing against the mover ─────────
  let keyIndex = -1;
  for (let index = 0; index < evaluated.length; index += 1) {
    if (evaluated[index].cpLoss <= 0) continue;
    if (keyIndex === -1 || evaluated[index].cpLoss > evaluated[keyIndex].cpLoss) {
      keyIndex = index;
    }
  }
  let keyMoment: ChessKeyMoment | null = null;
  if (keyIndex >= 0) {
    const move = evaluated[keyIndex];
    move.isKeyMoment = true;
    keyMoment = {
      ply: move.ply,
      moveNumber: move.moveNumber,
      san: move.san,
      uci: move.uci,
      playedBy: move.playedBy,
      color: move.color,
      cpLoss: move.cpLoss,
      evalBeforeCp: move.evalBeforeCp,
      evalAfterCp: move.evalAfterCp,
    };
  }

  // ── Per-player summaries ───────────────────────────────────────────
  const players = {
    white: summarize(input, "white", evaluated),
    black: summarize(input, "black", evaluated),
  };

  return {
    gameId,
    sufficient: true,
    moveCount: moves.length,
    plyCount: moves.length,
    engine: { id: getEngineIdentity(), depth, moveTimeMs },
    players,
    keyMoment,
    blunders: evaluated.filter((m) => m.classification === "blunder"),
    mistakes: evaluated.filter((m) => m.classification === "mistake"),
    moves: evaluated,
    thresholds: { blunderCp: BLUNDER_CP, mistakeCp: MISTAKE_CP },
    analysisMs,
  };
}

/** Converts a side-to-move-relative engine score into white-perspective cp. */
function whitePovCp(
  score: { cp: number | null; mate: number | null },
  sideToMove: "w" | "b",
): number {
  const perspective = sideToMove === "w" ? 1 : -1;
  if (score.mate !== null) {
    // Mate in N for the side to move is worth MATE_CP minus 100 per move left;
    // `mate 0` means the side to move is ALREADY mated.
    const magnitude = MATE_CP - Math.min(Math.abs(score.mate), 50) * 100;
    const signed = score.mate === 0 ? -MATE_CP : Math.sign(score.mate) * magnitude;
    return Math.round(perspective * signed);
  }
  return Math.round(perspective * (score.cp ?? 0));
}

/** Stored UCI is `${from}${to}${promotion}` as produced by the move route. */
function normalizeUci(uci: string): string {
  return String(uci ?? "").trim().toLowerCase();
}

/** Think time = gap between this move and the previous one (or the game start). */
function thinkTimeFor(input: ChessMatchInput, index: number): number | null {
  const current = parseIso(input.moves[index]?.createdAtIso);
  if (current === null) return null;
  const previous =
    index > 0
      ? parseIso(input.moves[index - 1]?.createdAtIso)
      : parseIso(input.startedAtIso) ?? parseIso(input.createdAtIso);
  if (previous === null) return null;
  const delta = current - previous;
  // Clock skew / a re-imported history must not produce negative thinking time.
  return delta >= 0 ? delta : null;
}

function parseIso(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function summarize(
  input: ChessMatchInput,
  color: ChessColor,
  moves: ChessMoveEvaluation[],
): ChessPlayerSummary {
  const own = moves.filter((m) => m.color === color);
  const playedBy =
    own[0]?.playedBy ??
    (color === "white" ? input.playerWhiteId : input.playerBlackId) ??
    "";

  if (own.length === 0) {
    return {
      playedBy,
      color,
      moveCount: 0,
      accuracyPercent: 0,
      averageCpLoss: 0,
      blunders: 0,
      mistakes: 0,
      bestMoves: 0,
      totalThinkTimeMs: null,
      averageThinkTimeMs: null,
      longestThinkMs: null,
    };
  }

  let accuracySum = 0;
  let cpLossSum = 0;
  for (const move of own) {
    accuracySum += moveAccuracyPercent(
      winPercent(move.evalBeforeCp),
      winPercent(move.evalAfterCp),
    );
    cpLossSum += move.cpLoss;
  }

  const times = own
    .map((m) => m.thinkTimeMs)
    .filter((t): t is number => typeof t === "number");

  return {
    playedBy,
    color,
    moveCount: own.length,
    accuracyPercent: round(accuracySum / own.length),
    averageCpLoss: round(cpLossSum / own.length),
    blunders: own.filter((m) => m.classification === "blunder").length,
    mistakes: own.filter((m) => m.classification === "mistake").length,
    bestMoves: own.filter((m) => m.wasEngineBestMove).length,
    totalThinkTimeMs: times.length > 0 ? times.reduce((a, b) => a + b, 0) : null,
    averageThinkTimeMs:
      times.length > 0 ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
    longestThinkMs: times.length > 0 ? Math.max(...times) : null,
  };
}

// ════════════════════════════════════════════════════════════════════
// Database entry point
// ════════════════════════════════════════════════════════════════════

/**
 * Evaluates one finished chess game.
 *
 * Loads `chess_games` + its ordered `chess_moves`, then runs the pure analysis
 * above. Returns a `sufficient: false` result (never fabricated stats) when the
 * game is missing, too short, has an unreplayable history, or the engine cannot
 * answer inside its budget.
 *
 * No API route or UI calls this yet.
 */
export async function evaluateChessMatch(
  gameId: string,
  options: ChessAnalysisOptions = {},
): Promise<ChessObjectiveData> {
  const id = String(gameId ?? "").trim();
  // `chess_games.id` is a uuid column: an unvalidated string would make Postgres
  // throw instead of answering "no such game".
  if (!UUID_RE.test(id)) {
    return insufficient(id, "game_not_found", `"${id || "(empty)"}" is not a chess game id`);
  }

  let game: { playerWhiteId: string; playerBlackId: string | null; startedAt: Date | null; createdAt: Date } | undefined;
  let moveRows: { moveSan: string; moveUci: string; fenAfter: string; playedBy: string; createdAt: Date }[];
  try {
    [game] = await db
      .select({
        playerWhiteId: chessGames.playerWhiteId,
        playerBlackId: chessGames.playerBlackId,
        startedAt: chessGames.startedAt,
        createdAt: chessGames.createdAt,
      })
      .from(chessGames)
      .where(eq(chessGames.id, id))
      .limit(1);

    if (!game) {
      return insufficient(id, "game_not_found", `no chess game with id ${id}`);
    }

    moveRows = await db
      .select({
        moveSan: chessMoves.moveSan,
        moveUci: chessMoves.moveUci,
        fenAfter: chessMoves.fenAfter,
        playedBy: chessMoves.playedBy,
        createdAt: chessMoves.createdAt,
      })
      .from(chessMoves)
      .where(eq(chessMoves.gameId, id))
      .orderBy(asc(chessMoves.id));
  } catch (err) {
    return insufficient(
      id,
      "database_error",
      `failed to load the game: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return analyzeChessGame(
    {
      gameId: id,
      playerWhiteId: game.playerWhiteId ?? null,
      playerBlackId: game.playerBlackId ?? null,
      startedAtIso: game.startedAt ? game.startedAt.toISOString() : null,
      createdAtIso: game.createdAt ? game.createdAt.toISOString() : null,
      moves: moveRows.map((row) => ({
        san: row.moveSan,
        uci: row.moveUci,
        fenAfter: row.fenAfter,
        playedBy: row.playedBy,
        createdAtIso: row.createdAt ? row.createdAt.toISOString() : null,
      })),
    },
    options,
  );
}
