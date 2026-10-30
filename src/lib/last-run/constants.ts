// src/lib/last-run/constants.ts
//
// LAST RUN — the ONE place the run's physics, course and timing numbers live.
// The engine (src/lib/last-run/engine.ts) is a pure function of these values,
// so the server replay and the client's rendering can never disagree about how
// high a jump goes or how far a runner travels.
//
// Units: pixels and seconds in a world where y = 0 is the ground line and y
// grows upward. A "tick" is one fixed simulation step.

/**
 * The game's ONE database identity: `match_lifecycle.game_key`,
 * `last_run_matches`, `player_ratings.game_key`, `rating_events.game_key`,
 * the trophy ladder and the quest catalogue all use this exact string.
 */
export const LAST_RUN_GAME_KEY = "last-run";

/** Fixed simulation rate. Never variable: determinism depends on it. */
export const TICK_HZ = 60;
export const TICK_MS = 1000 / TICK_HZ;
export const DT = 1 / TICK_HZ;

// ── Runner body ─────────────────────────────────────────────────────────
/** Ground line. A runner's feet rest on it. */
export const GROUND_Y = 0;
/** Horizontal body width — the same standing or ducking. */
export const RUNNER_WIDTH = 26;
/** Standing hitbox: tall enough to hit a low beam. */
export const RUNNER_STANDING_HEIGHT = 44;
/** Ducking hitbox: low enough to pass under a beam, still hit by a spike. */
export const RUNNER_DUCK_HEIGHT = 26;

// ── Jump arc ────────────────────────────────────────────────────────────
// Constant-velocity takeoff under constant gravity: airtime 0.576 s, apex
// 141 px. Both numbers are DERIVED, never asserted twice, so tuning one value
// moves the arc and the fairness budget together.
/** Downward acceleration, px/s² (positive = toward the ground). */
export const GRAVITY = 3400;
/** Upward takeoff speed, px/s. */
export const JUMP_VELOCITY = 980;
/** How long the runner is off the ground for a full jump, seconds. */
export const JUMP_AIRTIME_S = (2 * JUMP_VELOCITY) / GRAVITY;
/** Peak height above the ground line, px. */
export const JUMP_APEX_PX = (JUMP_VELOCITY * JUMP_VELOCITY) / (2 * GRAVITY);

// ── Speed curve ─────────────────────────────────────────────────────────
/** World speed at the first tick, px/s. */
export const START_SPEED = 260;
/** Hard ceiling. Reached at (MAX_SPEED - START_SPEED) / SPEED_RAMP seconds. */
export const MAX_SPEED = 640;
/** Linear acceleration, px/s per second. */
export const SPEED_RAMP = 12;
/** Seconds until the speed ceiling is reached. */
export const SPEED_RAMP_SECONDS = (MAX_SPEED - START_SPEED) / SPEED_RAMP;

// ── Course ──────────────────────────────────────────────────────────────
/** The course is generated for this long. A run cannot outlive it. */
export const COURSE_DURATION_S = 75;
/** A match is force-resolved after this long, even if nobody has crashed. */
export const MATCH_MAX_MS = COURSE_DURATION_S * 1000;
/** No obstacle before this instant, so a run always opens on clear ground. */
export const FIRST_OBSTACLE_AT_S = 1.35;
/** The gap between obstacles shrinks from this to the floor below. */
export const GAP_START_S = 1.95;
export const GAP_FLOOR_S = 1.12;
/** Seconds of ramp over which the gap tightens to its floor. */
export const GAP_RAMP_S = 44;
/** Extra clearance added after a duck obstacle, seconds. */
export const GAP_AFTER_BEAM_S = 0.3;
/** No two consecutive obstacles may be closer than this, seconds. */
export const MIN_OBSTACLE_GAP_S = 0.92;
/** The same obstacle kind never repeats more than this many times in a row. */
export const MAX_KIND_RUN = 2;

// ── Obstacle geometry ───────────────────────────────────────────────────
export type ObstacleKind = "crate" | "spike" | "beam";

/**
 * The three readable shapes:
 *   crate — a low solid block, jumped.
 *   spike — a short, sharp hazard, jumped (ducking is not enough).
 *   beam  — a floating bar; standing into it is a hit, ducking passes under.
 */
export const OBSTACLE_SPECS: Record<
  ObstacleKind,
  { width: number; height: number; minY: number }
> = {
  crate: { width: 34, height: 34, minY: 0 },
  spike: { width: 30, height: 20, minY: 0 },
  // Beam underside at 42 px: a standing 44 px body overlaps it by 2 px, a
  // ducking 26 px body clears it by 16 px. That margin is deliberate — a
  // beam is a duck test, not a pixel test.
  beam: { width: 56, height: 46, minY: 42 },
};

/** A beam's underside, exposed for tests and for the renderer. */
export const BEAM_UNDERSIDE_Y = OBSTACLE_SPECS.beam.minY;

// ── Match lifecycle ─────────────────────────────────────────────────────
/** Pre-match 3–2–1. The server owns this instant; the client only displays it. */
export const COUNTDOWN_MS = 3200;
/** How far ahead of the server's simulated tick a received input is scheduled. */
export const INPUT_LEAD_TICKS = 4;
/** Per-seat input rate ceiling (transitions per second). */
export const MAX_INPUTS_PER_SECOND = 24;
/** A seat silent for longer than this is forfeited (platform disconnect policy). */
export const DISCONNECT_GRACE_MS = 10_000;
/** How long a player may sit in the queue before the entry is pruned. */
export const QUEUE_TTL_MS = 90_000;
/** Snapshots may not carry more than this many obstacles. */
export const SNAPSHOT_MAX_OBSTACLES = 14;
/** How far behind a runner a snapshot's obstacle window starts, px. */
export const SNAPSHOT_BEHIND_PX = 120;
/** How far ahead of the leading runner a snapshot's obstacle window ends, px. */
export const SNAPSHOT_AHEAD_PX = 2600;

// ── Seats ───────────────────────────────────────────────────────────────
export type Seat = "player1" | "player2";
export const SEATS: readonly Seat[] = ["player1", "player2"] as const;

export function otherSeat(seat: Seat): Seat {
  return seat === "player1" ? "player2" : "player1";
}
