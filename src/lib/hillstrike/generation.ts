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
  BATTLEFIELD_HEIGHT,
  BATTLEFIELD_WIDTH,
  BLOCK_MAX_INTEGRITY,
  FIELD_VERSION,
  LAUNCHER_INSET_X,
  MAX_STRUCTURE_BLOCKS,
  MAX_STRUCTURE_BLOCKS_PER_SEAT,
  MIN_PLAYER_SEPARATION,
  SEATS,
  STRUCTURE_BLOCK_SIZE,
  STRUCTURE_CENTRE_INSET_X,
  STRUCTURE_ROW_WIDTHS,
  TERRAIN_COLUMNS,
  TERRAIN_COLUMN_WIDTH,
  TERRAIN_MAX_STEP,
  TERRAIN_MAX_SURFACE_Y,
  TERRAIN_MIN_SURFACE_Y,
  TERRAIN_PLATEAU_COLUMNS,
} from "./constants";
import type {
  Battlefield,
  BattlefieldVerdict,
  Player,
  Seat,
  TowerBlock,
} from "./types";

/** Columns per mirrored half (the generator only ever shapes one). */
const HALF_COLUMNS = TERRAIN_COLUMNS / 2;

/** Control points per half, including both ends. */
const PROFILE_KEYS = 9;

/** Largest drift between two neighbouring profile control points. */
const PROFILE_KEY_DRIFT = 70;

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

