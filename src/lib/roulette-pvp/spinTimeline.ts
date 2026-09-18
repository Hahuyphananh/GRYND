// ── Roulette PvP — the wheel + ball spin timeline ────────────────────────────
//
// Pure motion maths for the canvas spin. No React, no server state, no
// randomness of its own: the same plan always produces the same frames, so the
// page can own the `requestAnimationFrame` loop, the canvas and the
// cancellation while this file only answers one question —
// "at `elapsedMs` into the spin, where is the wheel and where is the ball?".
//
// The winning pocket is an INPUT (`finalIndex`), taken verbatim from the
// server (`match.lastSpinResultIndex`) by the caller. This module never picks a
// result; it only works out how the wheel travels from wherever it currently
// rests to the angle that parks that pocket under the fixed pointer, and how
// the ball drops into it.
//
// ── Why a velocity profile instead of a single ease curve ───────────────────
//
// The previous implementation was one monotonic cubic ease-out over a
// hard-coded 4500 ms with 7 wheel rotations: velocity peaked on frame 1 (the
// wheel appeared to teleport into motion), and the last third crawled to a
// stop. This module integrates a small piecewise velocity profile instead —
//
//   QUICK ACCELERATION → FAST SUSTAINED SPIN → CONTROLLED DECELERATION →
//   FINAL APPROACH → TINY SETTLE
//
// — and normalises it so the wheel still arrives at EXACTLY the server's
// pocket (the profile is positive everywhere, so the curve is monotone, and
// `profilePosition(1) === 1` by construction: the destination is exact no
// matter how the phases are tuned).
//
// Phases (fractions of the total duration, `WHEEL_PROFILE` / `BALL_PROFILE`):
//
//   accelerate   0    → 0.14 / 0.09   wheel spins up from a standing start
//   cruise       0.14 → 0.52 / 0.46   fast, consistent, visibly a spin
//   decelerate   0.52 → 0.80 / 0.78   speed bleeds off smoothly
//   approach     0.80 → 0.965 / 0.965 the last 600–800 ms still MOVE (~140°
//                                     of wheel) instead of crawling
//   settle       0.965 → 1            ~150 ms: a small overshoot past the
//                                     pocket, then rock back onto it
//
// The settle is what removes the old "single hard final frame". It is driven
// by `smoothstep` — zero velocity at both ends — so the wheel comes to rest on
// the pocket without a jolt, and the extra rotation is subtracted again before
// the frame is reported. The final drawn angle is therefore congruent
// (mod 2π) with the angle that puts the server's pocket under the pointer, for
// any phase tuning.

/** Visible groove the ball rolls in while the wheel spins (canvas px, pre-scale). */
export const BALL_TRACK_RADIUS = 195;
/** Where the ball comes to rest — inboard of the pocket labels, inside the win ring. */
export const BALL_POCKET_RADIUS = 164;
/** How long the reduced-motion path holds the final frame before resolving. */
export const REDUCED_MOTION_DURATION_MS = 220;

/** Wheel overshoot past the winning pocket before it rocks back (radians, ≈1.1°). */
export const WHEEL_OVERSHOOT = 0.02;
/** Ball overshoot past the pointer before it settles back into the pocket (≈3.2°). */
export const BALL_OVERSHOOT = 0.055;
/** How much deeper the ball sinks at the middle of the settle beat (canvas px). */
export const BALL_SETTLE_DIP = 3;

/** The settle beat, as a fraction of the total duration (~150 ms of a 4.3 s spin). */
const SETTLE_FRACTION = 0.035;
/** Point in the (main-phase) spin where the ball is out on the track. */
const BALL_LAUNCH_END = 0.12;
/** Point in the (main-phase) spin where the ball leaves the outer track. */
const BALL_DROP_START = 0.66;
/** Point in the (main-phase) spin where the ball reaches the pocket radius. */
const BALL_DROP_END = 1;

const TWO_PI = Math.PI * 2;

/**
 * A piecewise velocity profile, in normalised-time units:
 *
 *   [0, a]   velocity ramps 0 → 1 (linear)
 *   [a, b]   velocity holds at 1 (the cruise)
 *   [b, c]   velocity eases 1 → r
 *   [c, 1]   velocity eases r → rf
 *
 * `rf` stays above zero so the final approach is still visibly moving; the
 * settle beat below takes the motion to a genuine stop.
 */
