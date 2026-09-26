// src/lib/mini-golf/rules.ts
//
// The pure Mini Golf match rules engine. NO database, NO I/O, NO randomness —
// every function here is a deterministic transformation of the authoritative
// state, which makes the turn/hole/match lifecycle unit-testable in isolation
// and keeps the API routes/store thin.
//
// Model (and why): each seat plays its OWN ball toward the same cup, taking
// strokes in turn. `balls` therefore holds one ball per seat, and `currentBall`
// is the ball of the seat whose turn it is. A shared single ball could not
// express "the hole is won by the player with fewer strokes", which is the
// scoring rule, so per-seat balls are required to make the rule meaningful.
//
// Both seats must hole out before a hole is complete. That is deliberate: if a
// hole ended as soon as the leader holed out, the trailing player would be
// denied the strokes to catch up, and a 1-stroke lead could never be a tie.
//
// Security note: the only player-authored inputs in the whole match are
// { angle, power }. Ball positions, stroke counts, hole winners and the match
// winner are all derived here, from the server's simulation output.

import {
  COURSE_VERSION,
  HOLES_TO_WIN,
  HOLE_COUNT,
  MATCH_STATUS,
  POWER_MAX,
  POWER_MIN,
} from "./constants";
import { generateCourse } from "./course";
import type { Hole, ShotResult, Vec2 } from "./types";

/** Seat names. Also the suffix of every per-seat field in the state. */
export type Seat = "player1" | "player2";

/** Outcome of one hole. `tie` awards neither seat a hole win. */
export type HoleWinner = Seat | "tie";

/** Outcome of the match, in the same vocabulary persisted by the schema. */
export type MatchResult = Seat | "tie";

/**
 * Persisted shot phase.
 *   aiming    — the current seat may submit a shot (the PLAYER_TURN step)
 *   resolving — a shot is being applied (transient; never persisted)
 *   finished  — the match is complete
 *
 * Only `aiming` / `finished` are ever written to a row: the server resolves a
 * shot synchronously inside one locked transaction, so there is no observable
 * `resolving` window a client could poll. The full lifecycle the API and the
 * realtime payloads speak is exposed separately as `LifecycleStage` (below),
 * which names each transition a shot produces.
 */
export type ShotPhase = "aiming" | "resolving" | "finished";

/**
 * The transition vocabulary of one shot, in the order a shot can produce them:
 *
 *   SHOT_RESOLVING  → the shot was accepted and the server is applying it
 *   BALL_SETTLED    → the deterministic simulation returned the final ball
 *   HOLE_COMPLETED  → both seats holed out, the hole was scored
 *   NEXT_PLAYER_TURN→ the turn was handed to the other seat on the same hole
 *   NEXT_HOLE       → the next hole was started (balls reset, starter swapped)
 *   MATCH_COMPLETED → a seat reached HOLES_TO_WIN (or all holes were played)
 *
 * A single shot produces exactly one of these terminal shapes:
 *   [...BALL_SETTLED, NEXT_PLAYER_TURN]
 *   [...BALL_SETTLED, HOLE_COMPLETED, NEXT_HOLE]
 *   [...BALL_SETTLED, HOLE_COMPLETED, MATCH_COMPLETED]
 */
export const LIFECYCLE_STAGES = [
  "SHOT_RESOLVING",
  "BALL_SETTLED",
  "HOLE_COMPLETED",
  "NEXT_PLAYER_TURN",
  "NEXT_HOLE",
  "MATCH_COMPLETED",
] as const;

export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

/** One seat's ball on the current hole. */
export type BallState = {
  x: number;
  y: number;
  /** True once this seat has pocketed its ball on the current hole. */
  holedOut: boolean;
};

/** Strokes taken per seat on one hole. */
export type HoleScore = { player1: number; player2: number };

/** The most recent shot, for the client's animation + history panel. */
export type LastShot = {
  seat: Seat;
  hole: number;
  /** Strokes this seat has now taken on the hole (1-based). */
  strokeNumber: number;
  angle: number;
  power: number;
  result: ShotResult;
};

