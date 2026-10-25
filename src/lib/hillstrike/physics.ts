/**
 * Hillstrike — the authoritative, deterministic shot simulator.
 *
 * ── CONTRACT ───────────────────────────────────────────────────────────────
 *   Same { battlefield, shooter seat, angle, power } → the SAME
 *   `ShotSimulation`, byte for byte, in every runtime. There is no randomness,
 *   no clock and no client-supplied position, hit, life, terrain height,
 *   structure or winner: the caller supplies two numbers and the simulator
 *   resolves everything else.
 *
 *   That is what lets the server simulate a shot once, store the resolved
 *   trajectory and both clients animate exactly the same outcome — the client
 *   never re-derives a result.
 *
 * ── MODEL ──────────────────────────────────────────────────────────────────
 *   • fixed 1-tick step (60 Hz); gravity is added to `vy` every tick
 *   • adaptive substepping (`substepCount`, max travel 4 world units per
 *     substep) so a fast projectile cannot tunnel through a player or a block
 *   • every contact is tested as a SWEPT SEGMENT, not a point, so tunnelling is
 *     impossible even if the substep budget were ever loosened
 *   • a shot ENDS at its first contact — no bouncing, no second impact, so the
 *     outcome is one bounded resolution rather than a chaotic chain
 *   • only the DEFENDER is a collision target: a shot that falls back onto its
 *     own tank can never cost the shooter HP
 *   • contact priority, when several are reached on the same substep:
 *       1. player      (a defender in front of a wall is hit)
 *       2. block       (lowest block id wins an exact tie)
 *       3. terrain
 *   • range: the shell records how far it actually FLEW, and that distance
 *     drives `powerScaleForDistance` — the further it travelled, the LESS HP it
 *     takes from a tank (`damageForDistance`, applied in ./rules). That is the
 *     ONLY thing distance changes: the crater and the structural blast are a
 *     fixed size, because a shell that lands is a shell that lands
 *   • structures: a block reached by a shell is destroyed outright (blocks
 *     carry one point of integrity). A block impact also blasts every other
 *     block inside `BLOCK_BLAST_RADIUS`, carves a shallow crater and runs the
 *     bounded collapse
 *   • base roofs (`kind: "roof"`) are INDESTRUCTIBLE: a shell that meets one
 *     stops there and does nothing at all — no block damage, no crater, no
 *     collapse — and a roof never collapses or falls
 *   • damage: a direct player contact costs HP (in ./rules); a block or terrain
 *     contact never does
 *   • limits: `maxTicks`, `substepMaxPx`, `MAX_SUBSTEPS_PER_TICK`,
 *     `TERRAIN_CARVE_BUDGET`, `MAX_COLLAPSE_PASSES`, `MAX_COLLAPSE_MOVES`,
 *     `MAX_PATH_POINTS`. Nothing here recurses.
 *
 * Determinism note: only +, -, *, /, Math.hypot, Math.round, Math.floor,
 * Math.ceil and Math.cos/sin (launch direction) are used — the same set the
 * shipped Mini Golf simulator relies on. The SERVER's resolved path is the
 * stored truth, so a client never has to reproduce these doubles itself.
 */

import { clamp, dedupePath, type Vec2 } from "../physics2d/kinematics";
import {
  BLOCK_BLAST_RADIUS,
  BLOCK_CRATER_FACTOR,
  BATTLEFIELD_HEIGHT,
  BATTLEFIELD_WIDTH,
  CRATER_DEPTH,
  CRATER_RADIUS,
  DEFAULT_MAX_PULL,
  IMPACT_KINDS,
  MAX_COLLAPSE_MOVES,
  MAX_COLLAPSE_PASSES,
  MAX_LAUNCH_SPEED,
  MAX_PATH_POINTS,
  MAX_SUBSTEPS_PER_TICK,
  MIN_LAUNCH_SPEED,
  MIN_PULL,
  PATH_DEDUPE_TOLERANCE,
  HIT_DAMAGE_MAX,
  PLAYER_RADIUS,
  POWER_MAX,
  POWER_MIN,
  PROJECTILE,
  SEATS,
  SHOT_POWER_FALLOFF_DISTANCE,
  SHOT_POWER_MIN_SCALE,
  SUPPORT_TOLERANCE,
  TERRAIN_CARVE_BUDGET,
  TERRAIN_COLUMNS,
  TERRAIN_COLUMN_WIDTH,
  TERRAIN_MAX_SURFACE_Y,
  TICK_MS,
} from "./constants";
import { groundYUnder, validateBattlefield } from "./generation";
import type {
  Battlefield,
  BattlefieldVerdict,
  Impact,
  ImpactKind,
  Player,
  PowerUp,
  ProjectileSpec,
  Seat,
  ShotEvent,
  ShotInput,
  ShotSimulation,
  TowerBlock,
} from "./types";

