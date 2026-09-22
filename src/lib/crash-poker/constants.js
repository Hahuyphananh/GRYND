// src/lib/crash-poker/constants.js
//
// Crash Arena v2 — shared game constants.
//
// The multiplier starts at 1.00x and climbs continuously (no betting
// checkpoints): every player posts the table wager as a flat ante, anyone
// can fold at ANY moment, and the hand settles by fold-order ranking —
// the last player to fold (or the sole survivor) takes the biggest share
// of the pot, with linear rank weights and crash victims getting nothing.

// ---------------------------------------------------------------------------
// Crash curve (piecewise linear — mirrors src/lib/games/crash/constants.ts).
// ---------------------------------------------------------------------------
//
// The multiplier is a continuous, slowing climb from 1.00x. Instead of one
// exponential rate it is built from straight segments whose slope RATES get
// gentler as the multiplier rises: fast and readable at the bottom (players
// commit right away), generous and slow at the top (bigger windows to fold
// and to read the private insights revealed at each fold). Crash timing on
// the server (crashDueAtMs) and the curve every client renders both come
// from these two helpers — one source of truth, no drift.
//
// Each segment: `rate` is the multiplier gained per second (slope).
//   from → to    rate     duration    cumulative time
//   1.0 → 1.2    0.60     ~0.33 s     ~0.33 s
//   1.2 → 1.5    0.45     ~0.67 s     ~1.00 s
//   1.5 → 2.0    0.32     ~1.56 s     ~2.56 s
//   2.0 → 3.0    0.20     ~5.00 s     ~7.56 s
//   3.0 → 5.0    0.11     ~18.18 s    ~25.74 s
//   5.0 → 7.0    0.065    ~30.77 s    ~56.51 s
//   7.0 → 9.2    0.05     ~44.00 s    ~100.51 s
//
// The curve MAXES at the last segment's top (9.2x) and extrapolates beyond
// it at the final slope if the hand were ever to run that long.
export const CRASH_CURVE_SEGMENTS = [
  { toMultiplier: 1.2, rate: 0.60 },
  { toMultiplier: 1.5, rate: 0.45 },
  { toMultiplier: 2.0, rate: 0.32 },
  { toMultiplier: 3.0, rate: 0.20 },
  { toMultiplier: 5.0, rate: 0.11 },
  { toMultiplier: 7.0, rate: 0.065 },
  { toMultiplier: 9.2, rate: 0.05 },
];

/**
 * Precomputed curve timeline: one entry per segment carrying its start
 * multiplier/time, slope, and end multiplier/time (`atTime` in seconds from
 * hand start). Built once at load so the hot paths just walk a plain array.
 */
export const CRASH_CURVE_TIMELINE = (() => {
  let fromTime = 0;
  let fromMultiplier = 1;
  return CRASH_CURVE_SEGMENTS.map((seg) => {
    const duration =
      (seg.toMultiplier - fromMultiplier) / seg.rate;
    const entry = {
      fromMultiplier,
      fromTime,
      rate: seg.rate,
      toMultiplier: seg.toMultiplier,
      atTime: fromTime + duration,
    };
    fromMultiplier = seg.toMultiplier;
    fromTime = entry.atTime;
    return entry;
  });
})();

/** Seconds from hand start the curve's last segment ends (~100.51 s). */
export const CRASH_CURVE_MAX_TIME =
  CRASH_CURVE_TIMELINE.length > 0
    ? CRASH_CURVE_TIMELINE[CRASH_CURVE_TIMELINE.length - 1].atTime
    : 0;

/**
 * The multiplier the curve shows at `t` seconds after the hand started.
 * Pinned at 1.00x for t ≤ 0 (the curve never starts early); beyond the last
 * segment it keeps climbing at the final slope.
 *
 * @param {number} t seconds since hand start
 * @returns {number}
 */
