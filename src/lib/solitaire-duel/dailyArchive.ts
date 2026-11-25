// src/lib/solitaire-duel/dailyArchive.ts
//
// THE PRO DAILY ARCHIVE — pure calendar helpers.
//
// Today's Daily Challenge stays free for everyone. A PAST date is the archive:
// the server derives the same deterministic deal it dealt that day
// (`dailyDealFor`) and only a verified PRO member may ask for it. Nothing here
// decides the entitlement (that is the route's job, from the subscription row);
// this module only answers "is this a real calendar date, and which dates are
// in the window?" so the same rules back the list and the play route.
//
// CLIENT-SAFE: no database, no crypto. `shiftDateKey` is the platform's single
// UTC-date definition, so a viewer in any timezone sees the same archive.

import { shiftDateKey } from "./soloStats.js";

/** Past days the archive panel lists (the server accepts any valid past date). */
export const DAILY_ARCHIVE_DAYS = 30;

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True for a real UTC calendar date in `YYYY-MM-DD` form.
 *
 * A round-trip through `shiftDateKey` is the validity test: `2026-02-31` would
 * roll over to March, so it cannot name a day the server ever dealt.
 */
export function isValidDailyDateKey(value: unknown): value is string {
  const key = String(value ?? "");
  if (!DATE_KEY_PATTERN.test(key)) return false;
  return shiftDateKey(key, 0) === key;
}

/** True when `dateKey` is a valid date strictly before `todayKey`. */
export function isPastDailyDateKey(
  dateKey: unknown,
  todayKey: string,
): boolean {
  return isValidDailyDateKey(dateKey) && dateKey < String(todayKey);
}

/**
 * The archive window, newest first and EXCLUDING today (today is not archived —
 * it is the free challenge and already lives at `/api/solitaire/daily`).
 */
export function dailyArchiveDateKeys(
  todayKey: string,
  days = DAILY_ARCHIVE_DAYS,
): string[] {
  const requested = Number(days);
  const count = Number.isFinite(requested)
    ? Math.max(0, Math.min(Math.trunc(requested), 365))
    : DAILY_ARCHIVE_DAYS;
  const keys: string[] = [];
  for (let offset = 1; offset <= count; offset += 1) {
    keys.push(shiftDateKey(todayKey, -offset));
  }
  return keys;
}
