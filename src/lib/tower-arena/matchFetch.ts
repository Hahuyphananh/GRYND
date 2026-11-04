// src/lib/tower-arena/matchFetch.ts
//
// A rate-limited match read is not a dead match.
//
// The Tower Arena match screen reads GET /api/tower-arena/get-match on every
// socket push and in one bounded six-read burst per stamped turn deadline
// (`useDeadlineRead`). A fast vs-AI duel can put that legitimate pattern over
// the per-user read budget. The limiter answers 429 with a body
// (`{ success: false, error, retryAfterSeconds }`) that has no `ok` flag, so
// the page's generic `if (!data.ok)` branch turned it into "Match unavailable"
// — and `error` was never cleared, so the match stayed dead after the window
// reset.
//
// These helpers hold the retry policy in one testable place: the page keeps
// the board it already has and schedules one re-read for when the limiter says
// it may try again.

/** Fallback when the 429 carries no usable Retry-After. */
export const MATCH_RATE_LIMIT_RETRY_MS = 4_000;

/** Never park a live match behind a limiter for longer than this. */
export const MATCH_RATE_LIMIT_RETRY_MAX_MS = 30_000;

/** The only status this policy treats as "try again later, keep the board". */
export function isRateLimitedMatchRead(status: number): boolean {
  return status === 429;
}

/**
 * Delay before the retry, from `retryAfterSeconds` (the proxy's JSON field) or
 * a `Retry-After` header. Clamped to [1s, 30s] so a malformed or huge value
 * cannot stall the match.
 */
export function rateLimitRetryDelayMs(retryAfter: unknown): number {
  const raw = typeof retryAfter === "string" ? retryAfter.split(",")[0] : retryAfter;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return MATCH_RATE_LIMIT_RETRY_MS;
  return Math.min(
    Math.max(Math.round(seconds * 1000), 1_000),
    MATCH_RATE_LIMIT_RETRY_MAX_MS,
  );
}
