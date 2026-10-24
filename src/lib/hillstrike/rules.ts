/**
 * Hillstrike — the pure rules engine: match state, the volley state machine,
 * lives, termination and shot validation.
 *
 * ── THE RULES AS IMPLEMENTED ───────────────────────────────────────────────
 *   • two seats, three lives each, one shared battlefield
 *   • one projectile type with one set of parameters, shared by both seats
 *   • the opening seat is drawn once and RECORDED in the state
 *   • the opening seat fires ONE shot; the other seat answers with TWO; from
 *     then on the seats alternate two-shot volleys
 *   • a volley continues after a hit — a player who connects on the first shot
 *     of their two still has the second — unless the match has ended
 *   • a DIRECT projectile contact with a player removes exactly one life
 *   • structural damage and terrain deformation never remove a life
 *   • the match ends IMMEDIATELY when a player reaches zero lives; the winner is
 *     the seat that fired, and no further shot is accepted
 *   • there is no draw: somebody always runs out of lives
 *
 * ── AUTHORITY ──────────────────────────────────────────────────────────────
 * The caller supplies only a seat and `{ angleDeg, power }`. Positions, hits,
 * lives, terrain, structures, the turn and the winner are all derived here (and
 * in ./physics) from the state the server already holds.
 *
 * The engine imports nothing from React, HTTP, Drizzle or a browser, and never
 * reads a clock or a random source (`createInitialState` takes a seed and an
 * optional seat; the seed alone is enough to reproduce the battlefield).
 */

import {
  END_REASONS,
  FIELD_VERSION,
  LIVES_PER_PLAYER,
  MATCH_STATUS,
  OPENING_SHOTS,
  REJECTION,
  SEATS,
  SHOTS_PER_VOLLEY,
} from "./constants";
import {
  assertSeed,
  createBattlefield,
  openingSeatFor,
} from "./generation";
import {
  assertShotInput,
  createProjectileSpec,
  otherSeat,
  simulateShot,
} from "./physics";
import type {
  ApplyShotResult,
  Battlefield,
  EndReason,
  HillstrikeState,
  Lives,
  MatchStatus,
  RejectionCode,
  Seat,
  ShotEvent,
  ShotInput,
  ShotRecord,
  ShotVerdict,
  ProjectileSpec,
} from "./types";

/** Thrown by `applyShot` when a shot is refused. Carries the rejection code. */
export class HillstrikeRuleError extends Error {
  readonly code: RejectionCode;

  constructor(code: RejectionCode, message: string) {
    super(message);
    this.name = "HillstrikeRuleError";
    this.code = code;
  }
}

/** Type guard for `HillstrikeRuleError` (survives a cross-realm instanceof). */
export function isHillstrikeRuleError(error: unknown): error is HillstrikeRuleError {
  return Boolean(
    error &&
      typeof error === "object" &&
      (error as { name?: unknown }).name === "HillstrikeRuleError" &&
      typeof (error as { code?: unknown }).code === "string",
  );
}

/** Deep freeze, bounded: state graphs here are at most five levels deep. */
function deepFreeze<T>(value: T, depth = 0): T {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key], depth + 1);
  }
  return value;
}

function isSeat(value: unknown): value is Seat {
  return value === "player1" || value === "player2";
}

/** The seat that is not `seat` (re-exported so callers need one import). */
export { otherSeat };

/** True when this seat is the active seat (allowed to fire right now). */
export function isActiveSeat(state: HillstrikeState, seat: unknown): boolean {
  return isSeat(seat) && state.status === MATCH_STATUS.PLAYING && state.turn === seat;
}

/** True once the match has terminated. */
export function isMatchFinished(state: HillstrikeState): boolean {
  return state.status === MATCH_STATUS.FINISHED;
}

/** One seat's remaining lives. */
export function livesOf(state: HillstrikeState, seat: Seat): number {
  return state.lives[seat];
}

export interface CreateInitialStateParams {
  /** The battlefield seed, drawn by the server (crypto) and stored on the row. */
  readonly seed: number;
  /**
   * Optional override for the opening seat. Omitted (the production path) uses
   * the seed's deterministic draw, so a stored seed reproduces the same match
   * including who opened. Tests and a scripted practice board may pass it.
   */
  readonly openingSeat?: Seat;
  /** The shared projectile spec; defaults to the frozen canonical one. */
  readonly projectile?: ProjectileSpec;
}

