/**
 * GameReportV1 — the game-agnostic post-game report contract.
 *
 * WHY THIS EXISTS
 * ---------------
 * Chess evaluation was the only game with post-game analytics, and its payload
 * (`ChessObjectiveData`) is chess-shaped: centipawns, blunders, SAN moves. The
 * audit for Phase 2 (see the repo discussion) found a second class of games that
 * can be reported on without any engine at all — deterministic performance
 * analytics (reaction time, typed characters, accuracy). Forcing those into the
 * chess payload would either invent metrics or bolt chess-only concepts onto
 * games that have no moves to classify.
 *
 * This module defines ONE versioned envelope both kinds of report share, so the
 * persistence, authorization and UI layers can treat them uniformly:
 *
 *   - `analysisType` says HOW the game was judged (`exact` move evaluation,
 *     `performance` metrics, or descriptive `statistics`). A performance report
 *     is never required to carry move classifications or engine evaluations.
 *   - Every metric is explicitly AVAILABLE with a value, or UNAVAILABLE with a
 *     reason. That is what separates a real `0` (e.g. zero centipawn loss) from
 *     "this game has no think-time data". A missing number is never written as
 *     zero, and a zero is never written as missing.
 *   - AI explanations live in an OPTIONAL `ai` branch that is stored separately
 *     from `metrics`. Nothing in a report's deterministic metrics may be derived
 *     from model output.
 *
 * PERSISTENCE
 * -----------
 * The contract is plain JSON, so it fits the existing `evaluation_results.
 * objective_data` jsonb column — no migration is required. New games persist a
 * `GameReportV1`; the chess evaluator keeps persisting its current payload so
 * `storedObjective()` and every existing chess response keep working. Both are
 * read back through `normalizeStoredGameReport()` below.
 *
 * VALIDATION
 * ----------
 * Plain, dependency-free runtime checks, matching this repo's convention (see
 * src/lib/evaluation/providers/groqProvider.ts, which validates its own shape
 * rather than pulling in a schema library).
 */

import type { ChessObjectiveData } from "./games/chessEvaluator";

// ════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════

/** Bump only for a breaking change to the shape below. */
export const GAME_REPORT_SCHEMA_VERSION = 1 as const;

/**
 * How a report's findings were produced. Kept explicit so a consumer (and the
 * UI) can tell an engine judgment apart from descriptive statistics.
 */
export const GAME_REPORT_ANALYSIS_TYPES = [
  /** Objective, move-by-move judgment by an evaluator (e.g. chess/Stockfish). */
  "exact",
  /** Deterministic metrics from trusted server data (e.g. speed typing). */
  "performance",
  /** Descriptive counts/aggregates only — no claim about optimal play. */
  "statistics",
] as const;

export const GAME_REPORT_STATUSES = ["complete", "unavailable"] as const;

/** Units a metric value can carry. `none` means a bare count/flag. */
export const GAME_REPORT_UNITS = [
  "none",
  "cp",
  "percent",
  "ratio",
  "count",
  "ms",
  "seconds",
  "wpm",
  "turns",
  "points",
  "strokes",
  "cells",
  "cards",
] as const;

export type GameReportAnalysisType = (typeof GAME_REPORT_ANALYSIS_TYPES)[number];
export type GameReportStatus = (typeof GAME_REPORT_STATUSES)[number];
export type GameReportUnit = (typeof GAME_REPORT_UNITS)[number];

// ════════════════════════════════════════════════════════════════════
// Shape
// ════════════════════════════════════════════════════════════════════

/**
 * One objective measurement.
 *
 * A discriminated union, not an optional field: `available: false` REQUIRES a
 * `reason` and forbids a `value`, while `available: true` requires the value.
 * So a consumer cannot mistake "not measured" for `0`, and adding a metric the
 * game never recorded is impossible by construction.
 */
export type GameReportMetric =
  | {
      /** Stable machine name, e.g. `accuracyPercent`. */
      key: string;
      /** Human label for the UI. */
      label: string;
      unit?: GameReportUnit;
      available: true;
      value: number | string | boolean;
    }
  | {
      key: string;
      label: string;
      unit?: GameReportUnit;
      available: false;
      /** Why this metric could not be computed — never a substitute value. */
      reason: string;
    };