/**
 * The authoritative match state, stored as `mini_golf_matches.game_state`.
 *
 * Deliberately free of player ids: the seat is the identity the engine reasons
 * about, and the seat→Clerk-id mapping lives in the row's `player1_id` /
 * `player2_id` columns. That keeps this object non-redundant and makes every
 * transition here pure.
 */
export type MiniGolfState = {
  /** Monotonic optimistic-concurrency counter. Incremented on every write. */
  version: number;
  phase: ShotPhase;
  /** Server-generated match seed. The course is a pure function of it. */
  seed: number;
  courseVersion: number;
  /** Frozen snapshot of the generated course (five holes). */
  holes: Hole[];
  /** 1-based current hole. */
  currentHole: number;
  currentTurn: Seat;
  balls: Record<Seat, BallState>;
  /** Mirror of the active seat's ball position (convenience for the UI). */
  currentBall: Vec2;
  /** Strokes the active seat has taken on the current hole. */
  currentStroke: number;
  holeScores: HoleScore[];
  holeWinners: (HoleWinner | null)[];
  player1HoleWins: number;
  player2HoleWins: number;
  /** Monotonic shot counter — the anti-replay key for `mini_golf_shots`. */
  shotSeq: number;
  lastShot: LastShot | null;
};

/** Seat→user id mapping, sourced from the match row. */
export type Seats = { player1Id: string; player2Id: string | null };

export function seatForUser(seats: Seats, userId: string | null): Seat | null {
  if (!userId) return null;
  if (userId === seats.player1Id) return "player1";
  if (seats.player2Id && userId === seats.player2Id) return "player2";
  return null;
}

export function otherSeat(seat: Seat): Seat {
  return seat === "player1" ? "player2" : "player1";
}

export function userIdForSeat(seats: Seats, seat: Seat): string | null {
  return seat === "player1" ? seats.player1Id : seats.player2Id;
}

/** True when BOTH seats are known (i.e. the match is a real 1v1). */
export function hasBothSeats(seats: Seats): boolean {
  return Boolean(seats.player1Id && seats.player2Id);
}

/** The hole the match is currently on. */
export function holeFor(state: MiniGolfState): Hole {
  const index = Math.min(Math.max(state.currentHole, 1), state.holes.length) - 1;
  return state.holes[index];
}

/**
 * Who tees off on a given hole. Alternating by hole parity: player1 opens the
 * odd holes, player2 the even ones. Simple, symmetric, and needs no state from
 * the previous hole.
 */
export function starterSeatForHole(holeNumber: number): Seat {
  return holeNumber % 2 === 1 ? "player1" : "player2";
}

/** Lower stroke count wins; equal counts tie and award no hole win. */
export function decideHoleWinner(score: HoleScore): HoleWinner {
  if (score.player1 < score.player2) return "player1";
  if (score.player2 < score.player1) return "player2";
  return "tie";
}

// ── Construction ──────────────────────────────────────────────────────────

function emptyHoleScores(): HoleScore[] {
  return Array.from({ length: HOLE_COUNT }, () => ({ player1: 0, player2: 0 }));
}

function emptyHoleWinners(): (HoleWinner | null)[] {
  return Array.from({ length: HOLE_COUNT }, () => null);
}

/** A fresh ball for `seat` placed on the hole's tee. */
function ballOnTee(hole: Hole): BallState {
  return { x: hole.geometry.tee.x, y: hole.geometry.tee.y, holedOut: false };
}

/** Point the derived `currentBall` / `currentStroke` mirror at `currentTurn`. */
function syncActive(state: MiniGolfState): void {
  const ball = state.balls[state.currentTurn];
  state.currentBall = { x: ball.x, y: ball.y };
  state.currentStroke = state.holeScores[state.currentHole - 1][state.currentTurn];
}

/**
 * Create the initial state for a fresh match. `seed` must be server-generated;
 * the course (all five holes) is derived from it deterministically.
 */
