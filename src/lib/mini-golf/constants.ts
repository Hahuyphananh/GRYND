// src/lib/mini-golf/constants.ts
//
// Single source of truth for Mini Golf tuning. The server store, the pure
// simulator, the course generator and the renderer all import from here so
// there is exactly one place to change a value.
//
// Tuning lineage (kept intentionally close to the references so the three
// games feel consistent, without copying pool/plinko-specific mechanics):
//   • linear per-substep damping + a hard stop threshold — from
//     `src/lib/pool/physics.ts` (FRICTION / STOP_EPSILON)
//   • adaptive substepping + path downsampling/dedup — from
//     `src/lib/plinko-pvp/physics.js` (SUBSTEP_MAX_PX / PATH_DOWNSAMPLE)

// Type-only import: `types.ts` never imports this module, so there is no
// runtime cycle — only the tier union is shared.
import type { HoleDifficulty } from "./types";

// ──────────────────────────────────────────────────────────────────────────
// Geometry
// ──────────────────────────────────────────────────────────────────────────

/** Playable area of one hole, in px. A hole is a closed rectangle. */
export const COURSE_WIDTH = 400;
export const COURSE_HEIGHT = 560;

export const BALL_RADIUS = 7;
export const CUP_RADIUS = 14;

/** Distance from the bottom/top edge the tee and cup are placed at. */
export const TEE_INSET_Y = 55;
export const CUP_INSET_Y = 70;

// ──────────────────────────────────────────────────────────────────────────
// Shot input
// ──────────────────────────────────────────────────────────────────────────

export const POWER_MIN = 0;
export const POWER_MAX = 100;

/** power → initial speed. power 100 ⇒ 24 px/frame. */
export const POWER_SCALE = 0.24;

/** Largest legal initial speed, exported for tests/sanity checks. */
export const MAX_SHOT_SPEED = POWER_MAX * POWER_SCALE;

// ──────────────────────────────────────────────────────────────────────────
// Simulation
// ──────────────────────────────────────────────────────────────────────────

/** Velocity retained per frame (linear damping). */
export const FRICTION = 0.978;

/** Normal-direction energy retained when bouncing off a wall. */
export const WALL_RESTITUTION = 0.72;

/** Normal-direction energy retained when bouncing off a circular bumper. */
export const BUMPER_RESTITUTION = 0.85;

/** Below this speed the ball is considered stopped and velocity snaps to 0. */
export const STOP_EPSILON = 0.05;

/** Hard safety cap on simulated frames. A shot that hits it is force-settled. */
export const MAX_FRAMES = 3000;

/** Max travel per substep, to stop tunneling through thin walls. */
export const SUBSTEP_MAX_PX = 4;

/** Record a path point every Nth substep. */
export const PATH_DOWNSAMPLE = 3;

/** Drop consecutive path points closer than this (px), per axis. */
export const PATH_DEDUP_TOLERANCE = 0.75;

/** Max passes resolving wall/bumper overlaps per substep (corners need > 1). */
export const MAX_COLLISION_ITERATIONS = 4;

/** A ball must be slower than this to drop into the cup. */
export const CAPTURE_MAX_SPEED = 6;

// ──────────────────────────────────────────────────────────────────────────
// Hazards
// ──────────────────────────────────────────────────────────────────────────

/** Per-frame velocity multiplier while the ball is inside a sand patch. */
export const SAND_FRICTION = 0.9;

// ──────────────────────────────────────────────────────────────────────────
// Course
// ──────────────────────────────────────────────────────────────────────────

/**
 * Bump when the generator's output shape changes. Stored on the match row so
 * a match created before a generator change still replays the same course.
 *
 * v2 — the controlled 10-template generator with difficulty ramping and
 *      geometric + reachability validation replaced the original 5 templates.
 */
export const COURSE_VERSION = 2;

/** Every match is 5 holes. */
export const HOLE_COUNT = 5;

/** First player to win 3 holes wins the match. */
export const HOLES_TO_WIN = 3;

/**
 * The controlled hole-template registry. Generation NEVER invents arbitrary
 * geometry — every hole is one of these primitives with bounded randomized
 * parameters (see src/lib/mini-golf/courseTemplates.ts).
 *
 * Ordered easy → hard; each template's intrinsic level lives on its
 * descriptor, and the generator picks templates compatible with the hole's
 * target difficulty tier rather than cycling the list.
 */
