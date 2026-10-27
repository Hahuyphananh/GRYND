/**
 * Hillstrike — deterministic battlefield construction, terrain queries and
 * battlefield validation.
 *
 * This module is the ONLY place a seed is read. It uses the shared
 * `mulberry32` / `hashSeed` primitives from `src/lib/physics2d/deterministic.ts`
 * (the same generators the platform's other authoritative simulations use), so
 * `createBattlefield(seed)` produces a byte-identical battlefield in every
 * runtime, forever, for a given `FIELD_VERSION`.
 *
 * ── FAIRNESS ───────────────────────────────────────────────────────────────
 * The battlefield is MIRROR-SYMMETRIC about the centre column: the generator
 * builds one half and mirrors it. Both seats therefore stand on identical
 * ground with identical towers, and the only asymmetry in a match is who won
 * the opening-seat draw (recorded in the match state). That is the property
 * that makes "every match generates a new, fair, reproducible layout" true
 * rather than aspirational.
 *
 * ── TERRAIN REPRESENTATION ─────────────────────────────────────────────────
 * `terrain[c]` is the surface y of column `c`, a solid step from that y down to
 * `BATTLEFIELD_HEIGHT` across `x ∈ [c·5, (c+1)·5)`. Integer heights, no
 * polygons, no interpolation: the ground a projectile meets is exactly the
 * ground a player sees, and carving it is an integer operation.
 *
 * Nothing here touches React, HTTP, a database or the browser.
 */

import { clamp } from "../physics2d/kinematics";
import { hashSeed, mulberry32 } from "../physics2d/deterministic";
import {
  BASE_ROOF_BLOCKS,
  BASE_ROOF_CLEARANCE,
  BATTLEFIELD_HEIGHT,
  BATTLEFIELD_WIDTH,
  BLOCK_MAX_INTEGRITY,
  FIELD_VERSION,
  LAUNCHER_INSET_X,
  MAX_POWERUPS,
  MAX_STRUCTURE_BLOCKS,
  MAX_TOWER_BLOCKS,
  MIN_PLAYER_SEPARATION,
  POWERUP_KINDS,
  POWERUP_LANE_GAP,
  SEATS,
  SPAWN_SURFACE_Y,
  STRUCTURE_BLOCK_SIZE,
  TERRAIN_COLUMNS,
  TERRAIN_COLUMN_WIDTH,
  TERRAIN_MAX_STEP,
  TERRAIN_MAX_SURFACE_Y,
  TERRAIN_MIN_SURFACE_Y,
  TERRAIN_PLATEAU_COLUMNS,
  TOWER_BLOCK_INTEGRITY,
  TOWER_COLUMNS,
  TOWER_TOP_Y,
} from "./constants";
import type {
  Battlefield,
  BattlefieldVerdict,
  BlockKind,
  Player,
  PowerUp,
  PowerUpKind,
  Seat,
  TowerBlock,
} from "./types";

/** Columns per mirrored half (the generator only ever shapes one). */
const HALF_COLUMNS = TERRAIN_COLUMNS / 2;

/** Control points per half, including both ends. */
const PROFILE_KEYS = 9;

/**
 * The climb from the spawn shelf to the centre mound, per profile key.
 *
 * Always UPWARD (a key can never drift back toward the spawn), so every layout
 * has the same shape: a low roofed base in a valley and a high middle to fight
 * over. The jitter only decides how steep and how tall.
 */
const PROFILE_CLIMB_MIN = 14;
const PROFILE_CLIMB_SPAN = 58;

/** How far a pickup's centre floats above the ground it rests on. */
const PICKUP_LIFT = 14;

/**
 * The power-up lanes on ONE side of the middle tower: one of each kind, the
 * nearest just outside the tower's face. Mirrored onto the other side, so each
 * seat has its own complete set and neither can be cut off from a buff.
 */
const POWERUP_SIDE_LANES: ReadonlyArray<{ kind: PowerUpKind; lane: number }> = [
  { kind: POWERUP_KINDS.HEAL, lane: 1 },
  { kind: POWERUP_KINDS.DOUBLE_DAMAGE, lane: 2 },
  { kind: POWERUP_KINDS.DOUBLE_BLAST, lane: 3 },
];

/** The seed space: the same 32-bit unsigned range `randomInt` can draw from. */
const MAX_SEED = 0xffffffff;