/** General match metadata, included only where it is reliably available. */
export type GameReportMatch = {
  matchId: string;
  /** The stored result, when the game records one (`draw`, `white`, `p1`…). */
  result?: string | null;
  /** ISO timestamp of match completion, when stored. */
  finishedAt?: string | null;
  /** Participant ids, when the game stores seats/ownership. */
  participants?: string[];
};

/** Per-player metric breakdown (colour, seat, side — game-defined `role`). */
export type GameReportPlayerBreakdown = {
  playerId: string;
  role?: string | null;
  metrics: GameReportMetric[];
};

/** Per-round / per-turn metric breakdown. */
export type GameReportRoundBreakdown = {
  round: number;
  metrics: GameReportMetric[];
};

/**
 * One move or action, for games whose trusted history supports move-by-move
 * detail. `label` is the game's own notation (SAN, an action name, a typed
 * word); `metrics` and `tags` are optional because a performance game has no
 * move classification to report.
 */
export type GameReportMove = {
  ply: number;
  actor?: string | null;
  label: string;
  metrics?: GameReportMetric[];
  /** Game-defined vocabulary, e.g. chess `blunder`/`mistake`. */
  tags?: string[];
};

/** A moment singled out because the match data shows it mattered. */
export type GameReportKeyMoment = {
  ply: number;
  label: string;
  note?: string;
};

/**
 * Optional model-written explanation, stored apart from the deterministic
 * metrics. `available: false` is the only correct representation when the model
 * failed — the objective metrics are unaffected either way.
 */
export type GameReportAi =
  | {
      available: true;
      model?: string | null;
      summary: string;
      sections?: { key: string; title: string; items: string[] }[];
    }
  | { available: false; reason: string };

/** The audit trail for an `exact` evaluation — which engine judged it and how. */
export type GameReportEngine = {
  id: string;
  depth?: number;
  moveTimeMs?: number;
};

export type GameReportV1 = {
  schemaVersion: typeof GAME_REPORT_SCHEMA_VERSION;
  gameKey: string;
  analysisType: GameReportAnalysisType;
  status: GameReportStatus;
  match: GameReportMatch;
  metrics: GameReportMetric[];
  players?: GameReportPlayerBreakdown[];
  rounds?: GameReportRoundBreakdown[];
  /** Only for games that support it; absent, never empty, otherwise. */
  moves?: GameReportMove[];
  keyMoments?: GameReportKeyMoment[];
  /** Present only when an exact evaluation ran. */
  engine?: GameReportEngine | null;
  /** Present only when AI text was requested and produced. */
  ai?: GameReportAi | null;
  /** Why the report is `unavailable`. Null/absent on a complete report. */
  unavailableReason?: string | null;
};

// ════════════════════════════════════════════════════════════════════
// Metric helpers
// ════════════════════════════════════════════════════════════════════

/** Builds an available metric. */
export function metric(
  key: string,
  label: string,
  value: number | string | boolean,
  unit: GameReportUnit = "none",
): GameReportMetric {
  return { key, label, unit, available: true, value };
}

/** Builds an unavailable metric — a reason, never a placeholder value. */
export function unavailableMetric(
  key: string,
  label: string,
  reason: string,
  unit: GameReportUnit = "none",
): GameReportMetric {
  return { key, label, unit, available: false, reason };
}

/** Builds an available metric, or an unavailable one when `value` is nullish. */
export function metricOrUnavailable(
  key: string,
  label: string,
  value: number | string | boolean | null | undefined,
  reason: string,
  unit: GameReportUnit = "none",
): GameReportMetric {
  return value === null || value === undefined
    ? unavailableMetric(key, label, reason, unit)
    : metric(key, label, value, unit);
}

/** The metric with this key, or `null`. */
export function findMetric(
  metrics: GameReportMetric[],
  key: string,
): GameReportMetric | null {
  return metrics.find((entry) => entry.key === key) ?? null;
}

/**
 * The numeric value of a metric, or `null` when the metric is absent or
 * unavailable. Callers must treat `null` (not measured) differently from `0`.
 */