export const HOLE_TEMPLATES = [
  "straight",
  "long-distance",
  "central-obstacle",
  "l-shape",
  "multiple-obstacles",
  "narrow-corridor",
  "split-path",
  "u-shape",
  "zig-zag",
  "wall-bounce",
] as const;

export type HoleTemplate = (typeof HOLE_TEMPLATES)[number];

// ──────────────────────────────────────────────────────────────────────────
// Difficulty
// ──────────────────────────────────────────────────────────────────────────
//
// Five tiers, one per hole, in ascending order. `HOLE_COUNT` equals the ramp
// length so a match is always dealt exactly one hole per tier — the player
// never gets five near-impossible holes — while the generator's per-hole tier
// jitter keeps consecutive matches from feeling identical.

export const DIFFICULTY_RAMP = [
  "easy",
  "easy-medium",
  "medium",
  "medium-hard",
  "hard",
] as const;

/** Numeric level (1–5) for each tier. Templates declare the same scale. */
export const HOLE_DIFFICULTY_LEVELS: Record<HoleDifficulty, number> = {
  easy: 1,
  "easy-medium": 2,
  medium: 3,
  "medium-hard": 4,
  hard: 5,
};

// ──────────────────────────────────────────────────────────────────────────
// Generation + validation budgets
// ──────────────────────────────────────────────────────────────────────────

/**
 * Bounded deterministic re-rolls per hole. On exhaustion the generator falls
 * back to the canonical straight layout, which is valid by construction, so
 * a match can never be dealt an unplayable hole.
 */
export const MAX_HOLE_GENERATION_ATTEMPTS = 12;

/**
 * Grid cell size (px) for the reachability flood fill. The world is
 * discretized and a cell is "free" when the ball's centre can occupy it
 * without overlapping any wall; tee/cup connectivity over free cells is the
 * deterministic reachability criterion.
 */
export const REACHABILITY_CELL = 5;

/**
 * A hole must expose at least this many free, reachable ball positions.
 * Catches degenerate holes that are technically connected but effectively
 * unplayable.
 */
export const MIN_REACHABLE_CELLS = 220;

/**
 * Minimum clear width for any channel the ball must fit through. Two
 * non-touching walls closer than this create a pinch the ball cannot pass,
 * which is impossible geometry — rejected.
 */
export const MIN_CHANNEL_WIDTH = BALL_RADIUS * 4;

/** Minimum centre-to-centre clearance between two separately placed obstacles. */
export const MIN_OBSTACLE_GAP = BALL_RADIUS;

// ──────────────────────────────────────────────────────────────────────────
// Match status
// ──────────────────────────────────────────────────────────────────────────
//
// Mirrors the shape used by the other PvP games (ready → playing → terminal)
// so the shared lobby/turn conventions carry over unchanged.

export const MATCH_STATUS = Object.freeze({
  WAITING: "waiting",
  READY: "ready",
  PLAYING: "playing",
  FINISHED: "finished",
  CANCELLED: "cancelled",
});

/** States in which a shot may be accepted. */
export const SHOOTABLE_STATUSES = new Set<string>([MATCH_STATUS.PLAYING]);

/**
 * Advisory-lock namespace for the Mini Golf matchmaking lock (the ASCII bytes
 * "MGLF"). Scoped per-game so a Mini Golf transaction can never contend with
 * another game's lobby lock.
 */
export const MINI_GOLF_LOCK_NAMESPACE = 0x4d474c46;

/**
 * Result vocabulary persisted in `mini_golf_matches.result`. `player1` /
 * `player2` mirror the seat names; `tie` is reachable when the five holes
 * finish without either seat reaching HOLES_TO_WIN.
 */
export const RESULT = Object.freeze({
  PLAYER1: "player1",
  PLAYER2: "player2",
  TIE: "tie",
});

/** Terminal states — no further transitions are possible. */
export const TERMINAL_STATUSES = new Set<string>([
  MATCH_STATUS.FINISHED,
  MATCH_STATUS.CANCELLED,
]);

/** Stable internal identity for free human-vs-AI matches. Never rated. */
export const MINI_GOLF_AI_PLAYER_ID = "mini_golf_ai_bot";
