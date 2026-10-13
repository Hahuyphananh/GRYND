/**
 * GameReportV1 → view model for the shared evaluation page.
 *
 * WHY THIS EXISTS
 * ---------------
 * The evaluation API returns `objective`, which is EITHER a legacy chess
 * payload (`ChessObjectiveData`) OR a validated `GameReportV1`
 * (src/lib/evaluation/gameReport.ts). The page used to assume the chess shape
 * only — it gated its stat tiles on `objective.sufficient`, which does not exist
 * on a `GameReportV1`, so a perfectly good Speed Typing performance report (HTTP
 * 200) rendered no metrics at all.
 *
 * This module is the pure, DOM-free half of the fix: it VALIDATES the payload
 * with the contract's own `parseGameReportV1` (a malformed report is rejected,
 * never coerced) and turns the validated `metrics` and `players` into
 * display-ready rows. Keeping it free of React makes the rendering rules
 * unit-testable — which is where the "missing is not zero" guarantees are
 * pinned.
 *
 * THE ONE RULE THAT MATTERS
 * -------------------------
 * A metric is either AVAILABLE (it has a real value, which may be `0`) or
 * UNAVAILABLE (it has a reason and NO value). The view keeps those apart: an
 * available metric has a `value` string and `reason: null`; an unavailable one
 * has `value: null` and a reason. Nothing here ever turns an absent measurement
 * into `0`, and `formatMetricValue` is only ever called on a real value.
 *
 * WHY THE VIEW IS NOT A DISCRIMINATED UNION
 * -----------------------------------------
 * The contract types ARE discriminated unions (`available: true | false`). This
 * repo compiles with `strict: false` (strictNullChecks off), under which
 * TypeScript does not narrow the NEGATIVE branch of a boolean-discriminated
 * union — `if (metric.available) ... else metric.reason` fails to typecheck.
 * The view therefore uses explicit nullable fields, and the two readers below
 * are the only places the contract union is touched.
 */

import {
  parseGameReportV1,
  type GameReportAnalysisType,
  type GameReportAi,
  type GameReportMetric,
  type GameReportStatus,
  type GameReportUnit,
  type GameReportV1,
} from "./gameReport";

// ════════════════════════════════════════════════════════════════════
// Unit + title display
// ════════════════════════════════════════════════════════════════════

/**
 * The suffix shown after a metric's value, per unit. An empty string means the
 * unit adds nothing (a bare count/flag) and must not be invented as a word.
 */
const UNIT_SUFFIX: Record<GameReportUnit, string> = {
  none: "",
  cp: "cp",
  percent: "%",
  ratio: "",
  count: "",
  ms: "ms",
  seconds: "s",
  wpm: "WPM",
  turns: "turns",
  points: "pts",
  strokes: "strokes",
  cells: "cells",
  cards: "cards",
};

/**
 * The heading for a report, chosen from how it was judged. A performance report
 * is NEVER titled as chess/an engine evaluation — there is no engine and no move
 * classification behind it.
 */
const ANALYSIS_TITLES: Record<GameReportAnalysisType, string> = {
  exact: "Match Analysis",
  performance: "Performance Report",
  statistics: "Match Statistics",
};

// ════════════════════════════════════════════════════════════════════
// View types
// ════════════════════════════════════════════════════════════════════

/**
 * A display row for one objective metric.
 *
 * `value` is set only for an available metric and `reason` only for an
 * unavailable one; a consumer must treat a null `value` as "not measured" and
 * NEVER print it as `0`.
 */
export type ReportMetricView = {
  key: string;
  label: string;
  /** The unit suffix from the schema ("" when the unit adds nothing). */
  unit: string;
  available: boolean;
  /** The formatted value when available; null when the metric is not measured. */
  value: string | null;
  /** Why the metric could not be measured; null when it is available. */
  reason: string | null;
};

export type ReportPlayerView = {
  playerId: string;
  role: string | null;
  /** A human label from the game-defined role, or `Player N` when absent. */
  label: string;
  metrics: ReportMetricView[];
};

export type ReportAiSectionView = { key: string; title: string; items: string[] };

/** The optional model-written explanation, kept apart from the metrics. */
export type ReportAiView = {
  available: boolean;
  /** The written summary when available; null when it is not. */
  summary: string | null;
  model: string | null;
  sections: ReportAiSectionView[];
  /** Why the explanation is unavailable; null when it is available. */
  reason: string | null;
};

export type GameReportView = {
  gameKey: string;
  analysisType: GameReportAnalysisType;
  status: GameReportStatus;
  title: string;
  metrics: ReportMetricView[];
  players: ReportPlayerView[];
  /** The optional model-written explanation, kept apart from the metrics. */
  ai: ReportAiView | null;
  unavailableReason: string | null;
};