// ──────────────────────────────────────────────────────────────────────────
// Terrain queries
// ──────────────────────────────────────────────────────────────────────────

/** Column index containing world x, clamped into the battlefield. */
export function columnIndexAt(x: number): number {
  if (!Number.isFinite(x)) return 0;
  const clampedX = clamp(x, 0, BATTLEFIELD_WIDTH - 1e-9);
  const column = Math.floor(clampedX / TERRAIN_COLUMN_WIDTH);
  return clamp(column, 0, TERRAIN_COLUMNS - 1);
}

/** Surface y at world x (the top of the solid column containing x). */
export function surfaceYAt(terrain: readonly number[], x: number): number {
  return terrain[columnIndexAt(x)];
}

/**
 * The support height under a footprint `[x, x + width]`: the HIGHEST ground
 * point it covers (the smallest surface y).
 *
 * A block resting on a slope stands on the highest column it touches, which is
 * both stable and deterministic — the alternative (average, or the lowest
 * point) would let a block float over a crater edge.
 */
export function groundYUnder(
  terrain: readonly number[],
  x: number,
  width: number,
): number {
  const from = columnIndexAt(x);
  const to = columnIndexAt(x + Math.max(0, width) - 1e-9);
  let top = Number.POSITIVE_INFINITY;
  for (let column = from; column <= to; column++) {
    if (terrain[column] < top) top = terrain[column];
  }
  return top;
}

// ──────────────────────────────────────────────────────────────────────────
// Generation
// ──────────────────────────────────────────────────────────────────────────

/** Validate a seed before it is used. Throws: this is a caller bug, not input. */
export function assertSeed(seed: unknown): number {
  if (typeof seed !== "number" || !Number.isInteger(seed)) {
    throw new TypeError(`hillstrike generation: seed must be an integer, got ${String(seed)}`);
  }
  if (seed < 0 || seed > MAX_SEED) {
    throw new RangeError(
      `hillstrike generation: seed must be in [0, ${MAX_SEED}], got ${seed}`,
    );
  }
  return seed;
}

/**
 * The seed the generator actually consumes. Including `FIELD_VERSION` means a
 * tuning change produces a DIFFERENT battlefield rather than silently altering
 * every stored match's replay.
 */
export function fieldSeedFor(seed: number): number {
  return hashSeed(`hillstrike:field:v${FIELD_VERSION}:${assertSeed(seed)}`);
}

/** The seat that wins a given seed's opening-seat draw (deterministic). */
export function openingSeatFor(seed: number): Seat {
  return hashSeed(`hillstrike:seat:v${FIELD_VERSION}:${assertSeed(seed)}`) % 2 === 0
    ? "player1"
    : "player2";
}

/**
 * A mirrored half profile that climbs from the spawn shelf to the centre.
 *
 * The spawn end is pinned to `SPAWN_SURFACE_Y` (the LOW ground) and every later
 * key rises, so the middle of the map is always higher than either base. That is
 * the terrain half of "you cannot win from your base": to bring a gun to bear on
 * the far hill — or to reach a power-up — a tank has to climb into the open.
 */
function buildHalfProfile(rand: () => number): number[] {
  const keys: number[] = [SPAWN_SURFACE_Y];
  for (let index = 1; index < PROFILE_KEYS; index++) {
    const climb =
      PROFILE_CLIMB_MIN + rand() * PROFILE_CLIMB_SPAN;
    keys.push(
      clamp(
        Math.round(keys[index - 1] - climb),
        TERRAIN_MIN_SURFACE_Y,
        SPAWN_SURFACE_Y,
      ),
    );
  }

  const half: number[] = new Array(HALF_COLUMNS);
  for (let column = 0; column < HALF_COLUMNS; column++) {
    const t = (column / (HALF_COLUMNS - 1)) * (PROFILE_KEYS - 1);
    const segment = Math.min(PROFILE_KEYS - 2, Math.floor(t));
    const fraction = t - segment;
    half[column] = clamp(
      Math.round(keys[segment] + (keys[segment + 1] - keys[segment]) * fraction),
      TERRAIN_MIN_SURFACE_Y,
      TERRAIN_MAX_SURFACE_Y,
    );
  }

  // Both launchers stand on the same flat shelf at the bottom of the valley: the
  // first columns are pinned to the profile's opening height before the step
  // clamp runs.
  for (let column = 0; column < TERRAIN_PLATEAU_COLUMNS; column++) {
    half[column] = SPAWN_SURFACE_Y;
  }

  // Bound the slope. The forward pass alone keeps every step ≤ TERRAIN_MAX_STEP
  // and cannot leave the height range, because clamp() pins the result.
  for (let column = 1; column < HALF_COLUMNS; column++) {
    half[column] = clamp(
      half[column],
      half[column - 1] - TERRAIN_MAX_STEP,
      half[column - 1] + TERRAIN_MAX_STEP,
    );
  }
  return half;
}

