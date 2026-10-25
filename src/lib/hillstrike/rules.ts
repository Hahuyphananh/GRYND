/**
 * Hillstrike — the pure rules engine: match state, the volley state machine,
 * HP, the three actions, termination and action validation.
 *
 * ── THE RULES AS IMPLEMENTED ───────────────────────────────────────────────
 *   • two seats, 100 HP each, one shared battlefield
 *   • one projectile type with one set of parameters, shared by both seats
 *   • the opening seat is drawn once and RECORDED in the state
 *   • the opening seat takes ONE action; the other seat answers with TWO; from
 *     then on the seats alternate two-action turns
 *   • an ACTION is one of three things:
 *       shoot  — aim and fire the shared projectile
 *       move   — drive forward (closer) or back (farther), up to
 *                `MOVE_RANGE` from the spawn
 *       build  — drop one shield block in front of the tank
 *     so a two-action turn is \"drive into range, then fire\" or \"build cover,
 *     then fire\", not necessarily two shells
 *   • a turn continues after a hit — a player who connects on the first action
 *     of their two still has the second — unless the match has ended
 *   • a DIRECT projectile contact with a tank costs HP, scaled by how far the
 *     shell flew (`damageForDistance`): the same distance falloff that shrinks
 *     the explosion. Structural and terrain damage never costs HP.
 *   • the match ends IMMEDIATELY when a tank reaches 0 HP; the winner is the
 *     seat that acted, and no further action is accepted
 *   • there is no draw: somebody always runs out of HP
 *
 * ── AUTHORITY ──────────────────────────────────────────────────────────────
 * The caller supplies only a seat and an ACTION (`{ type: \"shoot\", angleDeg,
 * power }`, `{ type: \"move\", direction }` or `{ type: \"build\" }`). Positions,
 * hits, HP, terrain, structures, the turn and the winner are all derived here
 * (and in ./physics) from the state the server already holds. There is no field
 * for a position, a block, a hit, an HP total or a winner.
 *
 * The engine imports nothing from React, HTTP, Drizzle or a browser, and never
 * reads a clock or a random source (`createInitialState` takes a seed and an
 * optional seat; the seed alone is enough to reproduce the battlefield).
 */

import {
  ACTION_TYPES,
  ACTIONS_PER_TURN,
  BATTLEFIELD_WIDTH,
  BLOCK_MAX_INTEGRITY,
  BUILD_BLOCK_GAP,
  END_REASONS,
  FIELD_VERSION,
  LAUNCHER_INSET_X,
  MATCH_STATUS,
  MAX_HP,
  MAX_STRUCTURE_BLOCKS_PER_SEAT,
  MOVE_DIRECTIONS,
  MOVE_EDGE_MARGIN,
  MOVE_RANGE,
  MOVE_STEP,
  OPENING_ACTIONS,
  PLAYER_RADIUS,
  REJECTION,
  SEATS,
  STRUCTURE_BLOCK_SIZE,
} from "./constants";
import {
  assertSeed,
  createBattlefield,
  groundYUnder,
  openingSeatFor,
  surfaceYAt,
} from "./generation";
import {
  assertShotInput,
  createProjectileSpec,
  damageForDistance,
  otherSeat,
  simulateShot,
} from "./physics";
import type {
  ActionRecord,
  ActionType,
  ActionVerdict,
  ApplyActionResult,
  Battlefield,
  BuildRecord,
  EndReason,
  HillstrikeAction,
  HillstrikeState,
  MatchStatus,
  MoveDirection,
  MoveRecord,
  ProjectileSpec,
  RejectionCode,
  Seat,
  ShotEvent,
  ShotInput,
  ShotRecord,
  TowerBlock,
} from "./types";

/** Thrown by `applyAction` when an action is refused. Carries the code. */
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

/** True when this seat is the active seat (allowed to act right now). */
export function isActiveSeat(state: HillstrikeState, seat: unknown): boolean {
  return isSeat(seat) && state.status === MATCH_STATUS.PLAYING && state.turn === seat;
}

