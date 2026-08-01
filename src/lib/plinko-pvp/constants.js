// src/lib/plinko-pvp/constants.js
//
// Shared constants + helpers for the Plinko Duel PvP match system.
// Built as a parallel to `src/lib/mines-pvp/constants.js` and
// `src/lib/blackjack-pvp/constants.js` so the lobby + match flow
// shares the same shape (stake presets / round timer / status
// enum / advisory-lock namespace / 90-10 payout split) while the
// game logic is plinko-specific (5-bucket scoring, deterministic
// server-side ball simulator, per-ball skill inputs).
//
// Single source of truth: every constant the server store, the
// physics simulator, the lobby, and the match view needs lives
// here. `physics.js` imports BUCKETS and the tuning constants
// from this file so there's exactly one place to change a value.

// ──────────────────────────────────────────────────────────────────────────
// Bucket table (5 scoring buckets across the bottom of the 500-wide board)
// ──────────────────────────────────────────────────────────────────────────
//
// x ranges are in svg units. Each bucket is exactly 100px wide. The skill
// shape: edges are "safe" (100 pts), one step in is "precision" (140 pts),
// the center is a "trap" (40 pts). Falling outside [0, 500] = 0 points.
//
// This table is the single source of truth — `physics.js` re-imports it.

export const BUCKETS = Object.freeze([
  Object.freeze({ index: 0, label: "far_left_safe",   xMin: 0,   xMax: 100, basePoints: 100 }),
  Object.freeze({ index: 1, label: "left_precision",  xMin: 100, xMax: 200, basePoints: 140 }),
  Object.freeze({ index: 2, label: "center_trap",     xMin: 200, xMax: 300, basePoints: 40  }),
  Object.freeze({ index: 3, label: "right_precision", xMin: 300, xMax: 400, basePoints: 140 }),
  Object.freeze({ index: 4, label: "far_right_safe",  xMin: 400, xMax: 500, basePoints: 100 }),
]);

// Per-ball maximum possible points (all 3 precision buckets summed — used for
// sanity-checks on the server store's score aggregation). The server store
// should assert `ballPoints <= MAX_BALL_POINTS` on every launch resolution
// to catch bugs in the bucket classifier or physics simulator.
export const MAX_BALL_POINTS = 140;
export const MAX_MATCH_POINTS = MAX_BALL_POINTS * 3; // 420

// ──────────────────────────────────────────────────────────────────────────
// Board geometry + physics tuning constants
// ──────────────────────────────────────────────────────────────────────────
//
// The PvP board shares the same 500x540 svg viewBox as the existing solo
// plinko page (src/app/casino/plinko/page.tsx). Ball spawns at topY, the
// bucket row begins at bucketY, and the fall-out zone is the side gutters
// (x < 0 or x > BOARD.width) once the ball has cleared the top peg row.
//
// Note: the static plinko.svg asset shows a smaller decorative 6-row grid,
// but the actual rendered Plinko board uses 19 rows. The PvP board inherits
// the 19-row layout for visual continuity with the existing game.

export const BOARD = Object.freeze({
  width: 500,
  height: 540,
  topY: 50,       // y where balls spawn (just above the first peg row)
  bucketY: 480,   // y where the bucket row begins (per user spec — y reaches 480)
});

// Peg grid (19 rows, derived from the 19-row triangular layout in
// src/app/casino/plinko/page.tsx).
export const PEG_ROWS = 19;
export const PEG_COLS_BASE = 2;        // row 0 has 2 pegs; row r has r+2
export const PEG_HORIZ_SPACING = 24;   // px between adjacent pegs in the same row
export const PEG_VERT_SPACING = 22;    // px between rows
export const PEG_RADIUS = 3;           // matches the page.jsx rendered peg radius
export const BALL_RADIUS = 6;          // matches the page.jsx rendered ball radius
export const PEG_CENTER_X = 250;       // grid is symmetric around this x

