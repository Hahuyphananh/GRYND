/**
 * Chess VS-AI gameplay engine — the SERVER-side move chooser.
 *
 * WHAT THIS IS
 * ------------
 * The one place a Chess AI's move is GENERATED. It sits on the existing
 * Stockfish WASM engine (`./evaluation/engine/stockfishEngine`) and reuses it
 * rather than starting a second engine: one instance costs ~600 KB of wasm plus
 * a boot, and two would fight for the same single vCPU. Because gameplay and
 * evaluation share that instance, every search states its own UCI options
 * explicitly — see the engine's file header for why that reset is load bearing.
 *
 * THIS STAGE DELIBERATELY DOES NOT TOUCH LIVE GAMEPLAY. Nothing in
 * `src/app/**` imports this module yet. It is the foundation the move route will
 * call once the seat/colour work lands, and it is written so that wiring it in
 * later cannot weaken any existing guarantee.
 *
 * THE TRUST BOUNDARY (unchanged, and the reason for every guard below)
 * -------------------------------------------------------------------
 *   * A move is only ever taken from the ENGINE's own output — either its
 *     `bestmove` line or one of its ranked MultiPV candidates. Nothing is
 *     synthesised, and no client-supplied move is ever accepted, so a weaker
 *     tier chooses a worse ENGINE move rather than an invented one.
 *   * Every candidate and the final choice are re-validated with chess.js
 *     against the position the search actually ran on. An illegal or malformed
 *     engine answer is an ERROR, never a fabricated move: this fails closed.
 *   * The search is bounded by the tier's budget (≤ `MAX_CHESS_AI_MOVE_TIME_MS`)
 *     and a caller may only ever LOWER it, never raise it.
 *   * Concurrency is handled by the engine's existing mutex — `analyzePosition`
 *     serialises every search through `enqueueSearch`, so gameplay and
 *     evaluation queue rather than interleave. No second instance, no new lock,
 *     no new dependency.
 *
 * SERVER-ONLY: this module reaches the WASM engine, so it must never be
 * imported by a Client Component.
 *
 * WEAKNESS IS A POLICY, NOT A SHORTER CLOCK
 * -----------------------------------------
 * The tier resolves to engine settings in `./chessDifficulty` (Skill Level is
 * the primary dial) plus a slip: after the engine ranks its candidates, a weaker
 * tier may deliberately take a worse one, using the same `chooseAiOption` policy
 * every other game's AI uses. `random` is injectable, so the slip is testable
 * deterministically instead of being assumed from how long a search took.
 */

import { Chess } from "chess.js";

import { chooseAiOption } from "./aiDifficulty";
import {
  MAX_CHESS_AI_MOVE_TIME_MS,
  coerceChessAiDifficulty,
  settingsForChessAiDifficulty,
  type ChessAiDifficulty,
  type ChessAiSearchSettings,
} from "./chessDifficulty";
import { toStoredUci } from "./chessMoveUci";
import {
  analyzePosition,
  type EngineCandidate,
  type EngineScore,
} from "./evaluation/engine/stockfishEngine";

/**
 * Raised for EVERY way this module can fail to produce a move: an unusable
 * position, an engine that cannot answer, a malformed response, or engine output
 * that is not legal in the position.
 *
 * It exists so a caller can tell "the bot had nothing to play" apart from a bug,
 * and it is always thrown — this module never returns a placeholder move, because
 * a fabricated AI move is exactly what Phase 4 ruled out.
 */
