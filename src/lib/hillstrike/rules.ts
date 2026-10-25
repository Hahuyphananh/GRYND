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
 *                `MOVE_RANGE` from the spawn, collecting any power-up the tank
 *                drives onto
 *       build  — place one cover block at a CHOSEN tile on the builder's OWN
 *                half of the map, resting on the ground or on another block
 *     so a two-action turn is \"drive into range, then fire\" or \"place cover,
 *     then fire\", not necessarily two shells
 *   • a turn continues after a hit — a player who connects on the first action
 *     of their two still has the second — unless the match has ended
 *   • a DIRECT projectile contact with a tank costs HP, scaled by how far the
 *     shell flew (`damageForDistance`). Distance changes NOTHING else: cover
 *     blocks break on any contact and a crater is always the same size.
 *     Structural and terrain damage never costs HP.
 *   • the middle's three power-ups are collected by DRIVING onto them: heal
 *     restores HP, double-damage doubles the next shot's HP damage and
 *     double-blast doubles the next shot's crater and block blast. A weapon
 *     buff is spent by the next shot, hit or miss.
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
  BATTLEFIELD_HEIGHT,
  BATTLEFIELD_WIDTH,
  BLOCK_MAX_INTEGRITY,
  END_REASONS,
  FIELD_VERSION,
  LAUNCHER_INSET_X,
  MATCH_STATUS,
  MAX_HP,
  MAX_STRUCTURE_BLOCKS_PER_SEAT,
  MIN_PLAYER_SEPARATION,
  MOVE_DIRECTIONS,
  MOVE_EDGE_MARGIN,
  MOVE_RANGE,
  MOVE_STEP,
  OPENING_ACTIONS,
  PLAYER_RADIUS,
  POWERUP_BLAST_MULTIPLIER,
  POWERUP_DAMAGE_MULTIPLIER,
  POWERUP_HEAL_AMOUNT,
  POWERUP_KINDS,
  POWERUP_RADIUS,
  POWERUP_RESPAWN_TURNS,
  REJECTION,
  SEATS,
  STRUCTURE_BLOCK_SIZE,
  SUPPORT_TOLERANCE,
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
  Buffs,
  BuildRecord,
  EndReason,
  HillstrikeAction,
  HillstrikeState,
  MatchStatus,
  MoveDirection,
  MoveRecord,
  PickupRespawn,
  PowerUp,
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

/** A seat's armed buffs, tolerant of a state written before v3 (none armed). */
export function buffsOf(state: HillstrikeState, seat: Seat): Buffs {
  const buffs = (state as { buffs?: Record<string, Partial<Buffs>> }).buffs?.[seat];
  return {
    doubleDamage: buffs?.doubleDamage === true,
    doubleBlast: buffs?.doubleBlast === true,
  };
}

/** Both seats' buffs, normalised (see `buffsOf`). */
export function buffsMapOf(state: HillstrikeState): Record<Seat, Buffs> {
  return { player1: buffsOf(state, "player1"), player2: buffsOf(state, "player2") };
}

/** The pickups still on the field (a v2 battlefield carries none). */
export function pickupsOf(battlefield: Battlefield | null | undefined): readonly PowerUp[] {
  const pickups = (battlefield as { pickups?: unknown } | null | undefined)?.pickups;
  return Array.isArray(pickups) ? (pickups as readonly PowerUp[]) : [];
}

/** The collected pickups waiting to come back (a pre-timer battlefield carries none). */
export function respawnsOf(
  battlefield: Battlefield | null | undefined,
): readonly PickupRespawn[] {
  const respawns = (battlefield as { respawns?: unknown } | null | undefined)?.respawns;
  return Array.isArray(respawns) ? (respawns as readonly PickupRespawn[]) : [];
}

/** True when a block is sitting close enough to a spot to bury a pickup there. */
function buriedAt(battlefield: Battlefield, x: number, y: number): boolean {
  for (const block of battlefield.blocks) {
    const nearestX = Math.max(block.x, Math.min(x, block.x + block.size));
    const nearestY = Math.max(block.y, Math.min(y, block.y + block.size));
    if (Math.hypot(x - nearestX, y - nearestY) <= POWERUP_RADIUS) return true;
  }
  return false;
}