export function crashMultiplierAtTime(t) {
  const elapsed = Math.max(0, Number(t) || 0);
  for (const seg of CRASH_CURVE_TIMELINE) {
    if (elapsed <= seg.atTime) {
      return seg.fromMultiplier + seg.rate * (elapsed - seg.fromTime);
    }
  }
  const last = CRASH_CURVE_TIMELINE[CRASH_CURVE_TIMELINE.length - 1];
  if (!last) return 1;
  return last.fromMultiplier + last.rate * (elapsed - last.fromTime);
}

/**
 * Inverse of crashMultiplierAtTime: seconds from hand start at which the
 * curve reaches multiplier `m`. Returns 0 for m ≤ 1 and extrapolates past
 * the last segment's top at the final slope.
 *
 * @param {number} m target multiplier
 * @returns {number}
 */
export function timeToCrashMultiplier(m) {
  const target = Number(m);
  if (!Number.isFinite(target) || target <= 1) return 0;
  for (const seg of CRASH_CURVE_TIMELINE) {
    if (target <= seg.toMultiplier) {
      return seg.fromTime + (target - seg.fromMultiplier) / seg.rate;
    }
  }
  const last = CRASH_CURVE_TIMELINE[CRASH_CURVE_TIMELINE.length - 1];
  if (!last) return 0;
  return last.fromTime + (target - last.fromMultiplier) / last.rate;
}

/**
 * How long the shared curve freezes after EVERY accepted fold, so the whole
 * table gets time to read who folded and their revealed insight before the
 * rocket resumes. The pause is server-authoritative: the crash clock stops
 * (pausedSince/pausedUntil/pausedTotalMs on the hand), the crash-check
 * sweep resumes it and every client freezes until the SAME absolute
 * `pausedUntil` deadline broadcast with the fold.
 *
 * A fold-out (the fold left exactly one active player) uses the SAME window
 * and is settled at that deadline — the action route schedules the
 * settlement, the table's client wakes it, and the crash sweep backstops
 * both. There is deliberately no extra settle grace on top: the hand's
 * outcome is already decided by the fold, so anything longer than this
 * window is just the "settling payouts" card outliving the reveal.
 */
export const FOLD_PAUSE_MS = 3000;

/**
 * Crash multiplier bounds (mirror of src/lib/games/crash/constants.ts —
 * kept here so the plain-JS client-safe modules and tests can import them
 * without a bundler). The seed-based generator picks a crash point in
 * [CRASH_MIN, CRASH_MAX].
 */
export const CRASH_MIN = 1.2;
export const CRASH_MAX = 9.2;

/** Platform fee applied to the pot (same rake as before). */
export const PLATFORM_FEE = 0.05;

/**
 * How long the "next round" countdown lasts once a hand settles (applies to
 * the 2nd+ rounds — the first round after a fresh table counts down locally
 * via `ROUND_START_COUNTDOWN` in ArenaTable.jsx). The settle writes an
 * absolute `next_round_at` deadline on the table row so every client counts
 * down to the SAME wall-clock moment and the round starts exactly on
 * schedule (no per-client drift that could start a hand before a slow
 * client's countdown ends).
 */
export const NEXT_ROUND_COUNTDOWN_MS = 8_000;

/**
 * Delay (ms) before a new round's curve starts climbing — the "hint window"
 * so the local-first player can read their private insights BEFORE the
 * rocket takes off. The round start-route sets `startedAt = now + delay`
 * and every client hides the fold bar and shows the hint popup until the
 * anchor is reached.
 */
export const CRASH_START_DELAY_MS = 5_000;

/** Entry result values used by Crash Arena hands. */
export const RESULT_WON = "won";
export const RESULT_LOST = "lost";
export const RESULT_FOLDED = "folded";
export const RESULT_PENDING = "pending";

/**
 * Round money to 2 decimals (cent precision for all chip math).
 * @param {number} n
 * @returns {number}
 */
export function roundMoney(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}