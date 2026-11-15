// src/lib/solitaire-duel/soloTimer.ts
//
// The solo clock, as one pure function.
//
// A solo board is dealt the moment its mode opens, but the player's time does
// not start until they move a card: the opening deal is free to read. That makes
// "how long has this run taken" a function of WHEN THE CLOCK STARTED, which is
// null until the first accepted move, not of when the session was created.
//
// The value is derived from timestamps, never an interval counter, and a
// finished run freezes at the instant it ended. Keeping this here means the HUD,
// the recorded result and the tests all read the same clock.

/**
 * Elapsed run time in milliseconds.
 *
 * `timerStartedAtMs == null` means the first move has not been accepted yet, so
 * the run has taken no time — regardless of how long the deal has been on
 * screen. A missing or malformed end instant falls back to `nowMs`; an end
 * before the start clamps to zero rather than going negative.
 */
export function soloElapsedMs(
  timerStartedAtMs: number | null | undefined,
  endedAtMs: number | null | undefined,
  nowMs: number,
): number {
  if (timerStartedAtMs == null) return 0;
  const start = Number(timerStartedAtMs);
  if (!Number.isFinite(start)) return 0;

  const end = endedAtMs == null ? Number(nowMs) : Number(endedAtMs);
  if (!Number.isFinite(end)) return 0;

  return Math.max(0, end - start);
}