/**
 * Bring back the middle: every due respawn returns to the field if its spot is
 * still free.
 *
 * The timer is measured in ACTIONS (`turnIndex`), so it advances exactly once per
 * resolved action and is reproducible from the stored state alone. A spot with a
 * cover block on it is held until the block is broken — the engine never drops a
 * pickup inside a block — which is a legitimate second reason to shoot at cover.
 */
function settleRespawns(
  battlefield: Battlefield,
  turnIndex: number,
): { pickups: readonly PowerUp[]; respawns: readonly PickupRespawn[] } {
  const waiting = respawnsOf(battlefield);
  if (waiting.length === 0) return { pickups: battlefield.pickups, respawns: waiting };

  const pickups = [...pickupsOf(battlefield)];
  const still: PickupRespawn[] = [];
  for (const ticket of [...waiting].sort((a, b) => a.id - b.id)) {
    if (ticket.atTurn > turnIndex) {
      still.push(ticket);
      continue;
    }
    // Already back (a duplicated ticket can never double-deal a pickup).
    if (pickups.some((pickup) => pickup.id === ticket.id)) continue;
    if (buriedAt(battlefield, ticket.x, ticket.y)) {
      still.push({ ...ticket, atTurn: turnIndex + 1 });
      continue;
    }
    pickups.push({ id: ticket.id, kind: ticket.kind, x: ticket.x, y: ticket.y });
  }
  return { pickups, respawns: still };
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
  const buffs: Record<Seat, Buffs> = {
    player1: { doubleDamage: false, doubleBlast: false },
    player2: { doubleDamage: false, doubleBlast: false },
  };

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
    buffs,
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
  // The leash is clamped by the map as well as by MOVE_RANGE: the doubled
  // battlefield reaches the middle, and no drive may ever leave the field.
  const lower = Math.max(spawn - MOVE_RANGE, MOVE_EDGE_MARGIN + PLAYER_RADIUS);
  const upper = Math.min(
    spawn + MOVE_RANGE,
    BATTLEFIELD_WIDTH - MOVE_EDGE_MARGIN - PLAYER_RADIUS,
  );
  const x = Math.round(Math.min(Math.max(wanted, lower), upper));
  if (x === Math.round(player.x)) return null;

  // The duel keeps its distance: a drive may never bring the two tanks closer
  // than MIN_PLAYER_SEPARATION. Enforced HERE, at the only place a position can
  // change, so the battlefield a shot is simulated on can never be invalid.
  const enemy = state.battlefield.players[otherSeat(seat)];
  if (enemy && Math.abs(x - enemy.x) < MIN_PLAYER_SEPARATION) return null;

  const y = surfaceYAt(state.battlefield.terrain, x);
  if (tankOverlapsBlock(x, y, state.battlefield.blocks)) return null;
  return { x, y };
}