export class ChessGameplayEngineError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "ChessGameplayEngineError";
    // Assigned rather than passed to `super`: the ES2017 target this repo
    // compiles to does not type `Error`'s options bag.
    if (options && "cause" in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** A mate is folded into this many centipawns when ranking candidates. */
export const MATE_SCORE_CP = 10_000;

/** `e2e4`, `a7a8q`, `e1g1`. */
const UCI_RE = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/;

export type ParsedUci = {
  from: string;
  to: string;
  promotion: string | null;
};

/**
 * Splits a UCI move. Returns null for anything that is not a well-formed square
 * pair, so an engine that answers with prose (or an empty `bestmove (none)`)
 * cannot be mistaken for a move.
 */
export function parseUci(uci: unknown): ParsedUci | null {
  const text = String(uci ?? "").trim().toLowerCase();
  const match = UCI_RE.exec(text);
  if (!match) return null;
  return {
    from: match[1],
    to: match[2],
    promotion: match[3] ?? null,
  };
}

/**
 * A candidate's value from the MOVER's point of view, for the slip's ranking.
 *
 * The engine reports from the side to move, so a higher number is always better
 * for the player choosing — including for Black, where the sign is already
 * relative. Mate scores are folded in at `MATE_SCORE_CP` so a mate always
 * outranks any material score.
 */
export function candidateScore(candidate: EngineCandidate): number {
  if (candidate.mate !== null) {
    if (candidate.mate === 0) return -MATE_SCORE_CP;
    const magnitude = MATE_SCORE_CP - Math.min(Math.abs(candidate.mate), 50) * 100;
    return Math.sign(candidate.mate) * magnitude;
  }
  return candidate.cp ?? 0;
}

export type GameplayMoveRequest = {
  /** The position to move in. Validated with chess.js before the engine sees it. */
  fen: string;
  /** The tier. Coerced — an unknown value falls back to the documented default. */
  difficulty: unknown;
  /** Injectable so the slip policy is deterministic under test. */
  random?: () => number;
  /** Optional ceiling (ms). Can only LOWER the tier's budget. */
  timeBudgetMs?: number;
};

/**
 * The engine seam, injected so tests can drive failures (an engine that throws,
 * times out, or answers with an illegal move) without booting WASM. Same pattern
 * as `EvaluationDeps` in src/lib/evaluation/evaluationService.ts.
 */
export type GameplayDeps = {
  analyze?: typeof analyzePosition;
};

export type ChosenGameplayMove = {
  /** The position that was searched (chess.js's normalised FEN). */
  fen: string;
  /** The chosen move, in the stored UCI format (`e2e4`, `e7e8q`). */
  uci: string;
  san: string;
  /** The position AFTER the move. */
  fenAfter: string;
  from: string;
  to: string;
  promotion: string | null;
  /** The side that just moved. */
  color: "white" | "black";
  difficulty: ChessAiDifficulty;
  /** The tier's resolved settings. */
  settings: ChessAiSearchSettings;
  /**
   * The engine options this search was SENT with (the tier's resolved values,
   * which every call states explicitly — see the engine's per-call reset).
   *
   * These are what we sent, not an engine readback; `candidates.length` is the
   * independent engine-side evidence that the MultiPV width took effect.
   */
  sentEngineSettings: { skillLevel: number; multiPv: number };
  /** The effective per-move budget after clamping. */
  moveTimeMs: number;
  /** The engine's ranked candidates, best first. */
  candidates: EngineCandidate[];
  /**
   * The engine's score for the POSITION — its best line — and NOT the value of
   * the move actually played. After a slip these differ deliberately: a search
   * can report `mate 1` for the position while the chosen move is not the mate.
   * Do not present this as "the move's score".
   */
  cp: number | null;
  /** Moves to mate for the side to move in the position, if the best line mates. */
  mate: number | null;
  engineMs: number;
  /**
   * Whether the engine's own best move was played, or a weaker one on purpose.
   *
   * `best` does NOT mean "strong": Stockfish's Skill Level randomises its own
   * choice at low tiers, so a weak tier's `best` is already a weakened move.
   * `slip` means THIS module deliberately passed over the engine's best move.
   */
  selection: "best" | "slip";
};

/** Loads a position, or fails closed with a typed error. */
function loadPosition(fen: unknown): Chess {
  const raw = String(fen ?? "").trim();
  if (!raw) {
    throw new ChessGameplayEngineError("no position was supplied");
  }
  try {
    return new Chess(raw);
  } catch (err) {
    throw new ChessGameplayEngineError(
      `"${raw}" is not a valid chess position`,
      { cause: err },
    );
  }
}

/**
 * The effective budget: the tier's own value, lowered (never raised) by an
 * explicit request, and never above the approved ceiling.
 */
export function resolveMoveTimeMs(
  settings: ChessAiSearchSettings,
  requested?: number,
): number {
  const raw = Number(requested);
  if (requested === undefined || requested === null || !Number.isFinite(raw)) {
    return settings.moveTimeMs;
  }
  return Math.max(1, Math.min(settings.moveTimeMs, Math.trunc(raw), MAX_CHESS_AI_MOVE_TIME_MS));
}

/**
 * Chooses the move the AI will play in `fen`.
 *
 * @throws {ChessGameplayEngineError} when the position is unusable, the position
 *   is already over, the engine fails or times out, its response is malformed,
 *   or its chosen move is not legal here. It NEVER returns a fabricated move.
 */
export async function chooseGameplayMove(
  request: GameplayMoveRequest,
  deps: GameplayDeps = {},
): Promise<ChosenGameplayMove> {
  const analyze = deps.analyze ?? analyzePosition;
  const difficulty = coerceChessAiDifficulty(request?.difficulty);
  const settings = settingsForChessAiDifficulty(difficulty);
  const moveTimeMs = resolveMoveTimeMs(settings, request?.timeBudgetMs);

  const chess = loadPosition(request?.fen);

  // Fail closed BEFORE spending a search on a position that has nothing to play.
  // The two cases are distinct: no legal moves at all (mate/stalemate), versus a
  // game that is over while moves still exist (the 50-move and repetition draws).
  const legal = new Set(
    chess
      .moves({ verbose: true })
      .map((move) => `${move.from}${move.to}${move.promotion ?? ""}`),
  );
  if (legal.size === 0) {
    throw new ChessGameplayEngineError(
      "the position has no legal moves (checkmate or stalemate) — there is no move to choose",
    );
  }
  if (chess.isGameOver()) {
    throw new ChessGameplayEngineError(
      "the position is already over (a draw) — there is no move to choose",
    );
  }

  // The engine sees chess.js's normalised FEN, never the caller's raw string, so
  // junk in the caller's input cannot reach the engine's stdin.
  const searchFen = chess.fen();
  const color: "white" | "black" = chess.turn() === "w" ? "white" : "black";

  let score: EngineScore;
  try {
    score = await analyze(searchFen, {
      depth: settings.depth,
      moveTimeMs,
      skillLevel: settings.skillLevel,
      multiPv: settings.multiPv,
    });
  } catch (err) {
    // Boot failure, a hung search, a terminated instance — all the same to a
    // caller: no trustworthy move exists, so this is an error and not a move.
    throw new ChessGameplayEngineError(
      `the engine could not produce a move: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  // A malformed result (an injected double, a changed engine layout) must not be
  // walked as if it were a search.
  if (!score || typeof score !== "object" || !Array.isArray(score.candidates)) {
    throw new ChessGameplayEngineError("the engine returned a malformed result");
  }

  // Only candidates that are LEGAL IN THIS POSITION are selectable. An engine
  // answer that does not fit the position is dropped rather than trusted.
  const ranked = score.candidates
    .filter((candidate) => candidate.uci !== null && legal.has(candidate.uci))
    .sort((a, b) => a.rank - b.rank);

  // The engine's own best move, preferring its `bestmove` line and falling back
  // to the top-ranked legal candidate. Both are engine output; neither is ours.
  const engineBest =
    score.bestMoveUci && legal.has(score.bestMoveUci)
      ? score.bestMoveUci
      : ranked[0]?.uci ?? null;

  if (engineBest === null) {
    throw new ChessGameplayEngineError(
      "the engine returned no legal move for this position",
    );
  }

  let chosen = engineBest;
  if (settings.slipTier !== null && ranked.length > 1) {
    // A weaker tier may take a worse engine move on purpose. `slipFloor: 0`
    // opts out of the shared ratio cap: centipawn scores are relative to the
    // side to move and can be negative here, so "a fraction of the best score"
    // is not a meaningful floor — the candidate COUNT is the bound instead.
    const slipped = chooseAiOption(
      settings.slipTier,
      ranked,
      candidateScore,
      request?.random,
      0,
    );
    if (slipped?.uci) chosen = slipped.uci;
  }

  const parsed = parseUci(chosen);
  if (!parsed) {
    throw new ChessGameplayEngineError(
      `the engine's move "${chosen}" is not a well-formed UCI move`,
    );
  }

  // chess.js v1 THROWS on an illegal move rather than returning null, so the
  // application is guarded: a move that cannot be applied is an error, never a
  // silently-ignored one.
  let applied;
  try {
    applied = chess.move({
      from: parsed.from,
      to: parsed.to,
      promotion: parsed.promotion ?? undefined,
    });
  } catch (err) {
    throw new ChessGameplayEngineError(
      `the engine's move "${chosen}" is not legal in this position`,
      { cause: err },
    );
  }
  if (!applied) {
    throw new ChessGameplayEngineError(
      `the engine's move "${chosen}" could not be applied`,
    );
  }

  return {
    fen: searchFen,
    // The stored encoding is the one /api/chess/move already uses, derived from
    // the move chess.js VALIDATED — never from the engine's raw string.
    uci: toStoredUci(applied) || chosen,
    san: applied.san,
    fenAfter: chess.fen(),
    from: applied.from,
    to: applied.to,
    promotion: applied.promotion ?? null,
    color,
    difficulty,
    settings,
    sentEngineSettings: score.settings ?? {
      skillLevel: settings.skillLevel,
      multiPv: settings.multiPv,
    },
    moveTimeMs,
    candidates: score.candidates,
    cp: score.cp,
    mate: score.mate,
    engineMs: score.ms,
    selection: chosen === engineBest ? "best" : "slip",
  };
}