/**
 * Create a ready-to-play match.
 *
 * The opening seat is drawn from the seed and RECORDED on the state, so a match
 * can always answer "who opened?" without re-deriving it, and the battlefield
 * is generated from the same seed.
 */
export function createInitialState({
  seed,
  openingSeat,
  projectile,
}: CreateInitialStateParams): HillstrikeState {
  assertSeed(seed);
  if (openingSeat !== undefined && !isSeat(openingSeat)) {
    throw new TypeError(`hillstrike rules: invalid opening seat ${String(openingSeat)}`);
  }
  const opening: Seat = openingSeat ?? openingSeatFor(seed);
  const battlefield: Battlefield = createBattlefield(seed);
  const lives: Lives = {
    player1: LIVES_PER_PLAYER,
    player2: LIVES_PER_PLAYER,
  };

  return deepFreeze({
    status: MATCH_STATUS.PLAYING,
    fieldVersion: FIELD_VERSION,
    seed,
    openingSeat: opening,
    turn: opening,
    turnIndex: 0,
    shotsRemaining: OPENING_SHOTS,
    openingShotPending: true,
    lives,
    battlefield,
    projectile: projectile ?? createProjectileSpec(),
    winner: null,
    terminationReason: null,
    lastShot: null,
  });
}

/**
 * Validate one shot against the state. Checked in a fixed order:
 * state → seat → shot shape → lifecycle → turn → shots remaining → angle →
 * power, so a caller always gets the most specific reason it is entitled to
 * (a non-participant is never told whose turn it is, and a finished match
 * refuses even the seat that would otherwise be on turn).
 */
export function validateShot(
  state: HillstrikeState,
  seat: unknown,
  shot: unknown,
): ShotVerdict {
  if (!state || typeof state !== "object") {
    return {
      ok: false,
      code: REJECTION.INVALID_STATE,
      message: "Match state is missing",
    };
  }
  if (!isSeat(seat)) {
    return {
      ok: false,
      code: REJECTION.INVALID_SEAT,
      message: "Unknown seat",
    };
  }
  if (!shot || typeof shot !== "object") {
    return {
      ok: false,
      code: REJECTION.INVALID_SHOT,
      message: "Shot must be an { angleDeg, power } object",
    };
  }
  if (state.status !== MATCH_STATUS.PLAYING) {
    return {
      ok: false,
      code: REJECTION.MATCH_NOT_PLAYING,
      message: "This match is no longer active",
    };
  }
  if (state.turn !== seat) {
    return {
      ok: false,
      code: REJECTION.NOT_YOUR_TURN,
      message: "It is not your turn",
    };
  }
  if (!(state.shotsRemaining >= 1)) {
    return {
      ok: false,
      code: REJECTION.NO_SHOTS_REMAINING,
      message: "You have no shots left in this volley",
    };
  }

  const { angleDeg, power } = shot as Partial<ShotInput>;
  if (typeof angleDeg === "undefined" || typeof power === "undefined") {
    return {
      ok: false,
      code: REJECTION.INVALID_SHOT,
      message: "Shot must be an { angleDeg, power } object",
    };
  }
  if (typeof angleDeg !== "number" || !Number.isFinite(angleDeg)) {
    return {
      ok: false,
      code: REJECTION.ANGLE_INVALID,
      message: "Angle must be a finite number",
    };
  }
  if (angleDeg < 0 || angleDeg >= 360) {
    return {
      ok: false,
      code: REJECTION.ANGLE_INVALID,
      message: "Angle must be in [0, 360)",
    };
  }
  if (
    typeof power !== "number" ||
    !Number.isFinite(power) ||
    !Number.isInteger(power) ||
    power < 0 ||
    power > 100
  ) {
    return {
      ok: false,
      code: REJECTION.POWER_INVALID,
      message: "Power must be an integer in [0, 100]",
    };
  }

  return { ok: true };
}

/**
 * Apply one shot.
 *
 * Returns the next deeply frozen state plus every event a client needs to
 * animate the outcome. The input state is never mutated, on either path: a
 * refused shot throws `HillstrikeRuleError` and leaves it byte-for-byte
 * identical.
 *
 * The whole shot resolves synchronously before this function returns, so no
 * second shot can be accepted against a half-applied position.
 */