/** A resolved placement: one cover block's top-left corner and size. */
export interface BuildPlacement {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

/** A refused placement, with the engine's own rejection code. */
export type BuildPlacementVerdict =
  | { readonly ok: true; readonly placement: BuildPlacement }
  | { readonly ok: false; readonly code: RejectionCode; readonly message: string };

const COVER_SIZE = STRUCTURE_BLOCK_SIZE;

/** True when a block of `size` at `x` is entirely on `seat`'s half. */
export function isOwnHalf(seat: Seat, x: number, size = COVER_SIZE): boolean {
  const half = BATTLEFIELD_WIDTH / 2;
  return seat === "player1" ? x + size <= half : x >= half;
}

function blockKindOf(block: TowerBlock): "cover" | "roof" {
  return block.kind === "roof" ? "roof" : "cover";
}

function blocksOverlapAt(x: number, y: number, size: number, block: TowerBlock): boolean {
  return (
    x < block.x + block.size &&
    block.x < x + size &&
    y < block.y + block.size &&
    block.y < y + size
  );
}

/**
 * Resolve a requested build point into a legal placement, or the reason it is
 * illegal.
 *
 * The MAP decides the vertical: a cover block must REST on something, so the
 * column chosen by `requestX` offers its support surfaces — the ground under the
 * footprint and the tops of any blocks already there — and the one nearest the
 * requested `y` is used. That is what makes "place a block anywhere on your own
 * half" both free and well-defined: you pick the column and the stack, the engine
 * picks the legal resting height, and a click in mid-air snaps down to the
 * nearest support instead of floating.
 *
 * Refused, in this order: a non-finite point, a column off the map, the
 * opponent's half, a stack with no free space (a tank or a block is in the way),
 * and any leftover geometry that cannot support the block.
 */
export function resolveBuildPlacement(
  state: HillstrikeState,
  seat: Seat,
  requestX: unknown,
  requestY: unknown,
): BuildPlacementVerdict {
  if (typeof requestX !== "number" || !Number.isFinite(requestX)) {
    return { ok: false, code: REJECTION.INVALID_BUILD, message: "A build needs a finite x" };
  }
  if (typeof requestY !== "number" || !Number.isFinite(requestY)) {
    return { ok: false, code: REJECTION.INVALID_BUILD, message: "A build needs a finite y" };
  }

  const size = COVER_SIZE;
  const x = Math.round(requestX / size) * size;
  const wantsBottom = requestY + size;

  if (x < 0 || x + size > BATTLEFIELD_WIDTH) {
    return {
      ok: false,
      code: REJECTION.BUILD_OUT_OF_BOUNDS,
      message: "That column is off the battlefield",
    };
  }
  if (!isOwnHalf(seat, x, size)) {
    return {
      ok: false,
      code: REJECTION.BUILD_OPPONENT_HALF,
      message: "You may only build on your own half of the map",
    };
  }

  const terrain = state.battlefield.terrain;
  const blocks = state.battlefield.blocks;

  // Every surface a cover block could rest on in this column.
  const supports: number[] = [groundYUnder(terrain, x, size)];
  for (const block of blocks) {
    const overlap = Math.min(x + size, block.x + block.size) - Math.max(x, block.x);
    if (overlap < size / 2) continue;
    supports.push(block.y);
  }
  supports.sort((a, b) => Math.abs(a - wantsBottom) - Math.abs(b - wantsBottom) || a - b);

  let blocked = false;
  for (const support of supports) {
    const y = support - size;
    if (y < 0 || y + size > BATTLEFIELD_HEIGHT) continue;
    // A support that is BELOW the current surface is buried ground: skip it.
    if (y + size > groundYUnder(terrain, x, size) + SUPPORT_TOLERANCE) continue;
    if (blocks.some((block) => blocksOverlapAt(x, y, size, block))) {
      blocked = true;
      continue;
    }
    if (tankOverlapsPlayer(x, y, state)) {
      blocked = true;
      continue;
    }
    return { ok: true, placement: { x, y, size } };
  }

  return blocked
    ? { ok: false, code: REJECTION.BUILD_OVERLAP, message: "Something is already in that space" }
    : { ok: false, code: REJECTION.BUILD_UNSUPPORTED, message: "A block must rest on the ground or another block" };
}

/** True when a block at `(x, y)` would overlap either tank's hull. */
function tankOverlapsPlayer(
  x: number,
  y: number,
  state: HillstrikeState,
): boolean {
  for (const seat of SEATS) {
    const player = state.battlefield.players[seat];
    if (!player) continue;
    const centreX = player.x;
    const centreY = player.y - PLAYER_RADIUS;
    const nearestX = Math.max(x, Math.min(centreX, x + COVER_SIZE));
    const nearestY = Math.max(y, Math.min(centreY, y + COVER_SIZE));
    const dx = centreX - nearestX;
    const dy = centreY - nearestY;
    if (dx * dx + dy * dy < PLAYER_RADIUS * PLAYER_RADIUS) return true;
  }
  return false;
}

/**
 * The build a UI (or the bot) would place by default: the nearest legal column in
 * front of the tank, walking outward up to six tiles. Returns `null` when the
 * whole arc is occupied.
 */
export function buildPlacementFor(
  state: HillstrikeState,
  seat: Seat,
): BuildPlacement | null {
  const player = state.battlefield.players[seat];
  if (!player) return null;
  const sign = forwardSignFor(seat);
  const size = COVER_SIZE;
  const baseX =
    sign > 0
      ? Math.round((player.x + PLAYER_RADIUS) / size) * size
      : Math.round((player.x - PLAYER_RADIUS - size) / size) * size;

  for (let step = 0; step < 6; step++) {
    const requestX = baseX + sign * step * size;
    const requestY =
      groundYUnder(state.battlefield.terrain, requestX, size) - size;
    const verdict = resolveBuildPlacement(state, seat, requestX, requestY);
    if (verdict.ok) return verdict.placement;
  }
  return null;
}

/** How many COVER blocks a seat has placed (base roofs are not build budget). */
export function blockCountFor(state: HillstrikeState, seat: Seat): number {
  let count = 0;
  for (const block of state.battlefield.blocks) {
    if (block.seat === seat && blockKindOf(block) === "cover") count += 1;
  }
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
  const { x: buildX, y: buildY } = action as { x?: unknown; y?: unknown };
  if (typeof buildX === "undefined" || typeof buildY === "undefined") {
    return {
      ok: false,
      code: REJECTION.INVALID_BUILD,
      message: "A build must name the tile to place (x, y)",
    };
  }
  if (blockCountFor(state, seat) >= MAX_STRUCTURE_BLOCKS_PER_SEAT) {
    return {
      ok: false,
      code: REJECTION.BLOCK_LIMIT,
      message: "You have placed all the blocks your side allows",
    };
  }
  const placement = resolveBuildPlacement(state, seat, buildX, buildY);
  if (!placement.ok) {
    // `strict` is off in this repo, so the union is not narrowed here.
    const denied = placement as Extract<BuildPlacementVerdict, { ok: false }>;
    return { ok: false, code: denied.code, message: denied.message };
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
  buffs,
  battlefield,
  lastAction,
  turnIndex,
}: {
  state: HillstrikeState;
  turnAdvance: TurnAdvance;
  hp: Record<Seat, number>;
  buffs: Record<Seat, Buffs>;
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
    buffs,
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
  const buffs = buffsMapOf(state);
  const armed = buffs[seat];
  const simulation = simulateShot({
    battlefield: state.battlefield,
    shooterSeat: seat,
    shot: input,
    projectile: state.projectile,
    // `double-blast` is the ONLY thing that scales a blast; distance is a dial
    // for tank damage and nothing else.
    blastScale: armed.doubleBlast ? POWERUP_BLAST_MULTIPLIER : 1,
  });

  const hp = hpMapOf(state);
  const events: ShotEvent[] = [...simulation.events];

  // Both weapon buffs are spent by FIRING — hit or miss.
  const nextBuffs: Record<Seat, Buffs> = {
    ...buffs,
    [seat]: { doubleDamage: false, doubleBlast: false },
  };

  const hitSeat =
    simulation.impact.kind === "player" ? simulation.impact.target : null;
  let damage = 0;
  if (hitSeat) {
    // The one distance-sensitive number in the game, doubled while
    // `double-damage` is armed.
    const scaled = Math.round(
      damageForDistance(simulation.distance) *
        (armed.doubleDamage ? POWERUP_DAMAGE_MULTIPLIER : 1),
    );
    damage = Math.min(hp[hitSeat], scaled);
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
    buffs: armed,
  };

  return {
    state: composeState({
      state,
      turnAdvance,
      hp,
      buffs: nextBuffs,
      battlefield: { ...simulation.battlefield, ...settleRespawns(simulation.battlefield, turnIndex) },
      lastAction,
      turnIndex,
    }),
    events,
  };
}

/**
 * Collect the one pickup a tank has driven onto, if any.
 *
 * One per drive, and it is the drive's PATH that collects, not just where the
 * tank stopped: a step that crosses a lane picks it up even if the tank finishes
 * a few units past it. "Drive over it" is what a player sees, and it also means
 * a long step can never hop clean over a pickup. Picking the lowest id keeps the
 * choice deterministic if a layout ever did stack two.
 *
 * A collected pickup leaves a RESPAWN TICKET behind: the middle deals it again
 * `POWERUP_RESPAWN_TURNS` actions later, so a buff is a contested resource for
 * the whole match instead of a one-off. The ticket carries the same id, kind and
 * spot, which keeps the layout mirror-symmetric across respawns.
 */
function collectPickup({
  state,
  seat,
  x,
  y,
  hp,
  buffs,
  tick,
  events,
}: {
  state: HillstrikeState;
  seat: Seat;
  x: number;
  y: number;
  hp: Record<Seat, number>;
  buffs: Record<Seat, Buffs>;
  tick: number;
  events: ShotEvent[];
}): { pickups: readonly PowerUp[]; respawns: readonly PickupRespawn[] } {
  const bodyY = y - PLAYER_RADIUS;
  const from = state.battlefield.players[seat];
  const fromX = from ? from.x : x;
  const fromY = from ? from.y - PLAYER_RADIUS : bodyY;
  const pickups = pickupsOf(state.battlefield);
  const respawns = respawnsOf(state.battlefield);
  const hit = [...pickups]
    .sort((a, b) => a.id - b.id)
    .find(
      (pickup) =>
        distanceToSegment(pickup.x, pickup.y, fromX, fromY, x, bodyY) <= POWERUP_RADIUS,
    );
  if (!hit) return { pickups, respawns };

  events.push({
    type: "pickup-collected",
    tick,
    seat,
    pickupId: hit.id,
    kind: hit.kind,
    x: hit.x,
    y: hit.y,
  });

  if (hit.kind === POWERUP_KINDS.HEAL) {
    const amount = Math.max(0, Math.min(MAX_HP, hp[seat] + POWERUP_HEAL_AMOUNT) - hp[seat]);
    hp[seat] += amount;
    events.push({ type: "healed", tick, seat, hp: hp[seat], amount });
  } else if (hit.kind === POWERUP_KINDS.DOUBLE_DAMAGE) {
    buffs[seat] = { ...buffs[seat], doubleDamage: true };
  } else {
    buffs[seat] = { ...buffs[seat], doubleBlast: true };
  }

  return {
    pickups: pickups.filter((pickup) => pickup.id !== hit.id),
    respawns: [
      ...respawns.filter((ticket) => ticket.id !== hit.id),
      {
        id: hit.id,
        kind: hit.kind,
        x: hit.x,
        y: hit.y,
        atTurn: tick + POWERUP_RESPAWN_TURNS,
      },
    ],
  };
}

/** How far a point is from a line segment (the drive's swept path). */
function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/** A drive: move the tank along the surface, collect a pickup, and advance. */
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

  const hp = hpMapOf(state);
  const buffs = buffsMapOf(state);
  const collected = collectPickup({
    state,
    seat,
    x: target.x,
    y: target.y,
    hp,
    buffs,
    tick,
    events,
  });

  const turnIndex = Number(state.turnIndex) + 1;
  const turnAdvance = advanceTurn(state, seat, { knockedOut: false, tick });
  if (turnAdvance.finishedEvent) events.push(turnAdvance.finishedEvent);

  const battlefield: Battlefield = {
    ...state.battlefield,
    ...collected,
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
      hp,
      buffs,
      battlefield: { ...battlefield, ...settleRespawns(battlefield, turnIndex) },
      lastAction,
      turnIndex,
    }),
    events,
  };
}

/** A build: place one cover block at the chosen tile and advance. */
function applyBuild(
  state: HillstrikeState,
  seat: Seat,
  action: { readonly x: unknown; readonly y: unknown },
): ApplyActionResult {
  const verdict = resolveBuildPlacement(state, seat, action.x, action.y);
  if (!verdict.ok) {
    const denied = verdict as Extract<BuildPlacementVerdict, { ok: false }>;
    throw new HillstrikeRuleError(denied.code, denied.message);
  }
  const placement = (verdict as Extract<BuildPlacementVerdict, { ok: true }>).placement;
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
    kind: "cover",
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
  // A build can land on a spot that was about to respawn: the timer waits, so a
  // well-placed block delays the middle instead of breaking the schedule.

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
      buffs: buffsMapOf(state),
      battlefield: { ...battlefield, ...settleRespawns(battlefield, turnIndex) },
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
  return applyBuild(state, actor, input as Extract<HillstrikeAction, { type: "build" }>);
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
