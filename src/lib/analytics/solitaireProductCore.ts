// src/lib/analytics/solitaireProductCore.ts
//
// Pure metric maths for the Solitaire product dashboard. Kept free of SQL,
// fetch and React so every formula can be tested directly — the window bounds,
// the funnel arithmetic, retention and the latencies are the numbers a product
// decision rests on.
//
// TIMEZONE: every window is a half-open UTC range [start, end). "Last 7 days"
// ends at the start of tomorrow in UTC, so today is included exactly once and a
// day boundary is never counted in two windows.

export type MetricRange = {
  start: Date;
  end: Date;
  days: number;
};

/** Start of the UTC day containing `date`. */
export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * [start, end) covering `days` whole UTC days ending with today.
 * `end` is exclusive: the first instant of tomorrow (UTC).
 */
export function utcRange(days: number, now: Date = new Date()): MetricRange {
  const end = startOfUtcDay(now);
  end.setUTCDate(end.getUTCDate() + 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  return { start, end, days };
}

/** The equally-sized window immediately before `range`. */
export function previousRange(range: MetricRange): MetricRange {
  const end = new Date(range.start);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - range.days);
  return { start, end, days: range.days };
}

/** UTC day key, YYYY-MM-DD — the join key for cohorts. */
export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Whole UTC days between two instants (floor). */
export function utcDaysBetween(from: Date, to: Date): number {
  return Math.floor((startOfUtcDay(to).getTime() - startOfUtcDay(from).getTime()) / 86_400_000);
}

export function percent(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return (part / whole) * 100;
}

/** Relative change vs the previous period; null when there is no baseline. */
export function changePercent(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

export function completionRate(started: number, completed: number): number | null {
  if (!Number.isFinite(started) || started <= 0) return null;
  return Math.max(0, Math.min(100, (completed / started) * 100));
}

export type FunnelStage = {
  key: string;
  label: string;
  /** Unique users at this stage, or null when the source could not answer. */
  users: number | null;
  previousUsers?: number | null;
};

export type FunnelStep = FunnelStage & {
  conversionFromPrevious: number | null;
  dropOff: number | null;
  /** Absolute change vs the previous period, when both stages have a value. */
  change: number | null;
  changePercent: number | null;
};

/**
 * Funnel arithmetic on UNIQUE USERS.
 *
 * Stage counts are independent (a user who signs up without a landing event is
 * still counted at signup). Conversions are therefore "share of the previous
 * stage", and a stage that exceeds its predecessor is clamped to 100% rather
 * than printed as >100% — the counts come from different emitters and a small
 * overhang is expected. The clamp is applied to the RATE only; the counts are
 * reported exactly as measured.
 */
export function buildFunnel(stages: FunnelStage[]): FunnelStep[] {
  return stages.map((stage, index) => {
    const previous = index === 0 ? null : stages[index - 1];
    const previousUsers = previous?.users ?? null;
    const conversion =
      stage.users === null || previousUsers === null || previousUsers <= 0
        ? null
        : Math.min(100, (stage.users / previousUsers) * 100);
    const dropOff = conversion === null ? null : Math.max(0, 100 - conversion);
    const change =
      stage.users === null || stage.previousUsers === null || stage.previousUsers === undefined
        ? null
        : stage.users - stage.previousUsers;
    const changePct =
      stage.users === null || stage.previousUsers === null || stage.previousUsers === undefined
        ? null
        : changePercent(stage.users, stage.previousUsers);
    return {
      ...stage,
      conversionFromPrevious: conversion,
      dropOff,
      change,
      changePercent: changePct,
    };
  });
}

export type RetentionRow = {
  day: 1 | 7 | 30;
  cohort: number;
  retained: number;
  rate: number | null;
};

/**
 * Retention for a cohort of users first seen in the window, by the day offset
 * of their next qualifying activity. `retained` counts DISTINCT users, so a
 * player active ten times on day 1 counts once.
 */
export function retentionRows(
  cohort: number,
  retained: Record<1 | 7 | 30, number>,
): RetentionRow[] {
  return ([1, 7, 30] as const).map((day) => ({
    day,
    cohort,
    retained: retained[day] ?? 0,
    rate: percent(retained[day] ?? 0, cohort),
  }));
}

/** Linear-interpolation percentile over an ASCENDING array. */
export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const clamped = Math.min(1, Math.max(0, p));
  const index = (sorted.length - 1) * clamped;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  const weight = index - low;
  return sorted[low] * (1 - weight) + sorted[high] * weight;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return percentile(sorted, 0.5);
}

export type OpponentKind = "human" | "recorded" | "ai";

/**
 * A recorded human is NOT a live human. Ghost/recorded opponents are their own
 * category so matchmaking success can never be inflated by replay rows.
 */
export function opponentKind(input: { isAi: boolean; ghost: boolean }): OpponentKind {
  if (input.isAi) return "ai";
  return input.ghost ? "recorded" : "human";
}