/** The x a seat's tank spawns on (its roof is centred over it). */
function spawnXForSeat(seat: Seat): number {
  return seat === "player1" ? LAUNCHER_INSET_X : BATTLEFIELD_WIDTH - LAUNCHER_INSET_X;
}

/**
 * Build one seat's BASE ROOF: an indestructible ceiling over the spawn.
 *
 * It is `BASE_ROOF_BLOCKS` wide, centred on the spawn column, with its underside
 * `BASE_ROOF_CLEARANCE` above the flat shelf. A tank can fire out from under it
 * along a shallow arc, but a steep drop onto the spawn meets the roof — so nobody
 * gets sniped inside their own base, and nobody can stay there and snipe either
 * (the roof is fixed, so leaving the base means leaving its cover).
 */
function buildBaseRoof(terrain: readonly number[], seat: Seat, nextId: number): TowerBlock[] {
  const size = STRUCTURE_BLOCK_SIZE;
  const span = BASE_ROOF_BLOCKS * size;
  const centreX = spawnXForSeat(seat);
  const left = Math.round(centreX - span / 2);
  const groundY = groundYUnder(terrain, left, span);
  const bottom = groundY - BASE_ROOF_CLEARANCE;

  const blocks: TowerBlock[] = [];
  let id = nextId;
  for (let column = 0; column < BASE_ROOF_BLOCKS; column++) {
    blocks.push({
      id: id++,
      seat,
      kind: "roof",
      x: left + column * size,
      y: bottom - size,
      size,
      integrity: BLOCK_MAX_INTEGRITY,
    });
  }
  return blocks;
}

/**
 * The deepening ground under a footprint `[x, x + width]`: the LOWEST surface
 * point it covers (the largest surface y).
 *
 * The tower needs it: it stands on the middle mound, and its base has to reach the
 * deepest column it spans, or a shell could thread the wedge of slope under a
 * base pinned to the highest point.
 */
export function groundBottomUnder(
  terrain: readonly number[],
  x: number,
  width: number,
): number {
  const from = columnIndexAt(x);
  const to = columnIndexAt(x + Math.max(0, width) - 1e-9);
  let bottom = Number.NEGATIVE_INFINITY;
  for (let column = from; column <= to; column++) {
    if (terrain[column] > bottom) bottom = terrain[column];
  }
  return bottom;
}

/** The tower's horizontal span: three block columns, centred on the map. */
export function towerSpan(): { left: number; width: number } {
  const width = TOWER_COLUMNS * STRUCTURE_BLOCK_SIZE;
  return { left: Math.round(BATTLEFIELD_WIDTH / 2 - width / 2), width };
}

/**
 * The middle TOWER: the wall that gates the map.
 *
 * It is anchored to the sky (`TOWER_TOP_Y`) down to the deepest ground under its
 * footprint, so every crossing trajectory meets a block or the hill: a shot aimed
 * high leaves the top of the battlefield and is out of bounds. Each block takes
 * `TOWER_BLOCK_INTEGRITY` hits and NONE of them ever collapses, so a lane shot
 * through the tower stays a hole instead of being plugged by the blocks above.
 *
 * The last row is BEDDED into the hill (it runs a little past the deepest surface
 * under the footprint) on purpose: stopping the column at the last whole row would
 * leave a slot up to one block tall between the tower's foot and the ground, and a
 * flat shot could thread it without ever touching the tower.
 */