/** The seat that is not `seat`. */
export function otherSeat(seat: Seat): Seat {
  return seat === "player1" ? "player2" : "player1";
}

/** The shared projectile spec a match is created with (same for both seats). */
export function createProjectileSpec(): ProjectileSpec {
  return Object.freeze({
    radius: PROJECTILE.radius,
    gravity: PROJECTILE.gravity,
    maxTicks: PROJECTILE.maxTicks,
    substepMaxPx: PROJECTILE.substepMaxPx,
    pathSampleEvery: PROJECTILE.pathSampleEvery,
    launchSpeedMin: MIN_LAUNCH_SPEED,
    launchSpeedMax: MAX_LAUNCH_SPEED,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Aim input
// ──────────────────────────────────────────────────────────────────────────

/**
 * How much power a shell has left after flying `distance` world units.
 *
 * Linear from 1 at the muzzle to `SHOT_POWER_MIN_SCALE` at
 * `SHOT_POWER_FALLOFF_DISTANCE`, and it never drops below that floor: a shot
 * still hurts at the far end of the map, just less. Distances shorter than the
 * falloff distance interpolate, so the curve has no cliff.
 *
 * This is a HP-damage curve ONLY. It no longer sizes a crater, a structural
 * blast or a block break — those are fixed, so a long shot still levels the
 * cover it lands on.
 */
export function powerScaleForDistance(distance: number): number {
  const travelled = Number.isFinite(distance) ? Math.max(0, distance) : 0;
  const ratio = clamp(travelled / SHOT_POWER_FALLOFF_DISTANCE, 0, 1);
  return 1 - (1 - SHOT_POWER_MIN_SCALE) * ratio;
}

/**
 * The HP a direct hit takes, from the distance the shell flew.
 *
 * THE only distance-sensitive quantity in the game. Always at least 1: a direct
 * hit on a tank always costs something, however far the shell came.
 */
export function damageForDistance(distance: number): number {
  return Math.max(1, Math.round(HIT_DAMAGE_MAX * powerScaleForDistance(distance)));
}

/** A block's kind, defaulting a legacy (v2) row to cover. */
function blockKind(block: TowerBlock): "cover" | "roof" {
  return block.kind === "roof" ? "roof" : "cover";
}

/**
 * Unit launch direction for an angle in degrees: 0° → right (+x), 90° → UP
 * (decreasing y), 180° → left, 270° → down. The screen flip lives here and
 * nowhere else.
 */
export function directionVector(angleDeg: number): Vec2 {
  const radians = (angleDeg * Math.PI) / 180;
  return { x: Math.cos(radians), y: -Math.sin(radians) };
}

/**
 * Muzzle speed for an integer power against an explicit projectile spec.
 *
 * The SPEC is authoritative, not the module constants: a match snapshots its
 * spec onto the state so a stored replay keeps the speeds it was played with, even
 * if the tuning constants are retuned later. `launchSpeed` is the default-spec
 * shorthand.
 */
export function launchSpeedFor(projectile: ProjectileSpec, power: number): number {
  const ratio = clamp(power, POWER_MIN, POWER_MAX) / POWER_MAX;
  const low = projectile.launchSpeedMin;
  const high = projectile.launchSpeedMax;
  return low + ratio * (high - low);
}

/** Muzzle speed for an integer power, interpolated between the two constants. */
export function launchSpeed(power: number): number {
  return launchSpeedFor(createProjectileSpec(), power);
}

/**
 * Validate a projectile spec before it is simulated.
 *
 * A match's spec is stored data, so it is treated like the battlefield: refused
 * loudly rather than turned into a NaN trajectory that would silently corrupt a
 * match. Only the fields that shape the simulation are required to be sane.
 */
export function assertProjectileSpec(value: unknown): ProjectileSpec {
  if (!value || typeof value !== "object") {
    throw new TypeError("hillstrike physics: projectile spec must be an object");
  }
  const spec = value as Partial<ProjectileSpec>;
  const positive = ["radius", "maxTicks", "substepMaxPx", "pathSampleEvery"] as const;
  for (const field of positive) {
    const raw = spec[field];
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
      throw new TypeError(`hillstrike physics: projectile.${field} must be positive`);
    }
  }
  if (typeof spec.gravity !== "number" || !Number.isFinite(spec.gravity) || spec.gravity < 0) {
    throw new TypeError("hillstrike physics: projectile.gravity must be finite and non-negative");
  }
  const speeds = [spec.launchSpeedMin, spec.launchSpeedMax];
  for (const speed of speeds) {
    if (typeof speed !== "number" || !Number.isFinite(speed) || speed < 0) {
      throw new TypeError("hillstrike physics: projectile launch speeds must be finite and non-negative");
    }
  }
  if ((spec.launchSpeedMax as number) < (spec.launchSpeedMin as number)) {
    throw new TypeError("hillstrike physics: projectile.launchSpeedMax must not be below the minimum");
  }
  return spec as ProjectileSpec;
}

/** A finite number, or a TypeError naming the field. */
function assertFinite(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`hillstrike shot: ${name} must be a finite number, got ${String(value)}`);
  }
  return value;
}

