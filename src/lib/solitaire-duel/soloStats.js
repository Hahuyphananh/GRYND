// src/lib/solitaire-duel/soloStats.js
//
// Pure helpers for Solo Solitaire and the Daily Challenge.
//
// CLIENT-SAFE: no crypto, no database, no timezone library. The UTC calendar
// date is the ONLY definition of "a day" in these modes — the API derives it,
// the client renders the date the API returned, and both use these functions so
// a player near midnight cannot create two "today"s.

const DAY_MS = 86_400_000;

/** The UTC calendar date for an instant, as YYYY-MM-DD. */
export function dailyDateKey(nowMs = Date.now()) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Shift a YYYY-MM-DD key by whole UTC days (negative goes back). */
export function shiftDateKey(dateKey, days) {
  const [year, month, day] = String(dateKey).split("-").map(Number);
  if (!year || !month || !day) return dateKey;
  return new Date(Date.UTC(year, month - 1, day) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

const safeMs = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Aggregate solo rows.
 *
 * `games` counts every finished attempt that was recorded; `completed` counts
 * the ones whose replay proved a solved board. A row is never invented: with no
 * rows every figure is null/0 rather than a flattering default.
 */
export function summariseSolo(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const completed = list.filter((row) => row?.completed === true);
  const times = completed.map((row) => safeMs(row?.elapsedMs)).filter(Boolean);
  const totalMoves = list.reduce((sum, row) => sum + (Number(row?.moves) || 0), 0);
  return {
    games: list.length,
    completed: completed.length,
    completionRate:
      list.length > 0 ? Math.round((completed.length / list.length) * 1000) / 10 : null,
    bestMs: times.length > 0 ? Math.min(...times) : null,
    averageMs:
      times.length > 0
        ? Math.round(times.reduce((sum, ms) => sum + ms, 0) / times.length)
        : null,
    totalMoves,
  };
}

/**
 * Aggregate daily rows into the completion count, the current streak and the
 * longest streak. Streaks are calendar-day runs of COMPLETED challenges; a
 * missed day breaks the run.
 *
 * The current streak is anchored to today, or to yesterday when today's
 * challenge is not finished yet (a streak is not broken until a full day is
 * missed — the same rule the app uses for daily rewards).
 */
export function summariseDaily(rows = [], todayKey = dailyDateKey()) {
  const list = Array.isArray(rows) ? rows : [];
  const completedRows = list.filter((row) => row?.completed === true);
  const days = new Set(completedRows.map((row) => String(row?.challengeDate)));
  const todayRow = list.find((row) => String(row?.challengeDate) === todayKey) ?? null;

  let currentStreak = 0;
  let cursor = days.has(todayKey)
    ? todayKey
    : days.has(shiftDateKey(todayKey, -1))
      ? shiftDateKey(todayKey, -1)
      : null;
  while (cursor && days.has(cursor)) {
    currentStreak += 1;
    cursor = shiftDateKey(cursor, -1);
  }

  const ordered = [...days].sort();
  let longestStreak = 0;
  let run = 0;
  let previous = null;
  for (const day of ordered) {
    run = previous && shiftDateKey(previous, 1) === day ? run + 1 : 1;
    if (run > longestStreak) longestStreak = run;
    previous = day;
  }

  const times = completedRows.map((row) => safeMs(row?.elapsedMs)).filter(Boolean);
  return {
    completed: completedRows.length,
    currentStreak,
    longestStreak,
    bestMs: times.length > 0 ? Math.min(...times) : null,
    today: todayRow
      ? {
          completed: todayRow.completed === true,
          moves: Number(todayRow.moves) || 0,
          elapsedMs: safeMs(todayRow.elapsedMs),
        }
      : null,
  };
}

/** `m:ss` (or `h:mm:ss`) for a duration in ms; `—` when unknown. */
export function formatDuration(ms) {
  const value = safeMs(ms);
  if (value === null) return "—";
  const total = Math.floor(value / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