export interface VelocityProfile {
  a: number;
  b: number;
  c: number;
  r: number;
  rf: number;
  /** ∫₀¹ velocity — the normaliser that makes `profilePosition(1) === 1`. */
  den: number;
}

export type SpinPhase =
  | "accelerate"
  | "cruise"
  | "decelerate"
  | "approach"
  | "settle"
  | "reduced";

/** One sampled frame of the spin. Angles are absolute canvas radians. */
export interface SpinFrame {
  wheelAngle: number;
  ballAngle: number;
  ballDist: number;
  /** Normalised progress through the timeline, 0 → 1. */
  progress: number;
  phase: SpinPhase;
  /** True on the frame that parks the wheel on the server's pocket. */
  finished: boolean;
}

export interface SpinPlanInput {
  /** Server-provided winning pocket index (0–36). Never recomputed here. */
  finalIndex: number;
  /** Angle of one pocket, `2π / ROULETTE_NUMBERS.length`. */
  segmentAngle: number;
  /** Screen angle of the fixed pointer (the wheel is parked so the pocket lands here). */
  pointerAngle: number;
  /** The wheel angle currently on screen, so the next spin never snaps back to 0. */
  startAngle?: number;
  /** The ball angle currently on screen (null before the first spin). */
  ballStartAngle?: number | null;
  /** Sanctioned source of per-round variation (the spin fingerprint). */
  seed?: string | number | null;
  /** Skip the physical spin and just show the final position. */
  reducedMotion?: boolean;
}

export interface SpinPlan {
  finalIndex: number;
  reducedMotion: boolean;
  durationMs: number;
  settleFraction: number;
  /** Pocket math (kept for tests/debugging; the motion below is derived from it). */
  targetAngle: number;
  winningCenter: number;

  wheelStartAngle: number;
  wheelDelta: number;
  wheelMainEndAngle: number;
  /** Angle the wheel is drawn at when it comes to rest (≡ targetAngle, mod 2π). */
  wheelRestAngle: number;
  wheelOvershoot: number;
  wheelTurns: number;
  wheelProfile: VelocityProfile;

  ballStartAngle: number;
  ballDelta: number;
  ballMainEndAngle: number;
  /** Angle the ball is drawn at when it comes to rest (≡ pointerAngle, mod 2π). */
  ballRestAngle: number;
  ballOvershoot: number;
  ballTurns: number;
  ballProfile: VelocityProfile;
  ballTargetAngle: number;

  ballTrackRadius: number;
  ballPocketRadius: number;
  ballLaunchEnd: number;
  ballDropStart: number;
  ballDropEnd: number;
}

/** Fast, slightly later cruise; a ball that keeps its momentum longer than the wheel. */
const WHEEL_PROFILE: Omit<VelocityProfile, "den"> = {
  a: 0.14,
  b: 0.52,
  c: 0.8,
  r: 0.28,
  rf: 0.1,
};
const BALL_PROFILE: Omit<VelocityProfile, "den"> = {
  a: 0.09,
  b: 0.46,
  c: 0.78,
  r: 0.34,
  rf: 0.13,
};

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

/** 3t² − 2t³ — zero velocity at both ends, so nothing jerks in or out of the beat. */
const smoothstep = (t: number) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

const normAngle = (a: number) => ((a % TWO_PI) + TWO_PI) % TWO_PI;

function withDenominator(p: Omit<VelocityProfile, "den">): VelocityProfile {
  // The integral of the whole profile: ramp, cruise, decel and approach legs.
  const den =
    p.a / 2 +
    (p.b - p.a) +
    ((p.c - p.b) * (1 + p.r)) / 2 +
    ((1 - p.c) * (p.r + p.rf)) / 2;
  return { ...p, den };
}

/**
 * Integrated position at normalised time `s`, normalised so `profilePosition(1)`
 * is exactly 1 — every phase boundary is the analytic integral of the velocity
 * segment, so the curve is monotone and lands on the target by construction.
 */