// Per-frame physics (1 frame = 1/60s of simulated time).
export const GRAVITY = 0.35;                              // px / frame^2
export const RESTITUTION = 0.2;                           // peg-bounce energy retention (0..1)
                                                          // Low so the ball cascades down naturally;
                                                          // pegs gently deflect rather than violently
                                                          // rebounding the ball upward.
export const FRICTION = 0.998;                            // velocity damping per substep
export const JITTER_RAD = (2 * Math.PI) / 180;            // ±2° on each bounce
export const MAX_FRAMES = 800;                            // safety cap (no infinite loops)
export const POWER_SCALE = 0.4;                           // power 0..100 → v0 0..40 px/frame
export const ANGLE_LIMIT_DEG = 45;                        // player can swing ±45°
export const SUBSTEP_MAX_PX = 5;                          // max motion per substep
export const PATH_DOWNSAMPLE = 2;                         // record every Nth substep
export const PATH_DEDUP_TOLERANCE = 1.0;                  // px — drop consecutive points closer than this

// Ball-ball collision for the Dual simulation. Higher than peg
// restitution so the two-player interaction (balls knocking each
// other off course) is the visually exciting skill element, while
// peg deflections are a gentle cascade.
export const BALL_COLLISION_RESTITUTION = 0.6;            // energy retention on ball-ball bump
export const BALL_COLLISION_MAX_CORRECTION_PX = 0.5;      // per-substep position fix cap

// ──────────────────────────────────────────────────────────────────────────
// Status state machine
// ──────────────────────────────────────────────────────────────────────────
//
// Seven states. Player1 creates a match (waiting → joins from lobby),
// player2 joins (ready → 3s banner → ball_1), both players commit
// (ball_1 → ball_2 → ball_3), match resolves (→ finished). `cancelled`
// is reachable from any non-terminal state when a player disconnects
// past the grace period (or the host leaves before player2 joins).
//
// These values match the `plinko_pvp_status` pgEnum in src/db/schema.ts
// — do not change one without the other.

export const MATCH_STATUS = Object.freeze({
  WAITING: "waiting",
  READY: "ready",
  BALL_1: "ball_1",
  BALL_2: "ball_2",
  BALL_3: "ball_3",
  FINISHED: "finished",
  CANCELLED: "cancelled",
});

// States where the match is still in progress (not yet terminal).
// `READY` is in this set so /status polls include it, but launches
// are NOT accepted during the brief 3-second "Get ready" banner
// (see LAUNCHABLE_STATES below).
export const ACTIVE_STATES = new Set([
  MATCH_STATUS.READY,
  MATCH_STATUS.BALL_1,
  MATCH_STATUS.BALL_2,
  MATCH_STATUS.BALL_3,
]);

// States where a `launch` action is accepted. `READY` is intentionally
// excluded — it's the brief auto-transition window after both players
// join. `WAITING` is excluded (no opponent yet). `FINISHED` /
// `CANCELLED` are terminal.
export const LAUNCHABLE_STATES = new Set([
  MATCH_STATUS.BALL_1,
  MATCH_STATUS.BALL_2,
  MATCH_STATUS.BALL_3,
]);

// Terminal states. Once a match reaches one of these, no further
// state transitions are allowed (the server store rejects any
// action whose match.status is in this set).
export const TERMINAL_STATES = new Set([
  MATCH_STATUS.FINISHED,
  MATCH_STATUS.CANCELLED,
]);

// ──────────────────────────────────────────────────────────────────────────
// Per-ball timing
// ──────────────────────────────────────────────────────────────────────────

// Number of balls each player launches per match. 3-ball aggregate scoring
// (the player with the higher sum across all 3 balls wins). Mirrors the
// mines-pvp `PICK_COUNT` / blackjack-pvp `TOTAL_ROUNDS` shape.
export const REQUIRED_BALLS = 3;