export function applyShot(
  state: HillstrikeState,
  seat: unknown,
  shot: unknown,
): ApplyShotResult {
  const verdict = validateShot(state, seat, shot);
  if (!verdict.ok) {
    // `strict` is off in this repo, so a discriminated union is not narrowed by
    // `if (!verdict.ok)`; the cast keeps the rejection code type-safe.
    const denied = verdict as Extract<ShotVerdict, { ok: false }>;
    throw new HillstrikeRuleError(denied.code, denied.message);
  }

  const shooter = seat as Seat;
  const input = assertShotInput(shot);
  const simulation = simulateShot({
    battlefield: state.battlefield,
    shooterSeat: shooter,
    shot: input,
    projectile: state.projectile,
  });

  const lives: Record<Seat, number> = {
    player1: state.lives.player1,
    player2: state.lives.player2,
  };
  const events: ShotEvent[] = [...simulation.events];

  // Exactly one life, and only for a DIRECT player contact. Terrain and
  // structural damage are deliberately not consulted here.
  const hitSeat =
    simulation.impact.kind === "player" ? simulation.impact.target : null;
  let livesLost = 0;
  if (hitSeat) {
    lives[hitSeat] = Math.max(0, lives[hitSeat] - 1);
    livesLost = 1;
    events.push({
      type: "life-lost",
      tick: simulation.impact.tick,
      seat: hitSeat,
      lives: lives[hitSeat],
    });
  }

  const finished = hitSeat !== null && lives[hitSeat] <= 0;
  const turnIndex = state.turnIndex + 1;
  const turnIndexAtShot = state.turnIndex;

  let turn: Seat = state.turn;
  let shotsRemaining = state.shotsRemaining - 1;
  let status: MatchStatus = MATCH_STATUS.PLAYING;
  let winner: Seat | null = null;
  let terminationReason: EndReason | null = null;

  if (finished) {
    // The match ends the instant a player reaches zero lives: the volley stops
    // with the match, even if the shooter had a shot left.
    status = MATCH_STATUS.FINISHED;
    winner = shooter;
    terminationReason = END_REASONS.LIVES_EXHAUSTED;
    turn = shooter;
    shotsRemaining = 0;
    events.push({
      type: "match-ended",
      tick: simulation.impact.tick,
      winner: shooter,
      reason: END_REASONS.LIVES_EXHAUSTED,
    });
  } else if (shotsRemaining <= 0) {
    turn = otherSeat(shooter);
    shotsRemaining = SHOTS_PER_VOLLEY;
  }

  const lastShot: ShotRecord = {
    seat: shooter,
    turnIndex: turnIndexAtShot,
    shot: input,
    impact: simulation.impact,
    path: simulation.path,
    events,
    livesLost,
  };

  const next: HillstrikeState = {
    status,
    fieldVersion: state.fieldVersion,
    seed: state.seed,
    openingSeat: state.openingSeat,
    turn,
    turnIndex,
    shotsRemaining,
    // The opening shot is the only one-shot volley: once it has been fired the
    // pending flag is false forever.
    openingShotPending: false,
    lives,
    battlefield: simulation.battlefield,
    projectile: state.projectile,
    winner,
    terminationReason,
    lastShot,
  };

  return { state: deepFreeze(next), events };
}

/**
 * Non-throwing `applyShot`: `{ ok: true, state, events }` or the rejection
 * verdict. Useful for a route or a bot that wants to report a refusal instead
 * of catching it.
 */
export function tryApplyShot(
  state: HillstrikeState,
  seat: unknown,
  shot: unknown,
):
  | { readonly ok: true; readonly state: HillstrikeState; readonly events: readonly ShotEvent[] }
  | Extract<ShotVerdict, { ok: false }> {
  const verdict = validateShot(state, seat, shot);
  if (!verdict.ok) return verdict as Extract<ShotVerdict, { ok: false }>;
  const applied = applyShot(state, seat, shot);
  return { ok: true, state: applied.state, events: applied.events };
}

/** The two seats, for callers that need to iterate them. */
export const HILLSTRIKE_SEATS = SEATS;