/**
 * Strict validation of an AUTHORITATIVE shot. Throws rather than clamping: a
 * malformed request is a caller bug and must never be silently repaired into a
 * legal shot. `normalizeShot` is the lenient UI-facing counterpart.
 */
export function assertShotInput(input: unknown): ShotInput {
  if (!input || typeof input !== "object") {
    throw new TypeError("hillstrike shot: shot must be an object");
  }
  const { angleDeg, power } = input as Partial<ShotInput>;
  const angle = assertFinite("angleDeg", angleDeg);
  const rawPower = assertFinite("power", power);
  if (angle < 0 || angle >= 360) {
    throw new RangeError(`hillstrike shot: angleDeg must be in [0, 360), got ${angle}`);
  }
  if (!Number.isInteger(rawPower) || rawPower < POWER_MIN || rawPower > POWER_MAX) {
    throw new RangeError(
      `hillstrike shot: power must be an integer in [${POWER_MIN}, ${POWER_MAX}], got ${rawPower}`,
    );
  }
  return { angleDeg: angle, power: rawPower };
}

/**
 * Lenient conversion for a drag/aim UI: rounds power, wraps the angle into
 * [0, 360). NaN and infinities are rejected (throw), because a non-number is a
 * programming error rather than an out-of-range aim.
 */
export function normalizeShot(input: unknown): ShotInput {
  if (!input || typeof input !== "object") {
    throw new TypeError("hillstrike shot: shot must be an object");
  }
  const { angleDeg, power } = input as Partial<ShotInput>;
  const angle = assertFinite("angleDeg", angleDeg);
  const rawPower = assertFinite("power", power);
  let wrapped = angle % 360;
  if (wrapped < 0) wrapped += 360;
  return {
    angleDeg: wrapped,
    power: Math.round(clamp(rawPower, POWER_MIN, POWER_MAX)),
  };
}

/**
 * Convert a drag gesture into a shot, slingshot style: the launch direction is
 * OPPOSITE the drag (pull down-left to fire up-right) and the pull's length
 * maps linearly onto power.
 *
 * Returns `null` for a degenerate drag (shorter than `MIN_PULL`) so a UI can
 * treat "the player has not aimed yet" without inventing a shot. Non-finite
 * coordinates throw — a gesture with NaN coordinates is a bug, not an aim.
 */