export function metricNumber(
  metrics: GameReportMetric[],
  key: string,
): number | null {
  const entry = findMetric(metrics, key);
  if (!entry || !entry.available) return null;
  return typeof entry.value === "number" ? entry.value : null;
}

// ════════════════════════════════════════════════════════════════════
// Runtime validation
// ════════════════════════════════════════════════════════════════════

export type GameReportValidation =
  | { ok: true; report: GameReportV1 }
  | { ok: false; errors: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

/** Validates one metric; appends human-readable errors to `errors`. */
function validateMetric(value: unknown, where: string, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(`${where} must be an object`);
    return;
  }
  if (typeof value.key !== "string" || value.key.length === 0) {
    errors.push(`${where}.key must be a non-empty string`);
  }
  if (typeof value.label !== "string" || value.label.length === 0) {
    errors.push(`${where}.label must be a non-empty string`);
  }
  if (value.unit !== undefined && !isOneOf(value.unit, GAME_REPORT_UNITS)) {
    errors.push(`${where}.unit must be one of the supported units`);
  }
  if (value.available === true) {
    const v = value.value;
    if (typeof v !== "number" && typeof v !== "string" && typeof v !== "boolean") {
      errors.push(`${where}.value must be a number, string or boolean`);
    }
  } else if (value.available === false) {
    if (typeof value.reason !== "string" || value.reason.length === 0) {
      errors.push(`${where}.reason must be a non-empty string when unavailable`);
    }
  } else {
    errors.push(`${where}.available must be a boolean`);
  }
}

