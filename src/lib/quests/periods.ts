// src/lib/quests/periods.ts
//
// UTC period identities for quests. A quest slot belongs to exactly one period,
// and that period is identified by a string key stored in
// `user_quests.period_key`:
//
//   daily   → "YYYY-MM-DD"  (the UTC calendar day)
//   weekly  → "YYYY-Www"    (the ISO-8601 week, Monday-based, UTC)
//
// Both keys are fixed-width and sortable, both fit the column's VARCHAR(12),
// and both are computed from the clock alone — never from the player's locale
// or device timezone. Two clients in different timezones therefore agree on
// which day/week a match belongs to, which is what makes the slot identity
// deterministic.
//
// Monday is deliberately the weekly boundary: it is what ISO-8601 means, what
// the platform's `user_stats.weekly_*` counters reset on, and it avoids the
// "week starts on Sunday" ambiguity entirely.

import type { QuestPeriodType } from "./types";

const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` in UTC. The daily period key. */
export function utcDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * `YYYY-Www` for the ISO-8601 week containing `now` (UTC).
 *
 * The ISO year is the calendar year of the week's THURSDAY: that is why
 * 2025-12-29 (a Monday) is 2026-W01 — its Thursday is 2026-01-01 — and why
 * 2021-01-01 (a Friday) is 2020-W53.
 */
export function utcWeekKey(now: Date = new Date()): string {
  const date = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  // ISO weekday: Monday = 1 … Sunday = 7.
  const isoWeekday = date.getUTCDay() || 7;
  // Move to the Thursday of this week; its year is the ISO week-year.
  date.setUTCDate(date.getUTCDate() + 4 - isoWeekday);

  const isoYear = date.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / MS_PER_DAY + 1) / 7);

  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** The period key for `periodType` at `now`. */
export function periodKeyFor(
  periodType: QuestPeriodType,
  now: Date = new Date(),
): string {
  return periodType === "weekly" ? utcWeekKey(now) : utcDayKey(now);
}

/**
 * The half-open instant range `[start, end)` of the period containing `now`.
 *
 * Used for display ("resets in…") and for analytics; the STORED identity is the
 * period key, not this range, so a boundary calculation can never decide which
 * slot a match counts towards.
 */
export function periodBounds(
  periodType: QuestPeriodType,
  now: Date = new Date(),
): { start: Date; end: Date } {
  const dayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );

  if (periodType === "daily") {
    return { start: dayStart, end: new Date(dayStart.getTime() + MS_PER_DAY) };
  }

  // Back up to Monday 00:00 UTC of this ISO week.
  const isoWeekday = dayStart.getUTCDay() || 7;
  const weekStart = new Date(dayStart.getTime() - (isoWeekday - 1) * MS_PER_DAY);
  return { start: weekStart, end: new Date(weekStart.getTime() + 7 * MS_PER_DAY) };
}

/** Narrowing guard for values that arrive from a request or a raw SQL row. */
export function isQuestPeriodType(value: unknown): value is QuestPeriodType {
  return value === "daily" || value === "weekly";
}