/** The result of validating + mapping a payload. */
export type GameReportViewResult = {
  ok: boolean;
  /** The mapped report when validation passed; null otherwise. */
  view: GameReportView | null;
  /** Validation errors when it failed; empty when it passed. */
  errors: string[];
};

// ════════════════════════════════════════════════════════════════════
// Contract readers
// ════════════════════════════════════════════════════════════════════

/**
 * The value of a CONTRACT metric when it is available, else null.
 *
 * The positive `=== true` check narrows correctly (unlike the negative branch),
 * so no cast is needed here.
 */
function availableValue(
  metric: GameReportMetric,
): number | string | boolean | null {
  return metric.available === true ? metric.value : null;
}

/**
 * The reason a CONTRACT metric carries when it is unavailable; "" when it is
 * available. Read through an explicit shape check because this repo's
 * `strict: false` disables negative-branch narrowing (see the module header).
 */
function unavailableReason(metric: GameReportMetric): string {
  const reason = (metric as { reason?: unknown }).reason;
  return typeof reason === "string" && reason.length > 0
    ? reason
    : "This metric was not measured for this match.";
}

// ════════════════════════════════════════════════════════════════════
// Mapping
// ════════════════════════════════════════════════════════════════════

/** Formats a real metric value as text. A boolean is Yes/No, never 1/0. */
export function formatMetricValue(value: number | string | boolean): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

/** Turns one validated contract metric into a display row. */
export function toReportMetricView(metric: GameReportMetric): ReportMetricView {
  const unit = UNIT_SUFFIX[metric.unit ?? "none"] ?? "";
  const value = availableValue(metric);
  if (value === null) {
    return {
      key: metric.key,
      label: metric.label,
      unit,
      available: false,
      // No value is fabricated for an unavailable metric.
      value: null,
      reason: unavailableReason(metric),
    };
  }
  return {
    key: metric.key,
    label: metric.label,
    unit,
    available: true,
    value: formatMetricValue(value),
    reason: null,
  };
}

/** A human label from a game-defined role (`player1` → `Player 1`). */
export function playerLabel(
  role: string | null | undefined,
  index: number,
): string {
  const raw = typeof role === "string" ? role.trim() : "";
  if (!raw) return `Player ${index + 1}`;
  return raw
    .replace(/(\d+)/g, " $1")
    .trim()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function toAiView(ai: GameReportAi | null | undefined): ReportAiView | null {
  if (!ai) return null;
  if (ai.available === true) {
    return {
      available: true,
      summary: ai.summary,
      model: ai.model ?? null,
      sections: Array.isArray(ai.sections) ? ai.sections : [],
      reason: null,
    };
  }
  const reason = (ai as { reason?: unknown }).reason;
  return {
    available: false,
    summary: null,
    model: null,
    sections: [],
    reason:
      typeof reason === "string" && reason.length > 0
        ? reason
        : "The AI explanation could not be generated.",
  };
}

/** Re-frames a VALIDATED report into the page's view model. */
function viewFromReport(report: GameReportV1): GameReportView {
  return {
    gameKey: report.gameKey,
    analysisType: report.analysisType,
    status: report.status,
    title: ANALYSIS_TITLES[report.analysisType] ?? "Match Report",
    metrics: report.metrics.map(toReportMetricView),
    players: (report.players ?? []).map((player, index) => ({
      playerId: player.playerId,
      role: player.role ?? null,
      label: playerLabel(player.role, index),
      metrics: player.metrics.map(toReportMetricView),
    })),
    ai: toAiView(report.ai),
    unavailableReason: report.unavailableReason ?? null,
  };
}

/**
 * Validates an unknown payload as a `GameReportV1` and maps it to the view.
 *
 * A malformed report returns `{ ok: false, errors }`, so a caller renders an
 * explicit "unreadable report" state instead of guessing at broken data. An
 * `unavailable` report maps cleanly: it has no metrics by construction and
 * carries only the reason.
 */
export function buildGameReportView(value: unknown): GameReportViewResult {
  const parsed = parseGameReportV1(value);
  if (parsed.ok) {
    return { ok: true, view: viewFromReport(parsed.report), errors: [] };
  }
  // The negative branch of the contract's validation union is read through an
  // explicit shape because `strict: false` disables its narrowing.
  const errors = (parsed as { errors?: unknown }).errors;
  return {
    ok: false,
    view: null,
    errors: Array.isArray(errors) ? (errors as string[]) : ["Unreadable report."],
  };
}

/** Whether the mapped report has any objective row worth rendering. */
export function reportViewHasContent(view: GameReportView): boolean {
  return (
    view.metrics.length > 0 ||
    view.players.some((player) => player.metrics.length > 0)
  );
}