export function aimFromDrag({
  fromX,
  fromY,
  toX,
  toY,
  maxPull = DEFAULT_MAX_PULL,
}: {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  maxPull?: number;
}): ShotInput | null {
  const from = { x: assertFinite("fromX", fromX), y: assertFinite("fromY", fromY) };
  const to = { x: assertFinite("toX", toX), y: assertFinite("toY", toY) };
  const limit = assertFinite("maxPull", maxPull);
  if (limit <= 0) throw new RangeError("hillstrike shot: maxPull must be positive");

  const pullX = from.x - to.x;
  const pullY = from.y - to.y;
  const pull = Math.hypot(pullX, pullY);
  if (pull < MIN_PULL) return null;

  // atan2(-dy, dx) is the same screen-flipped convention as directionVector.
  let angleDeg = (Math.atan2(-pullY, pullX) * 180) / Math.PI;
  if (angleDeg < 0) angleDeg += 360;

  return {
    // A perfectly horizontal drag comes back as -0 from atan2; normalise it so
    // "straight right" compares equal to 0 rather than merely being equal.
    angleDeg: angleDeg === 0 ? 0 : angleDeg,
    power: Math.round(clamp(pull / limit, 0, 1) * POWER_MAX),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Geometry (all deterministic, all segment-based)
// ──────────────────────────────────────────────────────────────────────────

/** Container for the nearest contact found on one swept segment. */
interface Contact {
  t: number;
  x: number;
  y: number;
  kind: ImpactKind;
  target: Seat | null;
  blockId: number | null;
}

/**
 * Contact priority used when two categories are reached at the same `t`.
 * Lower wins. Players outrank blocks (a defender in front of a wall is hit),
 * and blocks outrank terrain (a tower standing on the ground is hit first).
 */
const CONTACT_PRIORITY: Record<string, number> = {
  [IMPACT_KINDS.PLAYER]: 0,
  [IMPACT_KINDS.BLOCK]: 1,
  [IMPACT_KINDS.TERRAIN]: 2,
};

/** Parameter t ∈ [0, 1] at which the segment first enters the circle, or null. */
function segmentCircleHit(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  cx: number,
  cy: number,
  radius: number,
): number | null {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const fx = x0 - cx;
  const fy = y0 - cy;
  const a = dx * dx + dy * dy;

  if (a < 1e-12) {
    return fx * fx + fy * fy <= radius * radius ? 0 : null;
  }
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - radius * radius;
  let discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;
  discriminant = Math.sqrt(discriminant);

  const tEnter = (-b - discriminant) / (2 * a);
  if (tEnter >= 0 && tEnter <= 1) return tEnter;
  const tExit = (-b + discriminant) / (2 * a);
  if (tExit >= 0 && tExit <= 1) return tExit;
  return null;
}

/** Parameter t ∈ [0, 1] at which the segment first enters the AABB, or null. */
function segmentAabbHit(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): number | null {
  let tMin = 0;
  let tMax = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;

  const axes: Array<[number, number, number, number]> = [
    [x0, dx, minX, maxX],
    [y0, dy, minY, maxY],
  ];
  for (const [origin, delta, min, max] of axes) {
    if (Math.abs(delta) < 1e-12) {
      if (origin < min || origin > max) return null;
      continue;
    }
    let t1 = (min - origin) / delta;
    let t2 = (max - origin) / delta;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return null;
  }
  return tMin >= 0 && tMin <= 1 ? tMin : null;
}

/** Nearest column contact: the ground is a solid column from its surface down. */
function segmentTerrainHit(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  terrain: readonly number[],
): number | null {
  const fromColumn = clampColumn(x0);
  const toColumn = clampColumn(x1);
  const first = Math.min(fromColumn, toColumn);
  const last = Math.max(fromColumn, toColumn);

  let best: number | null = null;
  for (let column = first; column <= last; column++) {
    const t = segmentAabbHit(
      x0,
      y0,
      x1,
      y1,
      column * TERRAIN_COLUMN_WIDTH,
      terrain[column],
      (column + 1) * TERRAIN_COLUMN_WIDTH,
      BATTLEFIELD_HEIGHT,
    );
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best;
}

function clampColumn(x: number): number {
  const column = Math.floor(x / TERRAIN_COLUMN_WIDTH);
  return clamp(column, 0, TERRAIN_COLUMNS - 1);
}

function pointAt(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  t: number,
): Vec2 {
  return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t };
}

/**
 * The first contact on one swept segment, with the documented priority order.
 * Blocks are scanned by ascending id, so an exact tie between two blocks always
 * resolves to the lower id.
 */
function firstContact({
  x0,
  y0,
  x1,
  y1,
  terrain,
  blocks,
  defender,
}: {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  terrain: readonly number[];
  blocks: readonly TowerBlock[];
  defender: Player & { radius: number };
}): Contact | null {
  let best: Contact | null = null;

  const consider = (
    t: number,
    kind: ImpactKind,
    target: Seat | null,
    blockId: number | null,
  ) => {
    const point = pointAt(x0, y0, x1, y1, t);
    const candidate: Contact = { t, x: point.x, y: point.y, kind, target, blockId };
    if (!best) {
      best = candidate;
      return;
    }
    const delta = t - best.t;
    if (delta < -1e-9) {
      best = candidate;
      return;
    }
    if (Math.abs(delta) <= 1e-9) {
      if (CONTACT_PRIORITY[kind] < CONTACT_PRIORITY[best.kind]) best = candidate;
    }
  };

  const playerT = segmentCircleHit(
    x0,
    y0,
    x1,
    y1,
    defender.x,
    defender.y,
    defender.radius,
  );
  if (playerT !== null) consider(playerT, IMPACT_KINDS.PLAYER, defender.seat, null);

  for (const block of blocks) {
    const blockT = segmentAabbHit(
      x0,
      y0,
      x1,
      y1,
      block.x,
      block.y,
      block.x + block.size,
      block.y + block.size,
    );
    if (blockT !== null) consider(blockT, IMPACT_KINDS.BLOCK, null, block.id);
  }

  const terrainT = segmentTerrainHit(x0, y0, x1, y1, terrain);
  if (terrainT !== null) consider(terrainT, IMPACT_KINDS.TERRAIN, null, null);

  return best;
}

// ──────────────────────────────────────────────────────────────────────────
// Damage
// ──────────────────────────────────────────────────────────────────────────

interface CarveOutcome {
  event: ShotEvent | null;
}

/** Bounded, integer terrain carve centred on a contact point. */
function carveTerrain(
  terrain: number[],
  x: number,
  y: number,
  tick: number,
  depth: number,
  radius: number,
): CarveOutcome {
  let spent = 0;
  let touched = 0;
  const fromColumn = clampColumn(x - radius);
  const toColumn = clampColumn(x + radius);

  for (let column = fromColumn; column <= toColumn; column++) {
    const centre = column * TERRAIN_COLUMN_WIDTH + TERRAIN_COLUMN_WIDTH / 2;
    const distance = Math.abs(centre - x);
    if (distance > radius) continue;

    const falloff = 1 - (distance / radius) * (distance / radius);
    let delta = Math.round(depth * falloff);
    if (delta <= 0) continue;

    const room = Math.min(
      TERRAIN_CARVE_BUDGET - spent,
      TERRAIN_MAX_SURFACE_Y - terrain[column],
    );
    if (room <= 0) {
      if (TERRAIN_CARVE_BUDGET - spent <= 0) break;
      continue;
    }
    delta = Math.min(delta, room);
    terrain[column] += delta;
    spent += delta;
    touched += 1;
  }

  if (touched === 0) return { event: null };
  return {
    event: {
      type: "terrain-carved",
      tick,
      x,
      y,
      fromColumn,
      toColumn,
    },
  };
}

/**
 * Blocks inside the blast radius lose one integrity; zero-integrity blocks die.
 *
 * The radius is FIXED (× the caller's blast scale, which is 2 only for the
 * `double-blast` pickup), so a shell's range can never make it gentler on cover.
 * A base roof is skipped entirely: it is scenery that cannot be broken.
 */
function damageBlocks(
  blocks: TowerBlock[],
  x: number,
  y: number,
  tick: number,
  blastScale: number,
  events: ShotEvent[],
): TowerBlock[] {
  const radius = BLOCK_BLAST_RADIUS * blastScale;

  const survivors: TowerBlock[] = [];
  for (const block of [...blocks].sort((a, b) => a.id - b.id)) {
    if (blockKind(block) === "roof") {
      survivors.push(block);
      continue;
    }
    const nearestX = clamp(x, block.x, block.x + block.size);
    const nearestY = clamp(y, block.y, block.y + block.size);
    if (Math.hypot(x - nearestX, y - nearestY) > radius) {
      survivors.push(block);
      continue;
    }
    const integrity = block.integrity - 1;
    if (integrity >= 1) {
      survivors.push({ ...block, integrity });
      events.push({
        type: "block-damaged",
        tick,
        blockId: block.id,
        integrity,
        x: block.x + block.size / 2,
        y: block.y + block.size / 2,
      });
    } else {
      events.push({
        type: "block-destroyed",
        tick,
        blockId: block.id,
        x: block.x + block.size / 2,
        y: block.y + block.size / 2,
        cause: "damage",
      });
    }
  }
  return survivors;
}

/**
 * The nearest support at or below a block's bottom edge: the smallest surface y
 * among the ground under its footprint and the tops of blocks it overlaps. The
 * block rests on that surface, so it never sinks into a support.
 */
function nearestSupport(
  block: TowerBlock,
  blocks: readonly TowerBlock[],
  terrain: readonly number[],
): number {
  const bottom = block.y + block.size;
  let best = Number.POSITIVE_INFINITY;

  const ground = groundYUnder(terrain, block.x, block.size);
  if (ground >= bottom - SUPPORT_TOLERANCE) best = ground;

  for (const other of blocks) {
    if (other.id === block.id) continue;
    const overlap =
      Math.min(block.x + block.size, other.x + other.size) -
      Math.max(block.x, other.x);
    if (overlap < block.size / 2) continue;
    if (other.y < bottom - SUPPORT_TOLERANCE) continue;
    if (other.y < best) best = other.y;
  }
  return best;
}

function isSupported(
  block: TowerBlock,
  blocks: readonly TowerBlock[],
  terrain: readonly number[],
): boolean {
  const support = nearestSupport(block, blocks, terrain);
  if (!Number.isFinite(support)) return false;
  return Math.abs(support - (block.y + block.size)) <= SUPPORT_TOLERANCE;
}

/** A block with writable geometry — the collapse pass only moves blocks down. */
interface MutableBlock {
  id: number;
  seat: Seat;
  kind: "cover" | "roof";
  x: number;
  y: number;
  size: number;
  integrity: number;
}

/**
 * Deterministic structural collapse: repeated support passes, each moving the
 * unsupported blocks onto their nearest support, bounded by
 * `MAX_COLLAPSE_PASSES` and `MAX_COLLAPSE_MOVES`. No recursion.
 *
 * Blocks still unsupported when the budget runs out are removed as rubble,
 * deterministically by id, so a settled battlefield never contains a floating
 * block.
 */
function resolveCollapse(
  terrain: readonly number[],
  blocks: readonly TowerBlock[],
  tick: number,
  events: ShotEvent[],
): TowerBlock[] {
  // The simulation works on its own mutable copies: the incoming battlefield is
  // never touched, and the returned array is the settled result.
  // Base roofs are anchored: they are never moved by a pass and never removed
  // as rubble, so a football-sized crater under a base cannot drop its ceiling.
  const working: MutableBlock[] = blocks.map((block) => ({ ...block }));
  let moves = 0;

  for (let pass = 0; pass < MAX_COLLAPSE_PASSES && moves < MAX_COLLAPSE_MOVES; pass++) {
    let changed = false;
    for (const block of [...working].sort((a, b) => a.id - b.id)) {
      if (moves >= MAX_COLLAPSE_MOVES) break;
      if (blockKind(block) === "roof") continue;
      const bottom = block.y + block.size;
      const support = nearestSupport(block, working, terrain);
      if (!Number.isFinite(support) || support - bottom <= SUPPORT_TOLERANCE) continue;

      const fromY = block.y;
      block.y = support - block.size;
      moves += 1;
      changed = true;
      events.push({
        type: "collapse",
        tick,
        blockId: block.id,
        fromX: block.x,
        fromY,
        x: block.x,
        y: block.y,
      });
    }
    if (!changed) break;
  }

  const settled: TowerBlock[] = [];
  for (const block of [...working].sort((a, b) => a.id - b.id)) {
    if (blockKind(block) === "roof" || isSupported(block, working, terrain)) {
      settled.push(block);
      continue;
    }
    events.push({
      type: "block-destroyed",
      tick,
      blockId: block.id,
      x: block.x + block.size / 2,
      y: block.y + block.size / 2,
      cause: "collapse",
    });
  }
  return settled;
}

// ──────────────────────────────────────────────────────────────────────────
// Simulation
// ──────────────────────────────────────────────────────────────────────────

export interface SimulateShotParams {
  readonly battlefield: Battlefield;
  readonly shooterSeat: Seat;
  readonly shot: ShotInput;
  /** Defaults to `createProjectileSpec()`; a match always passes its own. */
  readonly projectile?: ProjectileSpec;
  /**
   * Blast multiplier for this shell: 1 normally, 2 while `double-blast` is armed
   * (see ./rules). It scales the CRATER and the block blast, never the HP damage
   * and never with distance.
   */
  readonly blastScale?: number;
}

/**
 * Dedupe and cap the recorded trajectory WITHOUT losing its first or last
 * point: the impact point is always the final point a client animates to.
 */
function capPath(points: Vec2[], impact: Vec2): Vec2[] {
  const deduped = dedupePath(points, PATH_DEDUPE_TOLERANCE);
  if (deduped.length === 0) return [{ x: impact.x, y: impact.y }];

  // The endpoint must be the impact even when dedupe dropped it as "close
  // enough" to the previous sample.
  deduped[deduped.length - 1] = { x: impact.x, y: impact.y };
  if (deduped.length <= MAX_PATH_POINTS) return deduped;

  const stride = Math.max(1, Math.ceil((deduped.length - 1) / (MAX_PATH_POINTS - 1)));
  const capped: Vec2[] = [];
  for (let index = 0; index < deduped.length - 1; index += stride) {
    capped.push(deduped[index]);
  }
  capped.push(deduped[deduped.length - 1]);
  return capped;
}

/**
 * Simulate one shot to its resolution.
 *
 * The battlefield is NOT mutated: the post-impact terrain, blocks and player
 * positions come back in `simulation.battlefield`, and the caller (./rules)
 * decides what HP or a finished match means.
 */
export function simulateShot(params: SimulateShotParams): ShotSimulation {
  if (!params || typeof params !== "object") {
    throw new TypeError("hillstrike physics: params must be an object");
  }
  const { battlefield, shooterSeat } = params;
  if (shooterSeat !== "player1" && shooterSeat !== "player2") {
    throw new TypeError(`hillstrike physics: invalid shooter seat ${String(shooterSeat)}`);
  }
  const verdict = validateBattlefield(battlefield);
  if (!verdict.ok) {
    const denied = verdict as Extract<BattlefieldVerdict, { ok: false }>;
    throw new TypeError(`hillstrike physics: invalid battlefield — ${denied.message}`);
  }
  const shot = assertShotInput(params.shot);
  // `undefined` means "use the canonical spec"; anything else must BE a spec.
  // (A null spec is a caller bug, not a request for the default.)
  const spec = assertProjectileSpec(
    params.projectile === undefined ? createProjectileSpec() : params.projectile,
  );
  const blastScale = params.blastScale === undefined ? 1 : params.blastScale;
  if (typeof blastScale !== "number" || !Number.isFinite(blastScale) || blastScale < 1) {
    throw new TypeError("hillstrike physics: blastScale must be a finite number >= 1");
  }

  const terrain = [...battlefield.terrain];
  // Ascending id is the documented tie-break when two blocks are reached at the
  // same instant, so the working set is put in that order once per shot.
  let blocks: TowerBlock[] = battlefield.blocks
    .map((block) => ({ ...block }))
    .sort((a, b) => a.id - b.id);
  const players: Record<Seat, Player> = {
    player1: { ...battlefield.players.player1 },
    player2: { ...battlefield.players.player2 },
  };

  const events: ShotEvent[] = [];
  const rawPath: Vec2[] = [];

  const shooter = players[shooterSeat];
  const defender: Player & { radius: number } = {
    ...players[otherSeat(shooterSeat)],
    radius: PLAYER_RADIUS + spec.radius,
  };

  const direction = directionVector(shot.angleDeg);
  const speed = launchSpeedFor(spec, shot.power);
  const muzzleOffset = PLAYER_RADIUS + spec.radius + 1;
  let x = shooter.x + direction.x * muzzleOffset;
  let y = shooter.y + direction.y * muzzleOffset;
  let vx = direction.x * speed;
  let vy = direction.y * speed;

  events.push({
    type: "launch",
    tick: 0,
    seat: shooterSeat,
    angleDeg: shot.angleDeg,
    power: shot.power,
    x,
    y,
  });
  rawPath.push({ x, y });

  let impact: Impact | null = null;
  // Which block was actually struck, so an indestructible base roof can absorb
  // the shell without any crater or structural damage at all.
  let struckBlockId: number | null = null;
  let lastTick = 0;
  // World units actually flown. This is the ONE range measurement the rules use:
  // every damage/explosion figure is derived from it, never from the aim.
  let travelled = 0;

  for (let tick = 1; tick <= spec.maxTicks && !impact; tick++) {
    lastTick = tick;
    vy += spec.gravity;

    const currentSpeed = Math.hypot(vx, vy);
    const substeps = clamp(
      Math.ceil(currentSpeed / spec.substepMaxPx),
      1,
      MAX_SUBSTEPS_PER_TICK,
    );
    const stepX = vx / substeps;
    const stepY = vy / substeps;

    for (let substep = 0; substep < substeps && !impact; substep++) {
      const x0 = x;
      const y0 = y;
      const x1 = x + stepX;
      const y1 = y + stepY;

      const contact = firstContact({
        x0,
        y0,
        x1,
        y1,
        terrain,
        blocks,
        defender,
      });

      if (contact) {
        travelled += Math.hypot(contact.x - x0, contact.y - y0);
        x = contact.x;
        y = contact.y;
        struckBlockId = contact.blockId;
        impact = {
          tick,
          x,
          y,
          kind: contact.kind,
          target: contact.kind === IMPACT_KINDS.PLAYER ? contact.target : null,
          blockId: contact.blockId,
        };
        break;
      }

      travelled += Math.hypot(x1 - x0, y1 - y0);
      x = x1;
      y = y1;
      if (x < 0 || x > BATTLEFIELD_WIDTH || y > BATTLEFIELD_HEIGHT) {
        impact = {
          tick,
          x,
          y,
          kind: IMPACT_KINDS.OUT_OF_BOUNDS,
          target: null,
          blockId: null,
        };
      }
    }

    if (impact) break;
    if (tick % spec.pathSampleEvery === 0) rawPath.push({ x, y });
  }

  if (!impact) {
    impact = {
      tick: spec.maxTicks,
      x,
      y,
      kind: IMPACT_KINDS.TIMEOUT,
      target: null,
      blockId: null,
    };
  }

  events.push({
    type: "impact",
    tick: impact.tick,
    x: impact.x,
    y: impact.y,
    kind: impact.kind,
    target: impact.target,
    blockId: impact.blockId,
  });
  rawPath.push({ x: impact.x, y: impact.y });

  // The shell's remaining power, from the distance it flew. This is a HP-damage
  // figure ONLY: it no longer sizes the blast, so a shot that crossed the whole
  // map still levels the block it lands on.
  const powerScale = powerScaleForDistance(travelled);

  if (impact.kind === IMPACT_KINDS.PLAYER) {
    // A direct player hit costs HP in ./rules and changes nothing else: no
    // crater, no structural damage, so HP can never be lost as a side effect of
    // terrain.
    if (impact.target) {
      events.push({
        type: "player-hit",
        tick: impact.tick,
        seat: impact.target,
        x: impact.x,
        y: impact.y,
      });
    }
  } else if (
    impact.kind === IMPACT_KINDS.BLOCK ||
    impact.kind === IMPACT_KINDS.TERRAIN
  ) {
    const struck = struckBlockId === null ? null : blocks.find((b) => b.id === struckBlockId) ?? null;
    if (struck && blockKind(struck) === "roof") {
      // An indestructible base roof swallows the shell: no block damage, no
      // crater, no collapse. This is the whole point of the roof.
    } else {
      const depth = CRATER_DEPTH * blastScale;
      const radius = CRATER_RADIUS * blastScale;
      const craterDepth =
        impact.kind === IMPACT_KINDS.BLOCK
          ? Math.max(1, Math.round(depth * BLOCK_CRATER_FACTOR))
          : depth;

      // Fixed size, whatever the range: the hit block has one integrity, so it
      // breaks outright, and every block inside the blast does too.
      blocks = damageBlocks(blocks, impact.x, impact.y, impact.tick, blastScale, events);

      const carved = carveTerrain(
        terrain,
        impact.x,
        impact.y,
        impact.tick,
        craterDepth,
        radius,
      );
      if (carved.event) events.push(carved.event);

      // Ground moved: everyone standing on it follows the surface. This NEVER
      // costs HP — only a direct player contact does.
      for (const seat of SEATS) {
        players[seat] = {
          ...players[seat],
          y: terrain[clampColumn(players[seat].x)],
        };
      }

      blocks = resolveCollapse(terrain, blocks, impact.tick, events);
    }
  }

  events.push({ type: "settled", tick: impact.tick, x: impact.x, y: impact.y });

  const path = capPath(rawPath, { x: impact.x, y: impact.y });

  return {
    path,
    impact,
    events,
    battlefield: {
      ...battlefield,
      terrain,
      blocks,
      players,
    },
    ticks: lastTick,
    distance: travelled,
    powerScale,
  };
}

/** Fixed-step size, exported so a UI animates at exactly the simulated rate. */
export const SIMULATION_TICK_MS = TICK_MS;