function createMiddleTower(terrain: readonly number[], nextId: number): TowerBlock[] {
  const size = STRUCTURE_BLOCK_SIZE;
  const { left, width } = towerSpan();
  const bottom = groundBottomUnder(terrain, left, width);

  const blocks: TowerBlock[] = [];
  let id = nextId;
  for (let column = 0; column < TOWER_COLUMNS; column++) {
    for (let y = TOWER_TOP_Y; y < bottom; y += size) {
      blocks.push({
        id: id++,
        // The tower belongs to nobody: it gates both seats equally.
        seat: null,
        kind: "tower",
        x: left + column * size,
        y,
        size,
        integrity: TOWER_BLOCK_INTEGRITY,
      });
    }
  }
  return blocks;
}

/**
 * The middle's power-ups: one of each kind on EACH side of the tower, so a heal,
 * a double-damage and a double-blast are within reach of both seats.
 *
 * Deterministic from the terrain, so the same seed always deals the same middle,
 * and they are dealt once — collecting one leaves an empty lane for the rest of
 * the match.
 */
function createPowerUps(terrain: readonly number[]): PowerUp[] {
  const centre = BATTLEFIELD_WIDTH / 2;
  const pickups: PowerUp[] = [];
  let id = 1;
  for (const side of [-1, 1] as const) {
    for (const lane of POWERUP_SIDE_LANES) {
      const x = Math.round(centre + side * POWERUP_LANE_GAP * lane.lane);
      pickups.push({
        id: id++,
        kind: lane.kind,
        x,
        y: surfaceYAt(terrain, x) - PICKUP_LIFT,
      });
    }
  }
  return pickups;
}

/**
 * Create a complete battlefield from a seed.
 *
 * The result is a frozen-in-practice plain object (the state that owns it is
 * deeply frozen by `./rules`). `createBattlefield` validates its own output
 * before returning, so a generator bug fails here instead of in a live match.
 */
export function createBattlefield(seed: number): Battlefield {
  assertSeed(seed);
  const rand = mulberry32(fieldSeedFor(seed));
  const half = buildHalfProfile(rand);
  const terrain = [...half, ...[...half].reverse()];

  const player1X = LAUNCHER_INSET_X;
  const player2X = BATTLEFIELD_WIDTH - LAUNCHER_INSET_X;
  const players: Record<Seat, Player> = {
    player1: { seat: "player1", x: player1X, y: surfaceYAt(terrain, player1X) },
    player2: { seat: "player2", x: player2X, y: surfaceYAt(terrain, player2X) },
  };

  const player1Roof = buildBaseRoof(terrain, "player1", 1);
  const player2Roof = buildBaseRoof(terrain, "player2", player1Roof.length + 1);
  const tower = createMiddleTower(terrain, player2Roof.length + player1Roof.length + 1);

  const battlefield: Battlefield = {
    version: FIELD_VERSION,
    seed,
    width: BATTLEFIELD_WIDTH,
    height: BATTLEFIELD_HEIGHT,
    terrain,
    blocks: [...player1Roof, ...player2Roof, ...tower],
    pickups: createPowerUps(terrain),
    players,
  };

  const verdict = validateBattlefield(battlefield);
  if (!verdict.ok) {
    // `strict` is off in this repo, so a discriminated union is not narrowed by
    // `if (!verdict.ok)`; the cast keeps the failure message type-safe.
    const denied = verdict as Extract<BattlefieldVerdict, { ok: false }>;
    throw new Error(`hillstrike generation: generated an invalid battlefield — ${denied.message}`);
  }
  return battlefield;
}

// ──────────────────────────────────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────────────────────────────────

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isValidSeat(value: unknown): value is Seat {
  return value === "player1" || value === "player2";
}

function blocksOverlap(a: TowerBlock, b: TowerBlock): boolean {
  return (
    a.x < b.x + b.size &&
    b.x < a.x + a.size &&
    a.y < b.y + b.size &&
    b.y < a.y + a.size
  );
}

/**
 * Validate a battlefield — used by the generator on its own output and by
 * callers that load a battlefield from storage.
 *
 * It rejects everything a hand-edited or corrupted row could contain: wrong
 * dimensions, a terrain array of the wrong length or out of range, non-integer
 * heights, spawn points off the ground or too close together, a block outside
 * the field, a duplicate block id, more blocks than the cap, overlapping
 * blocks, and a non-positive integrity.
 */
