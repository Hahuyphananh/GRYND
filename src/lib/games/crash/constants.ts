/**
 * Crash game constants — shared by the provably-fair Crash Arena.
 *
 * These define the range of possible crash multipliers.
 * The seed-based generator (generateCrashPoint) uses these bounds
 * so payouts are consistent.
 */

// ---------------------------------------------------------------------------
// Crash curve (piecewise linear — mirrors src/lib/crash-poker/constants.js).
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
export const CRASH_CURVE_SEGMENTS: readonly { toMultiplier: number; rate: number }[] = [
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
export interface CrashCurveSegment {
  fromMultiplier: number;
  fromTime: number;
  rate: number;
  toMultiplier: number;
  atTime: number;
}

export const CRASH_CURVE_TIMELINE: CrashCurveSegment[] = (() => {
  let fromTime = 0;
  let fromMultiplier = 1;
  return CRASH_CURVE_SEGMENTS.map((seg) => {
    const duration =
      (seg.toMultiplier - fromMultiplier) / seg.rate;
    const entry: CrashCurveSegment = {
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
 * Pinned at 1.00x for t ≤ 0; beyond the last segment it keeps climbing
 * at the final slope.
 */
export function crashMultiplierAtTime(t: number): number {
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
 */
export function timeToCrashMultiplier(m: number): number {
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

/** Minimum crash multiplier. */
export const CRASH_MIN = 1.2;

/** Maximum crash multiplier. */
export const CRASH_MAX = 9.2;

/** Range = MAX − MIN (used for scaling). */
export const CRASH_RANGE = CRASH_MAX - CRASH_MIN; // 8.0

/** Standard Crash Arena table wagers (lobby quick-pick presets). */
export const CRASH_WAGERS = [1, 5, 10, 25, 50, 100];

/** Minimum wager allowed when creating a table. */
export const CRASH_MIN_WAGER = 1;

/** Minimum buy-in is always 5× the round wager. */
export const CRASH_MIN_BUYIN_MULTIPLIER = 5;

/**
 * Hard cap on a single Crash Arena buy-in (tokens).
 *
 * A player can theoretically put their whole balance in, so every buy-in
 * (initial join or top-up) is clamped to 1,000,000 tokens (~10x the max
 * table wager; must match the global cap economy).
 */
export const CRASH_MAX_BUYIN = 1_000_000;

/**
 * Hard cap on a Crash Arena table's round wager (tokens), applied in the
 * lobby's Create Table wager input. Prevents runaway wagers (e.g. the full
 * balance) when creating a table.
 */
// Must match GLOBAL_MAX_BET in src/lib/games/economy.ts.
export const CRASH_MAX_WAGER = 100_000;
