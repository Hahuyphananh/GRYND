// src/lib/plinko-pvp/physics.js
//
// Deterministic, pure-function ball simulator for the Plinko Duel PvP game.
// Same inputs (startX, power, angleDeg, seed) → same output, every time.
// No I/O, no global state, no time-based randomness — only the seeded Mulberry32
// PRNG inside the bounce step is non-deterministic per call.
//
// Used by:
//   - the server store (task 5) when both players have submitted their inputs
//   - the test suite (task 13) for deterministic path/bucket/fall-out assertions
//
// All tuning constants (BUCKETS, BOARD, physics, peg grid) are imported from
// ./constants.js — that file is the single source of truth shared with the
// server store, lobby, and match view. This module adds the simulator logic.

// ──────────────────────────────────────────────────────────────────────────
// Imports — single source of truth for all tuning constants
// ──────────────────────────────────────────────────────────────────────────

import {
  BUCKETS,
  BOARD,
  GRAVITY,
  RESTITUTION,
  FRICTION,
  JITTER_RAD,
  MAX_FRAMES,
  POWER_SCALE,
  ANGLE_LIMIT_DEG,
  SUBSTEP_MAX_PX,
  PATH_DOWNSAMPLE,
  PATH_DEDUP_TOLERANCE,
  PEG_ROWS,
  PEG_COLS_BASE,
  PEG_HORIZ_SPACING,
  PEG_VERT_SPACING,
  PEG_RADIUS,
  BALL_RADIUS,
  PEG_CENTER_X,
} from "./constants.js";

// Re-export the public constants so physics.js consumers (e.g. the server
// store) can import from either constants.js (the source of truth) or
// physics.js (the simulator). The two references are identical under ESM.
export {
  BUCKETS,
  BOARD,
  GRAVITY,
  RESTITUTION,
  FRICTION,
  JITTER_RAD,
  MAX_FRAMES,
  POWER_SCALE,
  ANGLE_LIMIT_DEG,
  SUBSTEP_MAX_PX,
  PATH_DOWNSAMPLE,
  PATH_DEDUP_TOLERANCE,
  PEG_ROWS,
  PEG_COLS_BASE,
  PEG_HORIZ_SPACING,
  PEG_VERT_SPACING,
  PEG_RADIUS,
  BALL_RADIUS,
  PEG_CENTER_X,
};

// y after which side exits count as fall-out. Internal to the simulator —
// not exported (clients shouldn't tune this). Computed once at module load;
// safe because BOARD and PEG_VERT_SPACING are frozen.
const FALL_OUT_GATE_Y = BOARD.topY + PEG_VERT_SPACING;

// ──────────────────────────────────────────────────────────────────────────
// Mulberry32 — tiny, fast, deterministic 32-bit PRNG.
// Used to seed the bounce jitter. Same seed → same jitter sequence.
// ──────────────────────────────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Peg grid construction
// ──────────────────────────────────────────────────────────────────────────

function buildPegs() {
  const pegs = [];
  for (let r = 0; r < PEG_ROWS; r++) {
    const cols = PEG_COLS_BASE + r; // 2, 3, 4, …, 20
    // First peg x = CENTER - ((cols-1) * spacing) / 2, so the row stays centered.
    const firstX = PEG_CENTER_X - ((cols - 1) * PEG_HORIZ_SPACING) / 2;
    for (let c = 0; c < cols; c++) {
      pegs.push({
        x: firstX + c * PEG_HORIZ_SPACING,
        y: BOARD.topY + r * PEG_VERT_SPACING,
      });
    }
  }
  return pegs;
}

const PEGS = Object.freeze(buildPegs());

/**
 * Returns the static peg grid (frozen). Useful for rendering in the client.
 */
export function getPegs() {
  return PEGS;
}

// ──────────────────────────────────────────────────────────────────────────
// Bucket classifier
// ──────────────────────────────────────────────────────────────────────────

/**
 * Map an x coordinate (in svg units) to a bucket index (0..4).
 * Returns -1 if x is outside the board (which should only happen on fall-out).
 */
export function classifyBucket(x) {
  // The bucket range for `far_right_safe` is [400, 500) — x=500 is a fall-out,
  // not a bucket landing. This closes the free-bucket edge exploit where a
  // ball launched at x=500 would otherwise be awarded 100 points without ever
  // touching a peg.
  if (x < 0 || x >= BOARD.width) return -1;
  // Hand-rolled if-ladder is faster than a loop for 5 fixed buckets and keeps
  // the semantics obvious to readers.
  if (x < 100) return 0;
  if (x < 200) return 1;
  if (x < 300) return 2;
  if (x < 400) return 3;
  return 4;
}

// ──────────────────────────────────────────────────────────────────────────
// Bounce — reflect velocity off a peg and apply jitter
// ──────────────────────────────────────────────────────────────────────────