// Duration (seconds) of each ball's commit window before the
// server-authoritative deadline fires and auto-launches a safe
// mid-board shot. Mirrors blackjack-pvp / mines-pvp's
// `ROUND_TIMER_SECONDS` shape.
export const ROUND_TIMER_SECONDS = 20;
export const ROUND_DEADLINE_MS = ROUND_TIMER_SECONDS * 1000;

// Auto-advance window between player2 joining and ball_1 starting
// (server-authoritative 3-second "Get ready" banner).
export const READY_WINDOW_MS = 3000;

// Auto-advance window between consecutive balls (ball_1 → ball_2,
// ball_2 → ball_3). Mirrors blackjack-pvp's `BETWEEN_ROUNDS_MS`
// shape. The match view surfaces this as a transition screen
// ("Ball 2 incoming…").
export const BETWEEN_BALLS_MS = 3000;

// Auto-advance window between FINISHED and the client being allowed
// to navigate back to the lobby. Mirrors mines-pvp's `FINISHED_GRACE_MS`
// and blackjack-pvp's `BETWEEN_ROUNDS_MS` shape.
export const FINISHED_GRACE_MS = 5000;

// ──────────────────────────────────────────────────────────────────────────
// Stake matchmaking constants
// ──────────────────────────────────────────────────────────────────────────
//
// STAKE_PRESETS mirrors mines-pvp / blackjack-pvp / roulette-pvp so the
// lobby UI components render the same chip row. The actual bet is
// still free-form validated against MIN_STAKE / MAX_STAKE.
export const STAKE_PRESETS = [10, 25, 50, 100, 250, 500];
export const MIN_STAKE = 1;
export const MAX_STAKE = 1000000;

// ──────────────────────────────────────────────────────────────────────────
// House fee (per user spec: 10% rake on the LOSER's stake)
// ──────────────────────────────────────────────────────────────────────────
//
// 0.10 = 10% of the loser's stake goes to the house. The winner takes
// 90% of the loser's stake + their own stake back (1.9× net). Distinct
// from roulette-pvp (HOUSE_FEE_PCT = 0.025) and blackjack-pvp (0.025) —
// the user explicitly asked for the 90/10 split for Plinko Duel, matching
// mines-pvp.
export const HOUSE_FEE_PCT = 0.10;
export const WINNER_RATIO = 0.90; // 90% of the loser's stake
export const HOUSE_RATIO = 0.10; // 10% of the loser's stake

// ──────────────────────────────────────────────────────────────────────────
// Stake-key advisory-lock namespace for `createOrJoin` matchmaking
// ──────────────────────────────────────────────────────────────────────────
//
// Stable ASCII-pack to keep the global pg_advisory_xact_lock keyspace
// partitioned so other features can't accidentally collide with
// plinko-pvp matchmaking. ASCII for "PLPV" (Plinko PvP):
// P=0x50, L=0x4C, P=0x50, V=0x56. Bitwise-AND with 0x7FFFFFFF to
// keep the resulting 32-bit signed integer positive (Postgres
// advisory locks take a bigint but staying positive avoids
// sign-extension surprises across the codebase).
export const PLINKO_PVP_LOCK_NAMESPACE = 0x504c5056 & 0x7fffffff;

// ──────────────────────────────────────────────────────────────────────────
// Result string constants
// ──────────────────────────────────────────────────────────────────────────
//
// 'player1' | 'player2' | 'tie' | null. Stored in
// `plinko_pvp_matches.result`. Mirrors mines-pvp / blackjack-pvp
// convention for the match-level result.
//
// Note: the per-ball outcome stored in `plinko_pvp_rounds.ball_outcome`
// uses the `plinko_pvp_ball_outcome` pgEnum with values 'p1' / 'p2' /
// 'tie' (the schema-level enum is more compact). See `BALL_OUTCOME`
// below for the per-ball constants.
export const RESULT = Object.freeze({
  PLAYER1: "player1",
  PLAYER2: "player2",
  TIE: "tie",
});