export function createInitialState({
  seed,
  courseVersion = COURSE_VERSION,
}: {
  seed: number;
  courseVersion?: number;
}): MiniGolfState {
  if (!Number.isFinite(seed)) {
    throw new TypeError("mini-golf rules: seed must be a finite number");
  }
  // The course is a pure function of the seed; `.holes` is the frozen
  // five-hole snapshot stored in the match state.
  const holes = generateCourse(seed, courseVersion).holes;
  const currentHole = 1;
  const currentTurn = starterSeatForHole(currentHole);

  const state: MiniGolfState = {
    version: 1,
    phase: "aiming",
    seed: seed >>> 0,
    courseVersion,
    holes,
    currentHole,
    currentTurn,
    balls: {
      player1: ballOnTee(holes[0]),
      player2: ballOnTee(holes[0]),
    },
    currentBall: { x: holes[0].geometry.tee.x, y: holes[0].geometry.tee.y },
    currentStroke: 0,
    holeScores: emptyHoleScores(),
    holeWinners: emptyHoleWinners(),
    player1HoleWins: 0,
    player2HoleWins: 0,
    shotSeq: 0,
    lastShot: null,
  };
  syncActive(state);
  return state;
}

/** Reset the board for `holeNumber` and hand the tee to that hole's starter. */
export function startHole(state: MiniGolfState, holeNumber: number): void {
  if (holeNumber < 1 || holeNumber > state.holes.length) {
    throw new RangeError(`mini-golf rules: hole ${holeNumber} is out of range`);
  }
  state.currentHole = holeNumber;
  const hole = state.holes[holeNumber - 1];
  state.balls = {
    player1: ballOnTee(hole),
    player2: ballOnTee(hole),
  };
  state.currentTurn = starterSeatForHole(holeNumber);
  // NOTE: `lastShot` is deliberately NOT cleared here.
  //
  // The hole-completing shot is the most exciting one in the match, and BOTH
  // seats have to animate it. The shooter gets the trajectory in the /shoot
  // response, but the opponent only ever sees the snapshot — so the snapshot
  // has to carry the final shot. Keeping `lastShot` (which records its own
  // `hole`) lets a client animate a shot that belongs to the PREVIOUS hole
  // before transitioning forward; the next real shot overwrites it. A
  // freshly created match still starts with `lastShot: null`.
  syncActive(state);
}

// ── Validation ────────────────────────────────────────────────────────────

// NOTE: a single object with optional fields rather than a boolean-discriminant
// union. This repo compiles with `strict: false`, where narrowing on a boolean
// literal does not behave as expected (the same reason
// src/lib/auth/requireAgeVerified.ts returns plain objects).
export type ShotValidation = {
  ok: boolean;
  seat?: Seat;
  error?: string;
  status?: number;
};

/**
 * Validate a shot request against the authoritative state. Everything the
 * client is NOT allowed to influence is checked here.
 *
 * Rejections, in order: finished match, shot already resolving, non-participant,
 * out-of-turn, the shooter's ball already holed out, a stale `expectedVersion`,
 * non-finite or out-of-range inputs.
 */
export function validateShot({
  state,
  seat,
  angle,
  power,
  expectedVersion,
}: {
  state: MiniGolfState;
  seat: Seat | null;
  angle: unknown;
  power: unknown;
  expectedVersion?: unknown;
}): ShotValidation {
  if (!state || typeof state !== "object") {
    return { ok: false, error: "Match state is unavailable", status: 500 };
  }
  if (state.phase === "finished") {
    return { ok: false, error: "Match is already finished", status: 409 };
  }
  if (state.phase !== "aiming") {
    return { ok: false, error: "A shot is already resolving", status: 409 };
  }
  if (!seat) {
    return { ok: false, error: "Not a participant of this match", status: 403 };
  }
  if (state.currentTurn !== seat) {
    return { ok: false, error: "It is not your turn", status: 409 };
  }
  if (state.balls[seat].holedOut) {
    return { ok: false, error: "You have already completed this hole", status: 409 };
  }
  // Optimistic concurrency: the client must prove it is acting on the state it
  // was shown, so a double-submit or a stale tab cannot apply a second shot.
  if (expectedVersion !== undefined && expectedVersion !== null) {
    const expected = Number(expectedVersion);
    if (!Number.isFinite(expected) || Math.floor(expected) !== state.version) {
      return { ok: false, error: "Stale match state", status: 409 };
    }
  }

  // Strict type check, not a Number() coercion: `Number("")`, `Number(true)`
  // and `Number([])` are all finite numbers, which would let a malformed body
  // through as a legal shot.
  if (
    typeof angle !== "number" ||
    typeof power !== "number" ||
    !Number.isFinite(angle) ||
    !Number.isFinite(power)
  ) {
    return { ok: false, error: "Angle and power must be numbers", status: 400 };
  }
  const a = angle as number;
  const p = power as number;
  if (a < 0 || a >= 360) {
    return { ok: false, error: "Angle must be in [0, 360)", status: 400 };
  }
  if (p < POWER_MIN || p > POWER_MAX) {
    return { ok: false, error: `Power must be in [${POWER_MIN}, ${POWER_MAX}]`, status: 400 };
  }

  return { ok: true, seat };
}