function bounce(vx, vy, nx, ny, rand) {
  const dot = vx * nx + vy * ny;
  let newVx = vx - 2 * dot * nx;
  let newVy = vy - 2 * dot * ny;
  newVx *= RESTITUTION;
  newVy *= RESTITUTION;
  // Rotate the post-bounce velocity by a small random angle. This is the
  // "luck" element — same inputs never land in the same bucket.
  const jitter = (rand() * 2 - 1) * JITTER_RAD;
  const cos = Math.cos(jitter);
  const sin = Math.sin(jitter);
  return {
    vx: newVx * cos - newVy * sin,
    vy: newVx * sin + newVy * cos,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Main simulator
// ──────────────────────────────────────────────────────────────────────────

/**
 * Simulate a single ball drop through the Plinko board.
 *
 * @param {object} opts
 * @param {number} opts.startX    X coordinate at the top of the board, in [0, 500].
 * @param {number} opts.power     Initial downward velocity scalar, in [0, 100].
 * @param {number} opts.angleDeg  Initial trajectory angle in degrees, in [-45, +45].
 *                                Positive tilts the ball right, negative tilts left.
 * @param {number} opts.seed      32-bit unsigned integer. Same seed → same trajectory.
 *
 * @returns {{
 *   path: Array<{x: number, y: number}>,  // downsampled + deduped trajectory; ends at (finalX, finalY)
 *   fellOut: boolean,                      // true if ball exited the board sides
 *   finalX: number,                        // x at bucket row (or fall-out point)
 *   finalY: number,                        // y at termination
 *   bucketIndex: number,                   // 0..4 if reached a bucket, -1 if fell out
 *   points: number,                        // base points (0 if fell out, BUCKETS[idx].basePoints otherwise)
 *   frames: number,                        // [non-spec] number of physics frames simulated
 *   substepCount: number,                  // [non-spec] total substeps (for tests/debugging)
 * }}
 *
 * Note: `frames` and `substepCount` are non-spec extras used by the test suite
 * for assertions. The server store MUST NOT depend on them — only the 6 fields
 * listed in the user spec (path, fellOut, finalX, finalY, bucketIndex, points)
 * are part of the contract. The path is deduped to within PATH_DEDUP_TOLERANCE
 * pixels between consecutive points.
 */
export function simulateBall({ startX, power, angleDeg, seed }) {
  // Defensive validation. The server store should already validate inputs, but
  // a bad value here would silently poison the trajectory. Throw early so the
  // upstream bug is caught in dev/test, not in production rounds.
  // Seeds are truncated to 32-bit unsigned ints by mulberry32, so we accept
  // any finite non-negative number and let the truncation happen there.
  assertInRange("startX", startX, 0, BOARD.width);
  assertInRange("power", power, 0, 100);
  assertInRange("angleDeg", angleDeg, -ANGLE_LIMIT_DEG, ANGLE_LIMIT_DEG);
  assertInRange("seed", seed, 0, Number.MAX_SAFE_INTEGER);

  const rand = mulberry32(seed);
  const angleRad = (angleDeg * Math.PI) / 180;

  let x = startX;
  let y = BOARD.topY;
  let vx = power * POWER_SCALE * Math.sin(angleRad);
  let vy = power * POWER_SCALE * Math.cos(angleRad);

  let path = [{ x, y }];
  let fellOut = false;
  let finalX = x;
  let finalY = y;
  let bucketIndex = -1;
  let frames = 0;
  let substepCount = 0;

  const minDist = BALL_RADIUS + PEG_RADIUS;
  const minDistSq = minDist * minDist;

  // Once the ball has cleared the top peg row, side exits count as fall-out.
  // Hoisted out of the substep loop since the gate is one-way and changes
  // exactly once per trajectory.
  let gatePassed = false;
  let terminated = false;

  for (let f = 0; f < MAX_FRAMES && !terminated; f++) {
    frames = f + 1;

    // Adaptive substepping — split the frame so no substep advances the ball
    // by more than SUBSTEP_MAX_PX. This prevents tunneling through pegs at high
    // power (initial vy can be 40 px/frame with power=100, but the peg row
    // spacing is only 22 px).
    const speed = Math.max(Math.abs(vx), Math.abs(vy));
    const substeps = Math.max(1, Math.ceil(speed / SUBSTEP_MAX_PX));
    const subVx = vx / substeps;
    const subVy = vy / substeps;
    // Per-substep gravity + friction. Distributing these across substeps keeps
    // the integrator consistent regardless of substep count.
    const subGravity = GRAVITY / substeps;
    const subFriction = Math.pow(FRICTION, 1 / substeps);

    for (let s = 0; s < substeps && !terminated; s++) {
      substepCount++;

      // 1. Apply gravity + friction per substep.
      vy += subGravity;
      vx *= subFriction;
      vy *= subFriction;

      // 2. Integrate position.
      x += subVx;
      y += subVy;

      // 3. Flip the fall-out gate the first time we clear the top peg row.
      if (!gatePassed && y > FALL_OUT_GATE_Y) gatePassed = true;

      // 4. Fall-out detection (only after the gate is passed).
      if (gatePassed && (x <= 0 || x >= BOARD.width)) {
        fellOut = true;
        finalX = x;
        finalY = y;
        terminated = true;
        break;
      }

      // 5. Peg collisions — resolve every peg the ball overlaps this substep.
      //    Record the pre-bounce position first so the client can render the
      //    ball approaching the peg before snapping to the post-bounce pos.
      for (let i = 0; i < PEGS.length; i++) {
        const peg = PEGS[i];
        const dx = x - peg.x;
        const dy = y - peg.y;
        const distSq = dx * dx + dy * dy;
        if (distSq < minDistSq && distSq > 0.0001) {
          // Record pre-bounce position so the animation shows the ball
          // approaching the peg, not teleporting to the post-bounce snap.
          if ((substepCount % PATH_DOWNSAMPLE) === 0) {
            path.push({ x, y });
          }
          const dist = Math.sqrt(distSq);
          const nx = dx / dist;
          const ny = dy / dist;
          const bounced = bounce(vx, vy, nx, ny, rand);
          vx = bounced.vx;
          vy = bounced.vy;
          // Position correction — push the ball to exactly the collision radius.
          x = peg.x + nx * minDist;
          y = peg.y + ny * minDist;
        }
      }

      // 6. Bucket arrival — terminate and classify.
      if (y >= BOARD.bucketY) {
        finalX = x;
        finalY = BOARD.bucketY;
        bucketIndex = classifyBucket(finalX);
        terminated = true;
        break;
      }

      // 7. Record path inside the substep loop, downsampled. This gives a
      //    smooth trajectory through the peg field (pre- and post-bounce
      //    positions are both captured, no visual teleport).
      if ((substepCount % PATH_DOWNSAMPLE) === 0) {
        path.push({ x, y });
      }
    }
  }

  // Safety net: if we hit MAX_FRAMES without resolving, classify wherever we
  // ended up (should be near the bucket row at that point).
  if (bucketIndex === -1 && !fellOut) {
    finalX = x;
    finalY = y;
    if (y >= BOARD.bucketY) {
      bucketIndex = classifyBucket(finalX);
    }
  }

  // Append the final landing position so the path terminates precisely at the
  // bucket center (or fall-out point). The substep loop's post-substep push
  // can be skipped by a break (bucket arrival, fall-out) one substep early.
  // For fall-out / MAX_FRAMES the last entry may already be (finalX, finalY),
  // so replace the last entry instead of pushing a duplicate.
  const last = path[path.length - 1];
  if (last && Math.abs(last.x - finalX) < 0.01 && Math.abs(last.y - finalY) < 0.01) {
    path[path.length - 1] = { x: finalX, y: finalY };
  } else {
    path.push({ x: finalX, y: finalY });
  }

  // Full-path dedup. The count-based downsample can produce many consecutive
  // near-identical points when the ball moves slowly (e.g. oscillating between
  // two pegs with low residual velocity). Walk the path once and drop any
  // point that is within PATH_DEDUP_TOLERANCE of its predecessor. The first
  // point is always preserved; the last point is force-set to the final
  // landing position so the path terminates exactly at (finalX, finalY)
  // regardless of whether dedup would have dropped it.
  const deduped = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const prev = deduped[deduped.length - 1];
    const curr = path[i];
    if (
      Math.abs(prev.x - curr.x) > PATH_DEDUP_TOLERANCE ||
      Math.abs(prev.y - curr.y) > PATH_DEDUP_TOLERANCE
    ) {
      deduped.push(curr);
    }
  }
  path = deduped;
  // Force the last entry to the final landing position. The simulation only
  // terminates at bucket-arrival (y=480), fall-out (x off-board), or
  // MAX_FRAMES — in all three cases (finalX, finalY) is the authoritative
  // landing point and must be the path's final entry.
  //
  // Note: this intentionally creates a single near-duplicate at the path
  // tail (the second-to-last and last entries can be within PATH_DEDUP_TOLERANCE
  // of each other, since dedup runs BEFORE the force-set). This is by design
  // — the spec requires the path to terminate at the landing point, even if
  // the ball settled to that position via a near-stationary substep sequence.
  path[path.length - 1] = { x: finalX, y: finalY };

  const points = fellOut
    ? 0
    : bucketIndex >= 0
    ? BUCKETS[bucketIndex].basePoints
    : 0;

  return { path, fellOut, finalX, finalY, bucketIndex, points, frames, substepCount };
}

/**
 * Validate that a value is a finite number in [min, max]. Throws on bad input
 * so server-store bugs surface in dev/test instead of silently producing a
 * "valid-looking" trajectory.
 */
function assertInRange(name, value, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(
      `plinko-pvp physics: ${name} must be a finite number, got ${value}`,
    );
  }
  if (value < min || value > max) {
    throw new RangeError(
      `plinko-pvp physics: ${name} must be in [${min}, ${max}], got ${value}`,
    );
  }
}

/**
 * Cheap hash of an arbitrary string to a 32-bit unsigned integer. Useful for
 * the server store to derive a deterministic per-ball seed from match state.
 * Uses cyrb53 (a 53-bit variant of FNV) then truncates to 32 bits.
 */
export function hashSeed(input) {
  const str = String(input);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0) ^ (h1 >>> 0);
}