/** True once the match has terminated. */
export function isMatchFinished(state: HillstrikeState): boolean {
  return state.status === MATCH_STATUS.FINISHED;
}

/**
 * One seat's remaining HP.
 *
 * Read through this helper rather than `state.hp[seat]` because a state written
 * under the v1 (lives) rules has no `hp` map at all: it is read as full HP here
 * instead of becoming `NaN` and taking the whole match with it.
 */
export function hpOf(state: HillstrikeState, seat: Seat): number {
  const hp = (state as { hp?: Record<string, unknown> }).hp;
  const value = hp ? Number(hp[seat]) : Number.NaN;
  return Number.isFinite(value) ? value : MAX_HP;
}

/** Both seats' HP, normalised (see `hpOf`). */
export function hpMapOf(state: HillstrikeState): Record<Seat, number> {
  return { player1: hpOf(state, "player1"), player2: hpOf(state, "player2") };
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
  const hp: Record<Seat, number> = { player1: MAX_HP, player2: MAX_HP };

  return deepFreeze({
    status: MATCH_STATUS.PLAYING,
    fieldVersion: FIELD_VERSION,
    seed,
    openingSeat: opening,
    turn: opening,
    turnIndex: 0,
    actionsRemaining: OPENING_ACTIONS,
    openingShotPending: true,
    hp,
    battlefield,
    projectile: projectile ?? createProjectileSpec(),
    winner: null,
    terminationReason: null,
    lastAction: null,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Geometry helpers (exported so a UI can preview a drive or a build)
// ──────────────────────────────────────────────────────────────────────────

/** The x a seat's tank spawned on — the anchor its drive range is measured from. */
export function spawnXFor(seat: Seat): number {
  return seat === "player1" ? LAUNCHER_INSET_X : BATTLEFIELD_WIDTH - LAUNCHER_INSET_X;
}

/** +1 when `forward` (toward the opponent) increases x, -1 when it decreases. */
export function forwardSignFor(seat: Seat): 1 | -1 {
  return seat === "player1" ? 1 : -1;
}

/** True when a tank footprint at `(x, y)` overlaps any block. */
function tankOverlapsBlock(x: number, y: number, blocks: readonly TowerBlock[]): boolean {
  const centreY = y - PLAYER_RADIUS;
  for (const block of blocks) {
    const nearestX = Math.max(block.x, Math.min(x, block.x + block.size));
    const nearestY = Math.max(block.y, Math.min(centreY, block.y + block.size));
    const dx = x - nearestX;
    const dy = centreY - nearestY;
    if (dx * dx + dy * dy < PLAYER_RADIUS * PLAYER_RADIUS) return true;
  }
  return false;
}

/**
 * Where a drive would put the tank, or `null` when the drive cannot happen.
 *
 * A drive is along the x axis only: forward closes the range, back opens it. It
 * is clamped into `[spawn - MOVE_RANGE, spawn + MOVE_RANGE]` and away from the
 * battlefield edges, then dropped onto the surface. A destination the tank
 * cannot occupy — because a fallen block is in the way, or because it is
 * already at the end of its leash — returns `null` so the caller can refuse the
 * action instead of silently wasting it.
 */
export function moveTargetFor(
  state: HillstrikeState,
  seat: Seat,
  direction: MoveDirection,
): { x: number; y: number } | null {
  const player = state.battlefield.players[seat];
  if (!player) return null;
  const sign = forwardSignFor(seat) * (direction === MOVE_DIRECTIONS.FORWARD ? 1 : -1);
  const spawn = spawnXFor(seat);
  const wanted = player.x + sign * MOVE_STEP;
  const x = Math.round(
    Math.min(
      Math.max(wanted, spawn - MOVE_RANGE),
      spawn + MOVE_RANGE,
      BATTLEFIELD_WIDTH - MOVE_EDGE_MARGIN - PLAYER_RADIUS,
    ),
  );
  if (x === Math.round(player.x)) return null;

  const y = surfaceYAt(state.battlefield.terrain, x);
  if (tankOverlapsBlock(x, y, state.battlefield.blocks)) return null;
  return { x, y };
}

/**
 * Where a shield block would be placed, or `null` when there is no room.
 *
 * The block is dropped on the ground immediately in front of the tank (the
 * `BUILD_BLOCK_GAP` gap keeps it off the hull), and if that column is already
 * occupied it walks outward one block at a time — up to a bounded four columns
 * — so a tank can keep extending its own shield. Nothing here inspects the
 * enemy: the block is cover for the builder, not a wall on the opponent.
 */
export function buildPlacementFor(
  state: HillstrikeState,
  seat: Seat,
): { x: number; y: number; size: number } | null {
  const player = state.battlefield.players[seat];
  if (!player) return null;
  const sign = forwardSignFor(seat);
  const size = STRUCTURE_BLOCK_SIZE;
  // The block sits in front of the hull, on the enemy-facing side, with the gap
  // measured from the hull: `sign` says which way the box extends from its own
  // LEFT edge, so the origin shifts by the block's width when facing left.
  const baseX =
    sign > 0
      ? Math.round(player.x + PLAYER_RADIUS + BUILD_BLOCK_GAP)
      : Math.round(player.x - PLAYER_RADIUS - BUILD_BLOCK_GAP - size);

  for (let step = 0; step < 4; step++) {
    const x = baseX + sign * step * size;
    if (x < 0 || x + size > BATTLEFIELD_WIDTH) return null;
    const y = groundYUnder(state.battlefield.terrain, x, size) - size;
    if (y < 0) return null;
    const overlaps = state.battlefield.blocks.some(
      (block) =>
        x < block.x + block.size &&
        block.x < x + size &&
        y < block.y + block.size &&
        block.y < y + size,
    );
    if (!overlaps) return { x, y, size };
  }
  return null;
}

/** How many blocks a seat currently owns. */
export function blockCountFor(state: HillstrikeState, seat: Seat): number {
  let count = 0;
  for (const block of state.battlefield.blocks) if (block.seat === seat) count += 1;
  return count;
}

// ──────────────────────────────────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────────────────────────────────

function isActionType(value: unknown): value is ActionType {
  return (
    value === ACTION_TYPES.SHOOT ||
    value === ACTION_TYPES.MOVE ||
    value === ACTION_TYPES.BUILD
  );
}

/**
 * Validate one action against the state.
 *
 * Checked in a fixed order: state → seat → action shape → lifecycle → turn →
 * actions remaining → the action's own values, so a caller always gets the most
 * specific reason it is entitled to (a non-participant is never told whose turn
 * it is, and a finished match refuses even the seat that would otherwise be on
 * turn).
 */
export function validateAction(
  state: HillstrikeState,
  seat: unknown,
  action: unknown,
): ActionVerdict {
  if (!state || typeof state !== "object") {
    return {
      ok: false,
      code: REJECTION.INVALID_STATE,
      message: "Match state is missing",
    };
  }
  if (!isSeat(seat)) {
    return { ok: false, code: REJECTION.INVALID_SEAT, message: "Unknown seat" };
  }
  if (!action || typeof action !== "object") {
    return {
      ok: false,
      code: REJECTION.INVALID_ACTION,
      message: "Action must be an object with a type",
    };
  }
  const type = (action as { type?: unknown }).type;
  if (!isActionType(type)) {
    return {
      ok: false,
      code: REJECTION.INVALID_ACTION,
      message: "Action type must be shoot, move or build",
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
    return { ok: false, code: REJECTION.NOT_YOUR_TURN, message: "It is not your turn" };
  }
  const remaining = Number(
    (state as { actionsRemaining?: unknown }).actionsRemaining,
  );
  if (!(remaining >= 1)) {
    return {
      ok: false,
      code: REJECTION.NO_ACTION_REMAINING,
      message: "You have no actions left in this turn",
    };
  }

  if (type === ACTION_TYPES.SHOOT) {
    const { angleDeg, power } = action as Partial<ShotInput>;
    if (typeof angleDeg === "undefined" || typeof power === "undefined") {
      return {
        ok: false,
        code: REJECTION.INVALID_SHOT,
        message: "A shot must be an { angleDeg, power } object",
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

  if (type === ACTION_TYPES.MOVE) {
    const direction = (action as { direction?: unknown }).direction;
    if (
      direction !== MOVE_DIRECTIONS.FORWARD &&
      direction !== MOVE_DIRECTIONS.BACK
    ) {
      return {
        ok: false,
        code: REJECTION.INVALID_DIRECTION,
        message: "A drive must have a direction of forward or back",
      };
    }
    if (!moveTargetFor(state, seat, direction)) {
      return {
        ok: false,
        code: REJECTION.MOVE_BLOCKED,
        message:
          direction === MOVE_DIRECTIONS.FORWARD
            ? "There is no room to drive further forward"
            : "There is no room to drive further back",
      };
    }
    return { ok: true };
  }

  // build
  if (blockCountFor(state, seat) >= MAX_STRUCTURE_BLOCKS_PER_SEAT) {
    return {
      ok: false,
      code: REJECTION.BLOCK_LIMIT,
      message: "You have placed all the blocks your side allows",
    };
  }
  if (!buildPlacementFor(state, seat)) {
    return {
      ok: false,
      code: REJECTION.NO_BUILD_SPACE,
      message: "There is no room to place a block here",
    };
  }
  return { ok: true };
}

/** Narrow an unknown action, once its values have been validated. */
function asAction(action: unknown): HillstrikeAction {
  return action as HillstrikeAction;
}

// ──────────────────────────────────────────────────────────────────────────
// Application
// ──────────────────────────────────────────────────────────────────────────

interface TurnAdvance {
  readonly status: MatchStatus;
  readonly turn: Seat;
  readonly actionsRemaining: number;
  readonly winner: Seat | null;
  readonly terminationReason: EndReason | null;
  readonly finishedEvent: ShotEvent | null;
}

/**
 * The tail every action shares: consume one action, hand the turn over when the
 * turn's actions are spent, and terminate on a knockout.
 *
 * A finished match stops the turn dead — the winner is the seat that ACTED, and
 * no further action is accepted, even if the winner still had one left.
 */
function advanceTurn(
  state: HillstrikeState,
  seat: Seat,
  { knockedOut, tick }: { knockedOut: boolean; tick: number },
): TurnAdvance {
  if (knockedOut) {
    return {
      status: MATCH_STATUS.FINISHED,
      turn: seat,
      actionsRemaining: 0,
      winner: seat,
      terminationReason: END_REASONS.HP_DEPLETED,
      finishedEvent: {
        type: "match-ended",
        tick,
        winner: seat,
        reason: END_REASONS.HP_DEPLETED,
      },
    };
  }

  const left = Math.max(0, Number(state.actionsRemaining) - 1);
  if (left > 0) {
    return {
      status: MATCH_STATUS.PLAYING,
      turn: seat,
      actionsRemaining: left,
      winner: null,
      terminationReason: null,
      finishedEvent: null,
    };
  }
  return {
    status: MATCH_STATUS.PLAYING,
    turn: otherSeat(seat),
    actionsRemaining: ACTIONS_PER_TURN,
    winner: null,
    terminationReason: null,
    finishedEvent: null,
  };
}

/** Assemble the next state from the parts an action changed. */
function composeState({
  state,
  turnAdvance,
  hp,
  battlefield,
  lastAction,
  turnIndex,
}: {
  state: HillstrikeState;
  turnAdvance: TurnAdvance;
  hp: Record<Seat, number>;
  battlefield: Battlefield;
  lastAction: ActionRecord;
  turnIndex: number;
}): HillstrikeState {
  return deepFreeze({
    status: turnAdvance.status,
    fieldVersion: state.fieldVersion,
    seed: state.seed,
    openingSeat: state.openingSeat,
    turn: turnAdvance.turn,
    turnIndex,
    actionsRemaining: turnAdvance.actionsRemaining,
    // The opening action is the only single-action turn: once it has been taken
    // the pending flag is false forever.
    openingShotPending: false,
    hp,
    battlefield,
    projectile: state.projectile,
    winner: turnAdvance.winner,
    terminationReason: turnAdvance.terminationReason,
    lastAction,
  });
}

/** A shot: simulate it, take the distance-scaled HP off the victim, advance. */
function applyShoot(
  state: HillstrikeState,
  seat: Seat,
  input: ShotInput,
): ApplyActionResult {
  const simulation = simulateShot({
    battlefield: state.battlefield,
    shooterSeat: seat,
    shot: input,
    projectile: state.projectile,
  });

  const hp = hpMapOf(state);
  const events: ShotEvent[] = [...simulation.events];

  const hitSeat =
    simulation.impact.kind === "player" ? simulation.impact.target : null;
  let damage = 0;
  if (hitSeat) {
    // One number, from the distance the shell flew — the same falloff that
    // shrank the crater, so a long lob hits for less as well as exploding less.
    damage = Math.min(hp[hitSeat], damageForDistance(simulation.distance));
    hp[hitSeat] = Math.max(0, hp[hitSeat] - damage);
    events.push({
      type: "hp-lost",
      tick: simulation.impact.tick,
      seat: hitSeat,
      hp: hp[hitSeat],
      damage,
    });
  }

  const knockedOut = hitSeat !== null && hp[hitSeat] <= 0;
  const turnIndex = Number(state.turnIndex) + 1;
  const turnAdvance = advanceTurn(state, seat, {
    knockedOut,
    tick: simulation.impact.tick,
  });
  if (turnAdvance.finishedEvent) events.push(turnAdvance.finishedEvent);

  const lastAction: ShotRecord = {
    type: "shoot",
    seat,
    turnIndex: Number(state.turnIndex),
    shot: input,
    impact: simulation.impact,
    path: simulation.path,
    events,
    damage,
    distance: simulation.distance,
    powerScale: simulation.powerScale,
  };

  return {
    state: composeState({
      state,
      turnAdvance,
      hp,
      battlefield: simulation.battlefield,
      lastAction,
      turnIndex,
    }),
    events,
  };
}

/** A drive: move the tank along the surface and advance. */
function applyMove(
  state: HillstrikeState,
  seat: Seat,
  direction: MoveDirection,
): ApplyActionResult {
  const target = moveTargetFor(state, seat, direction);
  if (!target) {
    // validateAction already refused this; the guard keeps the two in step.
    throw new HillstrikeRuleError(
      REJECTION.MOVE_BLOCKED,
      "There is no room to drive that way",
    );
  }

  const from = state.battlefield.players[seat];
  const tick = Number(state.turnIndex);
  const events: ShotEvent[] = [
    {
      type: "moved",
      tick,
      seat,
      direction,
      fromX: from.x,
      fromY: from.y,
      x: target.x,
      y: target.y,
    },
  ];

  const turnIndex = Number(state.turnIndex) + 1;
  const turnAdvance = advanceTurn(state, seat, { knockedOut: false, tick });
  if (turnAdvance.finishedEvent) events.push(turnAdvance.finishedEvent);

  const battlefield: Battlefield = {
    ...state.battlefield,
    players: {
      ...state.battlefield.players,
      [seat]: { ...from, x: target.x, y: target.y },
    },
  };

  const lastAction: MoveRecord = {
    type: "move",
    seat,
    turnIndex: Number(state.turnIndex),
    direction,
    fromX: from.x,
    fromY: from.y,
    toX: target.x,
    toY: target.y,
    events,
  };

  return {
    state: composeState({
      state,
      turnAdvance,
      hp: hpMapOf(state),
      battlefield,
      lastAction,
      turnIndex,
    }),
    events,
  };
}

/** A build: drop one shield block in front of the tank and advance. */
function applyBuild(state: HillstrikeState, seat: Seat): ApplyActionResult {
  const placement = buildPlacementFor(state, seat);
  if (!placement) {
    throw new HillstrikeRuleError(
      REJECTION.NO_BUILD_SPACE,
      "There is no room to place a block here",
    );
  }
  if (blockCountFor(state, seat) >= MAX_STRUCTURE_BLOCKS_PER_SEAT) {
    throw new HillstrikeRuleError(
      REJECTION.BLOCK_LIMIT,
      "You have placed all the blocks your side allows",
    );
  }

  let nextId = 1;
  for (const block of state.battlefield.blocks) nextId = Math.max(nextId, block.id + 1);

  const block: TowerBlock = {
    id: nextId,
    seat,
    x: placement.x,
    y: placement.y,
    size: placement.size,
    integrity: BLOCK_MAX_INTEGRITY,
  };

  const tick = Number(state.turnIndex);
  const events: ShotEvent[] = [
    { type: "block-built", tick, seat, blockId: block.id, x: block.x, y: block.y },
  ];

  const turnIndex = Number(state.turnIndex) + 1;
  const turnAdvance = advanceTurn(state, seat, { knockedOut: false, tick });
  if (turnAdvance.finishedEvent) events.push(turnAdvance.finishedEvent);

  const battlefield: Battlefield = {
    ...state.battlefield,
    blocks: [...state.battlefield.blocks, block],
  };

  const lastAction: BuildRecord = {
    type: "build",
    seat,
    turnIndex: Number(state.turnIndex),
    blockId: block.id,
    x: block.x,
    y: block.y,
    events,
  };

  return {
    state: composeState({
      state,
      turnAdvance,
      hp: hpMapOf(state),
      battlefield,
      lastAction,
      turnIndex,
    }),
    events,
  };
}

/**
 * Apply one action.
 *
 * Returns the next deeply frozen state plus every event a client needs to
 * animate the outcome. The input state is never mutated, on either path: a
 * refused action throws `HillstrikeRuleError` and leaves it byte-for-byte
 * identical.
 *
 * The whole action resolves synchronously before this function returns, so no
 * second action can be accepted against a half-applied position.
 */
export function applyAction(
  state: HillstrikeState,
  seat: unknown,
  action: unknown,
): ApplyActionResult {
  const verdict = validateAction(state, seat, action);
  if (!verdict.ok) {
    // `strict` is off in this repo, so a discriminated union is not narrowed by
    // `if (!verdict.ok)`; the cast keeps the rejection code type-safe.
    const denied = verdict as Extract<ActionVerdict, { ok: false }>;
    throw new HillstrikeRuleError(denied.code, denied.message);
  }

  const actor = seat as Seat;
  const input = asAction(action);
  if (input.type === ACTION_TYPES.SHOOT) {
    return applyShoot(state, actor, assertShotInput(input));
  }
  if (input.type === ACTION_TYPES.MOVE) {
    return applyMove(state, actor, input.direction);
  }
  return applyBuild(state, actor);
}

/**
 * Non-throwing `applyAction`: `{ ok: true, state, events }` or the rejection
 * verdict. Useful for a route or a bot that wants to report a refusal instead
 * of catching it.
 */
export function tryApplyAction(
  state: HillstrikeState,
  seat: unknown,
  action: unknown,
):
  | { readonly ok: true; readonly state: HillstrikeState; readonly events: readonly ShotEvent[] }
  | Extract<ActionVerdict, { ok: false }> {
  const verdict = validateAction(state, seat, action);
  if (!verdict.ok) return verdict as Extract<ActionVerdict, { ok: false }>;
  const applied = applyAction(state, seat, action);
  return { ok: true, state: applied.state, events: applied.events };
}

/** The two seats, for callers that need to iterate them. */
export const HILLSTRIKE_SEATS = SEATS;