export function validateBattlefield(battlefield: unknown): BattlefieldVerdict {
  if (!battlefield || typeof battlefield !== "object") {
    return { ok: false, code: "not-an-object", message: "battlefield must be an object" };
  }
  const field = battlefield as Partial<Battlefield>;

  if (!isFiniteInteger(field.version) || field.version < 1) {
    return { ok: false, code: "invalid-version", message: "battlefield.version must be a positive integer" };
  }
  if (!isFiniteInteger(field.seed) || field.seed < 0 || field.seed > MAX_SEED) {
    return { ok: false, code: "invalid-seed", message: "battlefield.seed must be a 32-bit unsigned integer" };
  }
  if (field.width !== BATTLEFIELD_WIDTH || field.height !== BATTLEFIELD_HEIGHT) {
    return {
      ok: false,
      code: "invalid-dimensions",
      message: `battlefield must be ${BATTLEFIELD_WIDTH}×${BATTLEFIELD_HEIGHT}`,
    };
  }

  const terrain = field.terrain;
  if (!Array.isArray(terrain) || terrain.length !== TERRAIN_COLUMNS) {
    return {
      ok: false,
      code: "invalid-terrain",
      message: `battlefield.terrain must be an array of ${TERRAIN_COLUMNS} heights`,
    };
  }
  for (let column = 0; column < terrain.length; column++) {
    const surface = terrain[column];
    if (
      !isFiniteInteger(surface) ||
      surface < TERRAIN_MIN_SURFACE_Y ||
      surface > TERRAIN_MAX_SURFACE_Y
    ) {
      return {
        ok: false,
        code: "invalid-terrain",
        message: `battlefield.terrain[${column}] must be an integer in [${TERRAIN_MIN_SURFACE_Y}, ${TERRAIN_MAX_SURFACE_Y}]`,
      };
    }
  }

  const players = field.players;
  if (!players || typeof players !== "object") {
    return { ok: false, code: "invalid-players", message: "battlefield.players is required" };
  }
  for (const seat of SEATS) {
    const player = (players as Record<string, Partial<Player> | undefined>)[seat];
    if (!player || player.seat !== seat) {
      return { ok: false, code: "invalid-players", message: `battlefield.players.${seat} is missing or mislabelled` };
    }
    if (
      typeof player.x !== "number" ||
      !Number.isFinite(player.x) ||
      player.x < 0 ||
      player.x > BATTLEFIELD_WIDTH
    ) {
      return { ok: false, code: "invalid-players", message: `battlefield.players.${seat}.x is off the battlefield` };
    }
    if (player.y !== surfaceYAt(terrain, player.x)) {
      return {
        ok: false,
        code: "invalid-spawn",
        message: `battlefield.players.${seat} is not standing on the terrain surface`,
      };
    }
  }
  if (
    Math.abs((players as Record<Seat, Player>).player1.x - (players as Record<Seat, Player>).player2.x) <
    MIN_PLAYER_SEPARATION
  ) {
    return {
      ok: false,
      code: "invalid-spawn",
      message: `spawn points must be at least ${MIN_PLAYER_SEPARATION} apart`,
    };
  }

  const blocks = field.blocks;
  if (!Array.isArray(blocks) || blocks.length > MAX_STRUCTURE_BLOCKS) {
    return {
      ok: false,
      code: "invalid-blocks",
      message: `battlefield.blocks must be an array of at most ${MAX_STRUCTURE_BLOCKS} blocks`,
    };
  }
  const ids = new Set<number>();
  const roofPerSeat: Record<Seat, number> = { player1: 0, player2: 0 };
  let towerBlocks = 0;
  for (const block of blocks as Partial<TowerBlock>[]) {
    if (!block || typeof block !== "object") {
      return { ok: false, code: "invalid-blocks", message: "every block must be an object" };
    }
    if (!isFiniteInteger(block.id) || block.id < 1 || ids.has(block.id)) {
      return { ok: false, code: "invalid-blocks", message: "block ids must be unique positive integers" };
    }
    ids.add(block.id);
    // A v2 row has no `kind`: it is cover, which is what it was.
    const kind: BlockKind | undefined =
      block.kind === undefined ? "cover" : block.kind;
    if (kind !== "cover" && kind !== "roof" && kind !== "tower") {
      return { ok: false, code: "invalid-blocks", message: `block ${block.id} has an invalid kind` };
    }
    if (kind === "tower") {
      // The middle tower is nobody's: a seat here would read as a player's cover.
      if (block.seat !== null) {
        return {
          ok: false,
          code: "invalid-blocks",
          message: `tower block ${block.id} must not belong to a seat`,
        };
      }
    } else if (!isValidSeat(block.seat)) {
      return { ok: false, code: "invalid-blocks", message: `block ${block.id} has an invalid seat` };
    }
    if (kind === "roof" && isValidSeat(block.seat)) roofPerSeat[block.seat] += 1;
    if (kind === "tower") towerBlocks += 1;
    if (!isFiniteInteger(block.size) || block.size !== STRUCTURE_BLOCK_SIZE) {
      return { ok: false, code: "invalid-blocks", message: `block ${block.id} has an invalid size` };
    }
    const maxIntegrity = kind === "tower" ? TOWER_BLOCK_INTEGRITY : BLOCK_MAX_INTEGRITY;
    if (
      !isFiniteInteger(block.integrity) ||
      block.integrity < 1 ||
      block.integrity > maxIntegrity
    ) {
      return {
        ok: false,
        code: "invalid-blocks",
        message: `block ${block.id} integrity must be an integer in [1, ${maxIntegrity}]`,
      };
    }
    if (
      !isFiniteInteger(block.x) ||
      !isFiniteInteger(block.y) ||
      block.x < 0 ||
      block.y < 0 ||
      block.x + block.size > BATTLEFIELD_WIDTH ||
      block.y + block.size > BATTLEFIELD_HEIGHT
    ) {
      return { ok: false, code: "invalid-blocks", message: `block ${block.id} is outside the battlefield` };
    }
  }
  for (const seat of SEATS) {
    if (roofPerSeat[seat] > BASE_ROOF_BLOCKS) {
      return {
        ok: false,
        code: "invalid-blocks",
        message: `seat ${seat} has more than ${BASE_ROOF_BLOCKS} base roof blocks`,
      };
    }
  }
  if (towerBlocks > MAX_TOWER_BLOCKS) {
    return {
      ok: false,
      code: "invalid-blocks",
      message: `the middle tower may not hold more than ${MAX_TOWER_BLOCKS} blocks`,
    };
  }
  for (let a = 0; a < blocks.length; a++) {
    for (let b = a + 1; b < blocks.length; b++) {
      if (blocksOverlap(blocks[a] as TowerBlock, blocks[b] as TowerBlock)) {
        return { ok: false, code: "invalid-blocks", message: "blocks must not overlap" };
      }
    }
  }

  // Pickups are optional so a battlefield written before v3 still loads (it has
  // none); when present they must be a well-formed, bounded list.
  const pickups = (field as { pickups?: unknown }).pickups;
  if (pickups !== undefined) {
    if (!Array.isArray(pickups) || pickups.length > MAX_POWERUPS) {
      return {
        ok: false,
        code: "invalid-pickups",
        message: `battlefield.pickups must be an array of at most ${MAX_POWERUPS} pickups`,
      };
    }
    const pickupIds = new Set<number>();
    for (const pickup of pickups as Partial<PowerUp>[]) {
      if (!pickup || typeof pickup !== "object") {
        return { ok: false, code: "invalid-pickups", message: "every pickup must be an object" };
      }
      if (
        !isFiniteInteger(pickup.id) ||
        pickup.id < 1 ||
        pickupIds.has(pickup.id)
      ) {
        return {
          ok: false,
          code: "invalid-pickups",
          message: "pickup ids must be unique positive integers",
        };
      }
      pickupIds.add(pickup.id);
      if (
        pickup.kind !== POWERUP_KINDS.DOUBLE_DAMAGE &&
        pickup.kind !== POWERUP_KINDS.DOUBLE_BLAST &&
        pickup.kind !== POWERUP_KINDS.HEAL
      ) {
        return { ok: false, code: "invalid-pickups", message: `pickup ${pickup.id} has an invalid kind` };
      }
      if (
        !isFiniteInteger(pickup.x) ||
        !isFiniteInteger(pickup.y) ||
        pickup.x < 0 ||
        pickup.y < 0 ||
        pickup.x > BATTLEFIELD_WIDTH ||
        pickup.y > BATTLEFIELD_HEIGHT
      ) {
        return { ok: false, code: "invalid-pickups", message: `pickup ${pickup.id} is outside the battlefield` };
      }
    }
  }

  return { ok: true };
}