// ── Progression ───────────────────────────────────────────────────────────

export type AppliedShot = {
  state: MiniGolfState;
  holeCompleted: boolean;
  matchCompleted: boolean;
  holeWinner: HoleWinner | null;
  /** The ordered lifecycle transitions this shot produced (see LIFECYCLE_STAGES). */
  stages: LifecycleStage[];
};

/**
 * Apply one simulated shot to the state and run every downstream transition:
 * stroke counting (including the water penalty), hole completion, hole winner,
 * turn hand-off and match completion.
 *
 * `shotResult` MUST come from the server's own `simulateShot` call. It is an
 * input here only so this module stays free of physics/IO.
 */
export function applyShot({
  state,
  seat,
  angle,
  power,
  shotResult,
}: {
  state: MiniGolfState;
  seat: Seat;
  angle: number;
  power: number;
  shotResult: ShotResult;
}): AppliedShot {
  const next: MiniGolfState = {
    ...state,
    balls: {
      player1: { ...state.balls.player1 },
      player2: { ...state.balls.player2 },
    },
    holeScores: state.holeScores.map((score) => ({ ...score })),
    holeWinners: [...state.holeWinners],
  };

  const holeIndex = state.currentHole - 1;
  const seatBall = next.balls[seat];

  next.version = state.version + 1;
  next.shotSeq = state.shotSeq + 1;

  // Landing in water costs the stroke plus a one-stroke penalty; the physics
  // module already returned the ball to where the stroke started.
  const strokes = 1 + Math.max(0, Number(shotResult.waterHits) || 0);
  next.holeScores[holeIndex][seat] += strokes;

  seatBall.x = shotResult.restPosition.x;
  seatBall.y = shotResult.restPosition.y;
  if (shotResult.pocketed) seatBall.holedOut = true;

  next.lastShot = {
    seat,
    hole: state.currentHole,
    strokeNumber: next.holeScores[holeIndex][seat],
    angle,
    power,
    result: shotResult,
  };

  const opponent = otherSeat(seat);
  let holeCompleted = false;
  let matchCompleted = false;
  let holeWinner: HoleWinner | null = null;
  // The simulation has already run by the time we get here, and the shot has
  // been accepted, so every shot opens with the same two transitions.
  const stages: LifecycleStage[] = ["SHOT_RESOLVING", "BALL_SETTLED"];

  if (next.balls.player1.holedOut && next.balls.player2.holedOut) {
    // Both seats are done — score the hole.
    holeCompleted = true;
    holeWinner = decideHoleWinner(next.holeScores[holeIndex]);
    next.holeWinners[holeIndex] = holeWinner;
    if (holeWinner === "player1") next.player1HoleWins += 1;
    else if (holeWinner === "player2") next.player2HoleWins += 1;

    if (isMatchComplete(next)) {
      matchCompleted = true;
      next.phase = "finished";
      // Keep the mirror pointed at a real ball so the client never renders the
      // finished state from a stale pointer.
      syncActive(next);
      stages.push("HOLE_COMPLETED", "MATCH_COMPLETED");
    } else {
      startHole(next, state.currentHole + 1);
      stages.push("HOLE_COMPLETED", "NEXT_HOLE");
    }
  } else {
    // Hand the turn on. A seat that has holed out cannot play again, so the
    // other seat keeps the turn until it also holes out.
    if (seatBall.holedOut) {
      next.currentTurn = opponent;
    } else if (next.balls[opponent].holedOut) {
      next.currentTurn = seat;
    } else {
      next.currentTurn = opponent;
    }
    syncActive(next);
    stages.push("NEXT_PLAYER_TURN");
  }

  return { state: next, holeCompleted, matchCompleted, holeWinner, stages };
}