export function profilePosition(s: number, p: VelocityProfile): number {
  if (s <= 0) return 0;
  if (s >= 1) return 1;
  if (s < p.a) return s * s / (2 * p.a) / p.den;
  if (s < p.b) return (p.a / 2 + (s - p.a)) / p.den;
  if (s < p.c) {
    const q = (s - p.b) / (p.c - p.b);
    const ramp = q + (p.r - 1) * (q * q * q - (q * q * q * q) / 2);
    return (p.a / 2 + (p.b - p.a) + (p.c - p.b) * ramp) / p.den;
  }
  const q = (s - p.c) / (1 - p.c);
  const ramp = p.r * q + (p.rf - p.r) * (q * q * q - (q * q * q * q) / 2);
  return (
    (p.a / 2 + (p.b - p.a) + ((p.c - p.b) * (1 + p.r)) / 2 + (1 - p.c) * ramp) /
    p.den
  );
}

function phaseAt(s: number, p: VelocityProfile): SpinPhase {
  if (s < p.a) return "accelerate";
  if (s < p.b) return "cruise";
  if (s < p.c) return "decelerate";
  return "approach";
}

/** FNV-1a → mulberry32: the per-round variation, reproducible from the spin fingerprint. */
function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build the timeline for one spin.
 *
 * Deterministic given its inputs: the same `seed` and `finalIndex` (and the
 * same current angles) produce the same duration, the same rotation counts and
 * the same frames. The `seed` only varies the *shape* of the motion — never the
 * destination, which is always the server's pocket.
 */
export function createSpinPlan(input: SpinPlanInput): SpinPlan {
  const {
    finalIndex,
    segmentAngle,
    pointerAngle,
    reducedMotion = false,
  } = input;

  const rnd = mulberry32(hashSeed(`${input.seed ?? ""}|${finalIndex}`));

  const startAngle = Number.isFinite(input.startAngle)
    ? (input.startAngle as number)
    : 0;
  const ballStartAngle =
    input.ballStartAngle != null && Number.isFinite(input.ballStartAngle)
      ? normAngle(input.ballStartAngle)
      : normAngle(pointerAngle + (rnd() - 0.5) * 1.2);

  // Per-round variation: a 4.05–4.65 s spin, 7–8 wheel rotations and 9–11
  // counter-rotations of the ball, so no two rounds are cut from the same cloth.
  const durationMs = reducedMotion ? REDUCED_MOTION_DURATION_MS : 4050 + rnd() * 600;
  const wheelTurns = 7 + Math.floor(rnd() * 2);
  const ballTurns = 9 + Math.floor(rnd() * 3);

  // ── Wheel: parked so the server's pocket sits under the fixed pointer ──
  // (Unchanged destination maths: the pocket centre is `index * segment + half
  // a segment`, and the wheel angle that brings it to the pointer is
  // `pointerAngle - centre`. Only the journey there is new.)
  const winningCenter = finalIndex * segmentAngle + segmentAngle / 2;
  const targetAngle = normAngle(pointerAngle - winningCenter);

  // Travel to a hair PAST the target, then let the settle beat rock back onto
  // it. `normAngle(...)` is in [0, 2π) so the whole delta stays positive and
  // the wheel only ever turns forwards.
  const wheelMainTarget = targetAngle + WHEEL_OVERSHOOT;
  const wheelDelta =
    TWO_PI * wheelTurns + normAngle(wheelMainTarget - startAngle);
  const wheelMainEndAngle = startAngle + wheelDelta;
  const wheelRestAngle = wheelMainEndAngle - WHEEL_OVERSHOOT;

  // ── Ball: counter-rotating, and it keeps moving for the whole spin ──
  // The old code froze the ball's angular motion at 78 % and jumped it to the
  // pointer. Here the ball travels a whole number of counter-rotations PLUS
  // whatever it takes to arrive just past the pointer, so its angle stays
  // continuous from launch to landing and it only comes to rest in the settle.
  //
  // Note the direction of the modular difference: the ball's angle DECREASES,
  // so its travel is `-(whole rotations + norm(ballStart − destination))`.
  // Subtracting `norm(destination − ballStart)` instead (as an increase-shaped
  // delta would) lands a whole `2·norm(...)` away from the pocket.
  const ballTargetAngle = pointerAngle;
  const ballMainTarget = ballTargetAngle - BALL_OVERSHOOT;
  const ballDelta = -(
    TWO_PI * ballTurns + normAngle(ballStartAngle - ballMainTarget)
  );
  const ballMainEndAngle = ballStartAngle + ballDelta;
  const ballRestAngle = ballMainEndAngle + BALL_OVERSHOOT;

  return {
    finalIndex,
    reducedMotion,
    durationMs,
    settleFraction: SETTLE_FRACTION,
    targetAngle,
    winningCenter,
    wheelStartAngle: startAngle,
    wheelDelta,
    wheelMainEndAngle,
    wheelRestAngle,
    wheelOvershoot: WHEEL_OVERSHOOT,
    wheelTurns,
    wheelProfile: withDenominator(WHEEL_PROFILE),
    ballStartAngle,
    ballDelta,
    ballMainEndAngle,
    ballRestAngle,
    ballOvershoot: BALL_OVERSHOOT,
    ballTurns,
    ballProfile: withDenominator(BALL_PROFILE),
    ballTargetAngle,
    ballTrackRadius: BALL_TRACK_RADIUS,
    ballPocketRadius: BALL_POCKET_RADIUS,
    ballLaunchEnd: BALL_LAUNCH_END,
    ballDropStart: BALL_DROP_START,
    ballDropEnd: BALL_DROP_END,
  };
}