function validateMetrics(value: unknown, where: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${where} must be an array`);
    return;
  }
  value.forEach((entry, index) => validateMetric(entry, `${where}[${index}]`, errors));
}

/**
 * Validates and narrows an unknown value into a `GameReportV1`.
 *
 * Strict about the envelope (version, analysis type, status, metrics) but
 * deliberately lenient about optional sections: an unknown extra key is ignored
 * so a future additive report field can round-trip without a version bump.
 */
export function parseGameReportV1(value: unknown): GameReportValidation {
  const errors: string[] = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: ["report must be an object"] };
  }
  if (value.schemaVersion !== GAME_REPORT_SCHEMA_VERSION) {
    errors.push(
      `schemaVersion must be ${GAME_REPORT_SCHEMA_VERSION} (got ${JSON.stringify(value.schemaVersion)})`,
    );
  }
  if (typeof value.gameKey !== "string" || value.gameKey.length === 0) {
    errors.push("gameKey must be a non-empty string");
  }
  if (!isOneOf(value.analysisType, GAME_REPORT_ANALYSIS_TYPES)) {
    errors.push("analysisType must be one of exact|performance|statistics");
  }
  if (!isOneOf(value.status, GAME_REPORT_STATUSES)) {
    errors.push("status must be one of complete|unavailable");
  }
  if (!isPlainObject(value.match) || typeof value.match.matchId !== "string" || value.match.matchId.length === 0) {
    errors.push("match.matchId must be a non-empty string");
  }
  validateMetrics(value.metrics, "metrics", errors);

  if (value.players !== undefined) {
    if (!Array.isArray(value.players)) {
      errors.push("players must be an array when present");
    } else {
      value.players.forEach((player, index) => {
        const where = `players[${index}]`;
        if (!isPlainObject(player) || typeof player.playerId !== "string" || player.playerId.length === 0) {
          errors.push(`${where}.playerId must be a non-empty string`);
          return;
        }
        validateMetrics(player.metrics, `${where}.metrics`, errors);
      });
    }
  }

  if (value.rounds !== undefined) {
    if (!Array.isArray(value.rounds)) {
      errors.push("rounds must be an array when present");
    } else {
      value.rounds.forEach((round, index) => {
        const where = `rounds[${index}]`;
        if (!isPlainObject(round) || !Number.isFinite(round.round)) {
          errors.push(`${where}.round must be a number`);
          return;
        }
        validateMetrics(round.metrics, `${where}.metrics`, errors);
      });
    }
  }

  if (value.moves !== undefined) {
    if (!Array.isArray(value.moves)) {
      errors.push("moves must be an array when present");
    } else {
      value.moves.forEach((move, index) => {
        const where = `moves[${index}]`;
        if (!isPlainObject(move) || !Number.isFinite(move.ply)) {
          errors.push(`${where}.ply must be a number`);
          return;
        }
        if (typeof move.label !== "string" || move.label.length === 0) {
          errors.push(`${where}.label must be a non-empty string`);
        }
        if (move.metrics !== undefined) validateMetrics(move.metrics, `${where}.metrics`, errors);
        if (move.tags !== undefined && !Array.isArray(move.tags)) {
          errors.push(`${where}.tags must be an array when present`);
        }
      });
    }
  }

  if (value.keyMoments !== undefined) {
    if (!Array.isArray(value.keyMoments)) {
      errors.push("keyMoments must be an array when present");
    } else {
      value.keyMoments.forEach((moment, index) => {
        const where = `keyMoments[${index}]`;
        if (!isPlainObject(moment) || !Number.isFinite(moment.ply)) {
          errors.push(`${where}.ply must be a number`);
        }
        if (!isPlainObject(moment) || typeof moment.label !== "string" || moment.label.length === 0) {
          errors.push(`${where}.label must be a non-empty string`);
        }
      });
    }
  }

  if (value.ai !== undefined && value.ai !== null) {
    if (!isPlainObject(value.ai)) {
      errors.push("ai must be an object or null");
    } else if (value.ai.available === true) {
      if (typeof value.ai.summary !== "string" || value.ai.summary.length === 0) {
        errors.push("ai.summary must be a non-empty string when available");
      }
    } else if (value.ai.available === false) {
      if (typeof value.ai.reason !== "string" || value.ai.reason.length === 0) {
        errors.push("ai.reason must be a non-empty string when unavailable");
      }
    } else {
      errors.push("ai.available must be a boolean");
    }
  }

  if (value.engine !== undefined && value.engine !== null) {
    if (!isPlainObject(value.engine) || typeof value.engine.id !== "string" || value.engine.id.length === 0) {
      errors.push("engine.id must be a non-empty string when present");
    }
  }

  if (value.status === "unavailable") {
    if (value.unavailableReason !== undefined && value.unavailableReason !== null && typeof value.unavailableReason !== "string") {
      errors.push("unavailableReason must be a string when present");
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, report: value as unknown as GameReportV1 };
}

/** Structural guard — shorthand for `parseGameReportV1(value).ok`. */
export function isGameReportV1(value: unknown): value is GameReportV1 {
  return parseGameReportV1(value).ok;
}

/** Whether a stored payload looks like a GameReportV1 (has a schema version). */
export function looksLikeGameReportV1(value: unknown): boolean {
  return isPlainObject(value) && value.schemaVersion !== undefined;
}

// ════════════════════════════════════════════════════════════════════
// Legacy → contract normalization
// ════════════════════════════════════════════════════════════════════

function isChessObjective(value: unknown): value is ChessObjectiveData {
  return (
    isPlainObject(value) &&
    typeof value.sufficient === "boolean" &&
    typeof value.gameId === "string"
  );
}

/**
 * Converts a stored, pre-contract chess payload into a `GameReportV1`.
 *
 * This is a pure re-framing of fields the evaluator already computed — no
 * number is invented, recomputed or interpreted. A `sufficient: false` payload
 * becomes an `unavailable` report carrying only the reason it stores.
 */
export function chessObjectiveToGameReport(
  payload: unknown,
  gameKey = "chess",
): GameReportV1 | null {
  if (!isChessObjective(payload)) return null;

  const analysisType: GameReportAnalysisType = "exact";
  const base = {
    schemaVersion: GAME_REPORT_SCHEMA_VERSION,
    gameKey,
    analysisType,
    match: { matchId: payload.gameId, result: null, finishedAt: null },
  } as const;

  if (payload.sufficient === false) {
    return {
      ...base,
      status: "unavailable",
      metrics: [],
      engine: null,
      unavailableReason: payload.detail || payload.reason,
    };
  }

  const { white, black } = payload.players;
  const metrics: GameReportMetric[] = [
    metric("plyCount", "Plies played", payload.plyCount, "count"),
    metric("moveCount", "Full moves", payload.moveCount, "count"),
    metric("blunderCount", "Blunders", payload.blunders.length, "count"),
    metric("mistakeCount", "Mistakes", payload.mistakes.length, "count"),
    metric("analysisMs", "Analysis time", payload.analysisMs, "ms"),
  ];

  const playerMetrics = (summary: typeof white): GameReportMetric[] => [
    metric("moveCount", "Moves", summary.moveCount, "count"),
    metric("accuracyPercent", "Accuracy", summary.accuracyPercent, "percent"),
    metric("averageCpLoss", "Average centipawn loss", summary.averageCpLoss, "cp"),
    metric("blunders", "Blunders", summary.blunders, "count"),
    metric("mistakes", "Mistakes", summary.mistakes, "count"),
    metric("bestMoves", "Best moves", summary.bestMoves, "count"),
    metricOrUnavailable(
      "totalThinkTimeMs",
      "Total think time",
      summary.totalThinkTimeMs,
      "No think-time data was recorded for this player.",
      "ms",
    ),
    metricOrUnavailable(
      "averageThinkTimeMs",
      "Average think time",
      summary.averageThinkTimeMs,
      "No think-time data was recorded for this player.",
      "ms",
    ),
    metricOrUnavailable(
      "longestThinkMs",
      "Longest think",
      summary.longestThinkMs,
      "No think-time data was recorded for this player.",
      "ms",
    ),
  ];

  // Every ply, re-framed as a move with the evaluator's own per-move numbers.
  const moves: GameReportMove[] = payload.moves.map((move) => ({
    ply: move.ply,
    actor: move.playedBy,
    label: move.san,
    tags: [move.classification],
    metrics: [
      metric("evalBeforeCp", "Eval before", move.evalBeforeCp, "cp"),
      metric("evalAfterCp", "Eval after", move.evalAfterCp, "cp"),
      metric("cpLoss", "Centipawn loss", move.cpLoss, "cp"),
      metric("wasEngineBestMove", "Matched engine best move", move.wasEngineBestMove),
    ],
  }));

  // Key moments are grounded: the evaluator's single largest swing, plus the
  // moves it classified as blunders. Deduplicated by ply.
  const seen = new Set<number>();
  const keyMoments: GameReportKeyMoment[] = [];
  const pushMoment = (ply: number, label: string, note: string) => {
    if (seen.has(ply)) return;
    seen.add(ply);
    keyMoments.push({ ply, label, note });
  };
  if (payload.keyMoment) {
    pushMoment(
      payload.keyMoment.ply,
      payload.keyMoment.san,
      `Largest swing against the mover: ${payload.keyMoment.cpLoss} cp (${payload.keyMoment.color}).`,
    );
  }
  for (const blunder of payload.blunders) {
    pushMoment(
      blunder.ply,
      blunder.san,
      `The engine classified this as a blunder: ${blunder.cpLoss} cp lost (${blunder.color}).`,
    );
  }

  return {
    ...base,
    status: "complete",
    metrics,
    players: [
      { playerId: white.playedBy, role: "white", metrics: playerMetrics(white) },
      { playerId: black.playedBy, role: "black", metrics: playerMetrics(black) },
    ],
    moves,
    keyMoments,
    engine: {
      id: payload.engine.id,
      depth: payload.engine.depth,
      moveTimeMs: payload.engine.moveTimeMs,
    },
    ai: null,
    unavailableReason: null,
  };
}

/**
 * Reads a persisted `objective_data` value into the contract, whichever shape
 * it is in:
 *
 *   - a `GameReportV1` written by a current analyzer → parsed and validated;
 *   - a pre-contract chess payload → re-framed via `chessObjectiveToGameReport`;
 *   - anything else (a pending claim marker, an unrecognized payload) → `null`.
 *
 * Callers get `null` rather than a guessed report, so an unknown/older row can
 * never be served as if it were the new contract.
 */
export function normalizeStoredGameReport(value: unknown): GameReportV1 | null {
  if (looksLikeGameReportV1(value)) {
    const parsed = parseGameReportV1(value);
    return parsed.ok ? parsed.report : null;
  }
  return chessObjectiveToGameReport(value);
}