/** A mirrored, flat-ended, step-bounded half profile, as integer heights. */
function buildHalfProfile(rand: () => number): number[] {
  const keys: number[] = [
    clamp(
      Math.round(470 + (rand() * 2 - 1) * 30),
      TERRAIN_MIN_SURFACE_Y,
      TERRAIN_MAX_SURFACE_Y,
    ),
  ];
  for (let index = 1; index < PROFILE_KEYS; index++) {
    const drift = (rand() * 2 - 1) * PROFILE_KEY_DRIFT;
    keys.push(
      clamp(
        Math.round(keys[index - 1] + drift),
        TERRAIN_MIN_SURFACE_Y,
        TERRAIN_MAX_SURFACE_Y,
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

  // Both launchers stand on the same flat shelf: the first columns are pinned
  // to the profile's opening height before the step clamp runs.
  for (let column = 0; column < TERRAIN_PLATEAU_COLUMNS; column++) {
    half[column] = keys[0];
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

/**
 * Level the ground under a tower footprint.
 *
 * Each tower stands on a flat plinth: every column in the widest row's span is
 * set to the HIGHEST ground in that span (filling, never digging). Without this
 * a half-buried base block could not be hit from the side, and a block's
 * "supported by the ground" test would disagree with what the player sees.
 * The two plinth heights are equal by mirror symmetry.
 */
function levelTowerFootprint(terrain: number[], centreX: number): void {
  const widestRow = STRUCTURE_ROW_WIDTHS[0] * STRUCTURE_BLOCK_SIZE;
  const left = centreX - widestRow / 2;
  const surface = groundYUnder(terrain, left, widestRow);
  const from = columnIndexAt(left);
  const to = columnIndexAt(left + widestRow - 1e-9);
  for (let column = from; column <= to; column++) terrain[column] = surface;
}

/**
 * Build one seat's tower: a stepped pyramid, widest row at the bottom, resting
 * on the level plinth under its footprint. Deterministic integer geometry —
 * no rotation, no jitter, nothing to disagree about.
 */
function buildTower(terrain: readonly number[], seat: Seat, nextId: number): TowerBlock[] {
  const centreX =
    seat === "player1"
      ? STRUCTURE_CENTRE_INSET_X
      : BATTLEFIELD_WIDTH - STRUCTURE_CENTRE_INSET_X;
  const widestRow = STRUCTURE_ROW_WIDTHS[0] * STRUCTURE_BLOCK_SIZE;
  const groundY = groundYUnder(terrain, centreX - widestRow / 2, widestRow);

  const blocks: TowerBlock[] = [];
  let id = nextId;
  for (let row = 0; row < STRUCTURE_ROW_WIDTHS.length; row++) {
    const width = STRUCTURE_ROW_WIDTHS[row];
    const rowBottom = groundY - row * STRUCTURE_BLOCK_SIZE;
    const left = Math.round(centreX - (width * STRUCTURE_BLOCK_SIZE) / 2);
    for (let column = 0; column < width; column++) {
      blocks.push({
        id: id++,
        seat,
        x: left + column * STRUCTURE_BLOCK_SIZE,
        y: rowBottom - STRUCTURE_BLOCK_SIZE,
        size: STRUCTURE_BLOCK_SIZE,
        integrity: BLOCK_MAX_INTEGRITY,
      });
    }
  }
  return blocks;
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

  // Level each tower's plinth BEFORE any block is placed on it, so the ground
  // a block rests on is exactly the ground the player sees.
  levelTowerFootprint(terrain, STRUCTURE_CENTRE_INSET_X);
  levelTowerFootprint(terrain, BATTLEFIELD_WIDTH - STRUCTURE_CENTRE_INSET_X);

  const player1X = LAUNCHER_INSET_X;
  const player2X = BATTLEFIELD_WIDTH - LAUNCHER_INSET_X;
  const players: Record<Seat, Player> = {
    player1: { seat: "player1", x: player1X, y: surfaceYAt(terrain, player1X) },
    player2: { seat: "player2", x: player2X, y: surfaceYAt(terrain, player2X) },
  };

  const player1Blocks = buildTower(terrain, "player1", 1);
  const player2Blocks = buildTower(terrain, "player2", player1Blocks.length + 1);

  const battlefield: Battlefield = {
    version: FIELD_VERSION,
    seed,
    width: BATTLEFIELD_WIDTH,
    height: BATTLEFIELD_HEIGHT,
    terrain,
    blocks: [...player1Blocks, ...player2Blocks],
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
  const perSeat: Record<Seat, number> = { player1: 0, player2: 0 };
  for (const block of blocks as Partial<TowerBlock>[]) {
    if (!block || typeof block !== "object") {
      return { ok: false, code: "invalid-blocks", message: "every block must be an object" };
    }
    if (!isFiniteInteger(block.id) || block.id < 1 || ids.has(block.id)) {
      return { ok: false, code: "invalid-blocks", message: "block ids must be unique positive integers" };
    }
    ids.add(block.id);
    if (!isValidSeat(block.seat)) {
      return { ok: false, code: "invalid-blocks", message: `block ${block.id} has an invalid seat` };
    }
    perSeat[block.seat] += 1;
    if (!isFiniteInteger(block.size) || block.size !== STRUCTURE_BLOCK_SIZE) {
      return { ok: false, code: "invalid-blocks", message: `block ${block.id} has an invalid size` };
    }
    if (
      !isFiniteInteger(block.integrity) ||
      block.integrity < 1 ||
      block.integrity > BLOCK_MAX_INTEGRITY
    ) {
      return {
        ok: false,
        code: "invalid-blocks",
        message: `block ${block.id} integrity must be an integer in [1, ${BLOCK_MAX_INTEGRITY}]`,
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
    if (perSeat[seat] > MAX_STRUCTURE_BLOCKS_PER_SEAT) {
      return {
        ok: false,
        code: "invalid-blocks",
        message: `seat ${seat} has more than ${MAX_STRUCTURE_BLOCKS_PER_SEAT} blocks`,
      };
    }
  }
  for (let a = 0; a < blocks.length; a++) {
    for (let b = a + 1; b < blocks.length; b++) {
      if (blocksOverlap(blocks[a] as TowerBlock, blocks[b] as TowerBlock)) {
        return { ok: false, code: "invalid-blocks", message: "blocks must not overlap" };
      }
    }
  }

  return { ok: true };
}