/** True once a seat has won HOLES_TO_WIN holes, or all holes have been played. */
export function isMatchComplete(state: MiniGolfState): boolean {
  if (state.player1HoleWins >= HOLES_TO_WIN || state.player2HoleWins >= HOLES_TO_WIN) {
    return true;
  }
  return state.holeWinners.every((winner) => winner !== null);
}

/** The authoritative match outcome. Derived — never accepted from a client. */
export function computeMatchResult(state: MiniGolfState): {
  result: MatchResult;
  winnerSeat: Seat | null;
} {
  if (state.player1HoleWins > state.player2HoleWins) {
    return { result: "player1", winnerSeat: "player1" };
  }
  if (state.player2HoleWins > state.player1HoleWins) {
    return { result: "player2", winnerSeat: "player2" };
  }
  return { result: "tie", winnerSeat: null };
}

/** Status a match should hold given its state (finished states are terminal). */
export function statusForState(state: MiniGolfState): string {
  return state.phase === "finished" ? MATCH_STATUS.FINISHED : MATCH_STATUS.PLAYING;
}

// ── View projection ───────────────────────────────────────────────────────

/**
 * Client-facing DTO. Adds the per-viewer flags the match page needs without
 * leaking anything the viewer is not entitled to (there is nothing hidden in
 * Mini Golf beyond the opponent's *future* input, which does not exist yet).
 */
export function normalizeForViewer({
  state,
  seats,
  viewerId,
  status,
  result,
  winnerId,
}: {
  state: MiniGolfState;
  seats: Seats;
  viewerId: string | null;
  /**
   * The row's authoritative status. Optional so pure callers can rely on the
   * phase-derived value; the store always passes the row's status so a
   * `cancelled` lobby is never reported as `playing`.
   */
  status?: string;
  /** The row's persisted outcome (`player1` | `player2` | `tie`), if settled. */
  result?: string | null;
  /** The settled winner's user id, if any. */
  winnerId?: string | null;
}) {
  const viewerSeat = seatForUser(seats, viewerId);
  const isViewerTurn = Boolean(viewerSeat) && state.currentTurn === viewerSeat;
  return {
    version: state.version,
    phase: state.phase,
    status: status ?? statusForState(state),
    // Settled outcome. Derived from hole wins for a played-out match, and
    // taken from the row for a forfeit / cancellation — the client never has
    // to infer who won a conceded match. Never accepted FROM a client.
    result: result ?? null,
    winnerId: winnerId ?? null,
    seed: state.seed,
    courseVersion: state.courseVersion,
    holes: state.holes,
    currentHole: state.currentHole,
    currentTurn: state.currentTurn,
    currentTurnUserId: userIdForSeat(seats, state.currentTurn),
    currentBall: state.currentBall,
    currentStroke: state.currentStroke,
    balls: state.balls,
    holeScores: state.holeScores,
    holeWinners: state.holeWinners,
    player1HoleWins: state.player1HoleWins,
    player2HoleWins: state.player2HoleWins,
    shotSeq: state.shotSeq,
    lastShot: state.lastShot,
    player1Id: seats.player1Id,
    player2Id: seats.player2Id,
    viewerSeat,
    // Gated on the same conditions `validateShot` enforces, so the UI never
    // offers a shot the server would reject.
    viewerCanShoot:
      state.phase === "aiming" &&
      Boolean(viewerSeat) &&
      isViewerTurn &&
      !state.balls[viewerSeat as Seat].holedOut,
    viewerHasHoledOut: viewerSeat ? state.balls[viewerSeat].holedOut : false,
    isViewerTurn,
  };
}

/** Seat→user-id mapping from a persisted match row. */
export function seatsFromMatch(match: {
  player1Id: string;
  player2Id?: string | null;
}): Seats {
  return { player1Id: match.player1Id, player2Id: match.player2Id ?? null };
}