// Per-ball outcome enum (matches `plinko_pvp_ball_outcome` in
// src/db/schema.ts). 'p1' won the ball, 'p2' won the ball, or
// 'tie' (both scored the same on this ball, e.g. both fell out
// or both landed in identical-point buckets).
export const BALL_OUTCOME = Object.freeze({
  P1: "p1",
  P2: "p2",
  TIE: "tie",
});

/**
 * Map a per-ball outcome ('p1' | 'p2' | 'tie') to the match-level
 * RESULT vocabulary ('player1' | 'player2' | 'tie'). The schema uses
 * the short form for `plinko_pvp_rounds.ball_outcome` (pgEnum) and the
 * long form for `plinko_pvp_matches.result` (varchar(20)). This helper
 * bridges the two so the server store doesn't do ad-hoc string
 * conversions at the write site.
 */
export function ballOutcomeToResult(ballOutcome) {
  if (ballOutcome === BALL_OUTCOME.P1) return RESULT.PLAYER1;
  if (ballOutcome === BALL_OUTCOME.P2) return RESULT.PLAYER2;
  if (ballOutcome === BALL_OUTCOME.TIE) return RESULT.TIE;
  throw new RangeError(
    `ballOutcomeToResult: expected 'p1' | 'p2' | 'tie', got ${ballOutcome}`,
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Format helpers (used by the server store + client UI)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Round a number to 2dp. Centralised here so the server store and the
 * client UI produce identical strings (avoids "0.1 + 0.2 = 0.30000000000000004"
 * surprises in the payout modal).
 */
export function round2(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Number(v.toFixed(2));
}

/**
 * Coerce an arbitrary DB-shaped value to a positive integer with a
 * fallback. Used by every plinko-pvp API route's normaliser so the
 * client gets a strict positive-int for `roundTimer` (and any
 * analogous "admin-tunable duration" field) regardless of whether
 * Drizzle/Postgres returns the column as a number, a numeric
 * string, `null`, `NaN`, or a literal `0`.
 *
 *   pickPositiveInt(null, 20)        -> 20
 *   pickPositiveInt(undefined, 20)   -> 20
 *   pickPositiveInt("", 20)          -> 20
 *   pickPositiveInt("abc", 20)       -> 20
 *   pickPositiveInt("20", 20)        -> 20
 *   pickPositiveInt(0, 20)           -> 20  (0 collapses to fallback —
 *                                            "no timer" is rejected so
 *                                            clients always see a tick)
 *   pickPositiveInt(15.7, 20)        -> 15  (Math.trunc to true int)
 *   pickPositiveInt(-3, 20)          -> 20  (negatives rejected)
 *
 * Extracted out of three sibling route files so the contract stays in
 * one place — if we later want to clamp an upper bound, accept `0` as
 * a "defer to default" sentinel, log non-finite inputs, etc., we
 * edit this one helper and all three routes pick it up.
 */
export function pickPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
}

// ──────────────────────────────────────────────────────────────────────────
// Payout calculator
// ──────────────────────────────────────────────────────────────────────────
//
// Returns the per-side settlement numbers for a resolved plinko-pvp match:
//
//   { stake, result, winnerId, winnerNet, loserNet, houseFee, prizePaid }
//
// Rules (per user spec):
//   TIE:        both refunded. winnerNet = loserNet = null,
//               houseFee = 0, prizePaid = 0.
//   PLAYER1:    player1 wins. player1 gets (stake + 0.9 * stake) =
//               1.9x stake back; player2 loses stake. House rake
//               = 0.1 * stake. prizePaid = 1.9 * stake.
//   PLAYER2:    mirror of PLAYER1.
//
// `p1Score` and `p2Score` are the sum of each player's 3 balls' points
// (0..420, always integers — each ball's points are 0/40/100/140 from
// BUCKETS.basePoints). The `result` field returned here uses the long
// form ('player1' | 'player2' | 'tie') and is intended for the
// `plinko_pvp_matches.result` varchar(20) column. For per-ball outcomes
// written to `plinko_pvp_rounds.ball_outcome` (pgEnum), use
// `ballOutcomeToResult` to map from the short form.
//
// The function is intentionally a PURE mapping — no DB, no state — so
// the match store can call it from both the resolution path and the
// AFK auto-resolve path.
export function computePayout({ stakeAmount, p1Score, p2Score }) {
  const stake = Number(stakeAmount);
  if (!Number.isFinite(stake) || stake < 0) {
    throw new RangeError(
      `computePayout: stakeAmount must be a non-negative number, got ${stakeAmount}`,
    );
  }
  if (!Number.isInteger(p1Score) || p1Score < 0) {
    throw new RangeError(
      `computePayout: p1Score must be a non-negative integer, got ${p1Score}`,
    );
  }
  if (!Number.isInteger(p2Score) || p2Score < 0) {
    throw new RangeError(
      `computePayout: p2Score must be a non-negative integer, got ${p2Score}`,
    );
  }

  if (p1Score === p2Score) {
    return {
      stake: round2(stake),
      result: RESULT.TIE,
      winnerId: null,
      winnerNet: null,
      loserNet: null,
      houseFee: round2(0),
      prizePaid: round2(0),
    };
  }

  const winnerPrize = round2(stake * WINNER_RATIO); // 90% of loser's stake
  const houseFee = round2(stake * HOUSE_RATIO);     // 10% of loser's stake
  const isP1Winner = p1Score > p2Score;
  return {
    stake: round2(stake),
    result: isP1Winner ? RESULT.PLAYER1 : RESULT.PLAYER2,
    winnerId: isP1Winner ? RESULT.PLAYER1 : RESULT.PLAYER2,
    // winner is refunded their own stake + 90% of the loser's stake
    winnerNet: round2(stake + winnerPrize),
    // loser loses their entire stake (net = -stake)
    loserNet: round2(-stake),
    houseFee,
    // prizePaid = the total payout to the winner (their stake back
    // + the 90% they won from the loser).
    prizePaid: round2(stake + winnerPrize),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// AFK auto-launch helper
// ──────────────────────────────────────────────────────────────────────────
//
// When a player doesn't commit inputs before `round_deadline`, the server
// auto-launches a safe mid-board shot. Per user spec: {startX: 250,
// power: 50, angle: 0} with mild random perturbation. Treated like any
// normal launch — no special penalty beyond the expected points from a
// safe play.
//
// Accepts an optional `seed` (32-bit unsigned int). When provided, the
// perturbation is deterministic so an AFK round is fully reproducible
// for audit. When omitted, falls back to `Math.random()` for true
// non-determinism (the caller can't replay the round in that case).
//
// Returns { startX, power, angleDeg }. The caller should still pipe
// these through the physics simulator with a server-derived seed so the
// trajectory itself is deterministic / auditable.
export function autoLaunchInputs({ seed } = {}) {
  // Tiny seeded PRNG (mulberry32 clone) so a given `seed` always
  // returns the same perturbation sequence. The downstream
  // `simulateBall` is seeded separately by the server store.
  let rand = Math.random;
  if (seed != null) {
    let a = Number(seed) >>> 0;
    rand = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  return {
    // ±10 around center — mild horizontal drift, won't fly off the sides
    startX: 250 + (rand() - 0.5) * 20,
    // 45-55 — mid power, won't bullet-down
    power: 50 + (rand() - 0.5) * 10,
    // ±2° — straight down with a tiny deflection
    angleDeg: (rand() - 0.5) * 4,
  };
}

// Re-export peg grid as a single frozen object for convenience.
export const PEG_GRID = Object.freeze({
  rows: PEG_ROWS,
  colsBase: PEG_COLS_BASE,
  horizSpacing: PEG_HORIZ_SPACING,
  vertSpacing: PEG_VERT_SPACING,
  radius: PEG_RADIUS,
  centerX: PEG_CENTER_X,
  ballRadius: BALL_RADIUS,
});

