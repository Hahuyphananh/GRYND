/**
 * Game Evaluation — the analyzer registry.
 *
 * WHY THIS EXISTS
 * ---------------
 * `SUPPORTED_EVALUATION_GAMES` used to be a hard-coded array in the service.
 * Adding post-game analytics for a second game then meant editing the request
 * path. This registry is the extension point instead: a game is eligible for
 * evaluation if — and only if — it has a registered analyzer here.
 *
 *   - Eligibility is derived from the registry, never from the lobby. A game
 *     appearing in `src/app/casino/PageClient.jsx` does NOT become evaluatable:
 *     support requires an adapter that declares its analysis type and validates
 *     its trusted input.
 *   - Chess keeps its existing evaluator verbatim. The chess adapter is a thin
 *     delegate to `evaluateChessMatch` — no reimplementation — so its persisted
 *     payload and every existing response are unchanged.
 *   - An adapter exposes BOTH `analyze` (this game's own payload) and
 *     `toGameReport` (that payload re-framed as the shared `GameReportV1`), so
 *     a later game can persist the contract without touching chess.
 *
 * Adding Tic-Tac-Toe or Speed Typing in a later step is therefore: write the
 * adapter, register it below, and add its fixture tests. Nothing else.
 */

import type { ChessAnalysisOptions, ChessObjectiveData } from "./games/chessEvaluator";
import { evaluateChessMatch } from "./games/chessEvaluator";
import { evaluateSpeedTypingMatch } from "./games/speedTypingEvaluator";
import { evaluateTicTacToeMatch } from "./games/ticTacToeEvaluator";
import {
  chessObjectiveToGameReport,
  parseGameReportV1,
  type GameReportAnalysisType,
  type GameReportV1,
} from "./gameReport";

/** Result of checking a match id against an adapter's requirements. */
export type AnalyzerInputValidation =
  | { ok: true }
  | { ok: false; reason: string };

export type EvaluationAnalyzer<TOutput = unknown> = {
  /** Canonical, lobby-facing game key (e.g. `tic-tac-toe`). */
  gameKey: string;
  /** How this game is judged. Drives which report sections are meaningful. */
  analysisType: GameReportAnalysisType;
  /**
   * The trusted, server-side tables/history this analyzer reads. Declared so a
   * reviewer can see WHAT makes an analysis defensible, and so a game can never
   * be accepted on client-reported data.
   */
  requires: string[];
  /** Cheap pre-flight check on the match id before any engine/DB work. */
  validateInput(matchId: string): AnalyzerInputValidation;
  /** Runs this game's objective analysis. Called behind the service's budget. */
  analyze(matchId: string, options?: ChessAnalysisOptions): Promise<TOutput>;
  /** Re-frames this analyzer's own payload as the shared contract. */
  toGameReport(payload: unknown): GameReportV1 | null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Chess — the reference implementation.
 *
 * Delegates to the existing evaluator, so the chess numbers, the insufficient
 * contract and the persisted payload are byte-for-byte what they were before
 * this registry existed.
 */
const chessAnalyzer: EvaluationAnalyzer<ChessObjectiveData> = {
  gameKey: "chess",
  analysisType: "exact",
  requires: ["chess_games", "chess_moves (ordered by id)"],
  validateInput(matchId) {
    return UUID_RE.test(String(matchId ?? "").trim())
      ? { ok: true }
      : { ok: false, reason: "A chess match id must be a uuid." };
  },
  analyze: (matchId, options) => evaluateChessMatch(matchId, options),
  toGameReport: (payload) => chessObjectiveToGameReport(payload, "chess"),
};

/**
 * Tic-Tac-Toe — exact evaluation of a match DECIDED within stage 1.
 *
 * The shipped game is Mega Tic-Tac-Toe (see the evaluator's header), so only a
 * match won on the single opening board is exactly solvable; every other outcome
 * (expanded lattice, tiebreak, sudden death, forfeit) is reported as
 * `unavailable` by the evaluator itself. The adapter does not widen that: it
 * registers the key and re-frames the returned report.
 */
const ticTacToeAnalyzer: EvaluationAnalyzer<GameReportV1> = {
  gameKey: "tic-tac-toe",
  analysisType: "exact",
  requires: ["tic_tac_toe_matches", "tic_tac_toe_moves (ordered by ply)"],
  validateInput(matchId) {
    return UUID_RE.test(String(matchId ?? "").trim())
      ? { ok: true }
      : { ok: false, reason: "A Tic-Tac-Toe match id must be a uuid." };
  },
  analyze: (matchId) => evaluateTicTacToeMatch(matchId),
  toGameReport: (payload) => {
    const parsed = parseGameReportV1(payload);
    return parsed.ok ? parsed.report : null;
  },
};

/**
 * Speed Typing — deterministic PERFORMANCE metrics, not move evaluation.
 *
 * There is nothing to search (one fixed passage, fastest correct completion
 * wins); the report is exact arithmetic over server-derived counts and server
 * instants (see the evaluator's header). `analysisType: "performance"` is what
 * tells the UI not to expect moves, blunders or an engine.
 */
const speedTypingAnalyzer: EvaluationAnalyzer<GameReportV1> = {
  gameKey: "speed-typing",
  analysisType: "performance",
  requires: [
    "speed_typing_matches (race_state, passage pair, go_at)",
    "src/lib/speed-typing/passages.ts (the passage text lives in code)",
  ],
  validateInput(matchId) {
    return UUID_RE.test(String(matchId ?? "").trim())
      ? { ok: true }
      : { ok: false, reason: "A Speed Typing match id must be a uuid." };
  },
  analyze: (matchId) => evaluateSpeedTypingMatch(matchId),
  toGameReport: (payload) => {
    const parsed = parseGameReportV1(payload);
    return parsed.ok ? parsed.report : null;
  },
};

/**
 * The registry. Frozen so a running serverless instance cannot have its
 * eligibility mutated at runtime.
 *
 * Chess (exact), Tic-Tac-Toe (exact, stage-1 only) and Speed Typing
 * (performance) are registered. Every other game answers 501.
 */
export const EVALUATION_ANALYZERS: Readonly<
  Record<string, EvaluationAnalyzer>
> = Object.freeze({
  [chessAnalyzer.gameKey]: chessAnalyzer as EvaluationAnalyzer,
  [ticTacToeAnalyzer.gameKey]: ticTacToeAnalyzer as EvaluationAnalyzer,
  [speedTypingAnalyzer.gameKey]: speedTypingAnalyzer as EvaluationAnalyzer,
});

/** The analyzer for a game, or `null` when the game is not supported. */
export function getEvaluationAnalyzer(
  gameKey: string,
): EvaluationAnalyzer | null {
  const key = String(gameKey ?? "").trim();
  return EVALUATION_ANALYZERS[key] ?? null;
}

/** Whether a game has a registered analyzer. The ONLY support test. */
export function isEvaluationSupported(gameKey: string): boolean {
  return getEvaluationAnalyzer(gameKey) !== null;
}

/** Registered game keys, in registration order. */
export function getSupportedEvaluationGames(): string[] {
  return Object.keys(EVALUATION_ANALYZERS);
}