/** The frame the spin ends on — the wheel on the server's pocket, ball at rest. */
export function restingFrame(plan: SpinPlan): SpinFrame {
  return {
    wheelAngle: plan.wheelRestAngle,
    ballAngle: plan.ballRestAngle,
    ballDist: plan.ballPocketRadius,
    progress: 1,
    phase: plan.reducedMotion ? "reduced" : "settle",
    finished: true,
  };
}

/**
 * Sample the spin at `elapsedMs`. Clamped at both ends: before the start it is
 * the launch pose, at/after the duration it is the resting frame.
 */
export function sampleSpinFrame(plan: SpinPlan, elapsedMs: number): SpinFrame {
  if (plan.reducedMotion) {
    // Reduced motion: no physical spin at all. The wheel and the ball are
    // painted directly in the server's final position and held for a short
    // beat, so the normal result lifecycle (reveal → banner → `spinning`
    // false) still runs on the same clock as a full spin.
    return {
      ...restingFrame(plan),
      finished: elapsedMs >= plan.durationMs,
    };
  }

  const raw = plan.durationMs > 0 ? elapsedMs / plan.durationMs : 1;
  const progress = clamp01(raw);
  const finished = raw >= 1;
  const settleFrom = 1 - plan.settleFraction;
  const sMain = Math.min(progress, settleFrom) / settleFrom;

  if (progress < settleFrom) {
    const wheelAngle =
      plan.wheelStartAngle +
      plan.wheelDelta * profilePosition(sMain, plan.wheelProfile);
    const ballAngle =
      plan.ballStartAngle +
      plan.ballDelta * profilePosition(sMain, plan.ballProfile);

    // The ball rides the outer track through the fast part of the spin, then
    // spirals in as its speed bleeds off — so the drop reads as centrifugal
    // decay rather than the old float inward. The launch arc puts it back out
    // on the track from wherever it was resting, so a new spin never pops the
    // ball 30 px outwards on the first frame.
    let ballDist;
    if (sMain < plan.ballLaunchEnd) {
      const launch = smoothstep(sMain / plan.ballLaunchEnd);
      ballDist =
        plan.ballPocketRadius +
        (plan.ballTrackRadius - plan.ballPocketRadius) * launch;
    } else {
      const drop = clamp01(
        (sMain - plan.ballDropStart) / (plan.ballDropEnd - plan.ballDropStart),
      );
      ballDist =
        plan.ballTrackRadius -
        (plan.ballTrackRadius - plan.ballPocketRadius) * smoothstep(drop);
    }

    return {
      wheelAngle,
      ballAngle,
      ballDist,
      progress,
      phase: phaseAt(sMain, plan.wheelProfile),
      finished,
    };
  }

  // ── Settle beat: a tiny overshoot, then rock back onto the pocket ──
  const tau = clamp01((progress - settleFrom) / plan.settleFraction);
  const beat = smoothstep(tau);
  return {
    wheelAngle: plan.wheelMainEndAngle - plan.wheelOvershoot * beat,
    ballAngle: plan.ballMainEndAngle + plan.ballOvershoot * beat,
    // A couple of pixels deeper mid-beat, then back to the pocket radius:
    // sin²(πτ) is zero (and flat) at both ends of the beat.
    ballDist:
      plan.ballPocketRadius -
      BALL_SETTLE_DIP * Math.sin(Math.PI * tau) * Math.sin(Math.PI * tau),
    progress,
    phase: "settle",
    finished,
  };
}
