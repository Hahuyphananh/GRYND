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
  BALL_COLLISION_RESTITUTION,
  BALL_COLLISION_MAX_CORRECTION_PX,
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
  BALL_COLLISION_RESTITUTION,
  BALL_COLLISION_MAX_CORRECTION_PX,
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
  // Seeds are coerced to 32-bit unsigned ints by the `>>> 0` below and by
  // mulberry32 internally — we accept any int32-bit value and the downstream
  // PRNG treats equivalent bit patterns identically.
  assertInRange("startX", startX, 0, BOARD.width);
  assertInRange("power", power, 0, 100);
  assertInRange("angleDeg", angleDeg, -ANGLE_LIMIT_DEG, ANGLE_LIMIT_DEG);
  // Coerce-via-`>>> 0` first so a signed-int hashSeed output (which
  // the JS XOR can produce despite mulberry32's internal coercion)
  // lands as a positive 32-bit value BEFORE the range check.
  // Without this, certain hashes (e.g. "plinko:13:p1:ball1:manual")
  // can hit the negative half of int32 and 500 the match route.
  assertInRange("seed", seed >>> 0, 0, Number.MAX_SAFE_INTEGER);

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

      // 2. Integrate position using current velocity (not pre-computed
      //    subVx/subVy) so the position update reflects velocity changes
      //    from collisions within the same frame. This matches the
      //    integration scheme used by simulateDualBalls.
      x += vx / substeps;
      y += vy / substeps;

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
  // Final `>>> 0` to coerce the XOR result to an unsigned 32-bit int.
  // Without this, JS's `^` operator returns a signed 32-bit Number
  // (range [-2^31, 2^31-1]), which trips the physics assertInRange
  // (seed must be in [0, MAX_SAFE_INTEGER]) and surfaces as a 500 on
  // /api/plinko-pvp/match/[matchId] for hashes like "plinko:13:p1:
  // ball1:manual" that happen to land in the negative half of int32.
  // Bit pattern is preserved — mulberry32 coerces with `>>> 0`
  // internally so PRNG sequences are unchanged.
  return ((h2 >>> 0) ^ (h1 >>> 0)) >>> 0;
}

// ──────────────────────────────────────────────────────────────────────────
// Dual-ball simulator — runs both balls in lockstep, with elastic
// ball-ball collision so the two balls can knock each other off course.
// ──────────────────────────────────────────────────────────────────────────
//
// Why this exists:
//   The user explicitly asked for ball-on-ball physics so the two balls
//   don't "slide past" each other in mid-air. Simulating both balls in
//   one loop avoids the impossible post-hoc splice (Plinko's peg layout
//   is dense, so a single mid-air velocity swap changes the whole
//   downstream trajectory).
//
// Physics model simplifications (documented for transparency):
//   • Equal mass — both balls have BALL_RADIUS so impulse = -(1+e)*vN/2.
//   • Per-ball PRNG — ball 1 jitter uses seed1, ball 2 jitter uses seed2.
//     This preserves the determinism contract: same (matchId, ballNumber,
//     seat) inputs always produce the same path, with or without a partner.
//   • Position correction is CAPPED per-substep (BALL_COLLISION_MAX_CORRECTION_PX)
//     so a corner-cascade near a peg cluster can't shove a ball through
//     the board wall in a single tick.
//   • Per-ball fall-out is independent: if ball 1 flies off the side,
//     ball 2 keeps simulating. (The dual-track animation is easier to read
//     when both balls complete their frames, and the server rounds-row
//     already records per-ball final positions.)
//
// Termination:
//   • A ball reaching y >= bucketY is finalised using its CURRENT x at
//     that substep (no extra adjustment).
//   • A ball that has fallen out of the side gutters freezes (its position
//     no longer advances and it stops checking peg/ball collisions).
//   • MAX_FRAMES is the safety cap (matches simulateBall).

/**
 * Finalise a single dual-ball trajectory so it conforms to the same shape
 * `simulateBall` returns — used to squish the lockstep output back into
 * the existing rounds-row payload shape.
 */
function finalizeBall({ path, finalX, finalY, bucketIndex, fellOut }, {
  exitReason,
}) {
  // Append / replace last entry with the authoritative landing position.
  const last = path[path.length - 1];
  if (
    last &&
    Math.abs(last.x - finalX) < 0.01 &&
    Math.abs(last.y - finalY) < 0.01
  ) {
    path[path.length - 1] = { x: finalX, y: finalY };
  } else {
    path.push({ x: finalX, y: finalY });
  }
  // Full-path dedup to keep the animation payload small.
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
  path[path.length - 1] = { x: finalX, y: finalY };
  const points = fellOut
    ? 0
    : bucketIndex >= 0
    ? BUCKETS[bucketIndex].basePoints
    : 0;
  return {
    path,
    fellOut,
    finalX,
    finalY,
    bucketIndex,
    points,
    // extras for tests (mirror simulateBall)
    exitReason,
  };
}

/**
 * Resolve peg collisions for a single ball against the static peg grid.
 * Mutates the ball's x/y/vx/vy and pushes onto `path` when a recordable
 * bounce is detected.
 */
function resolvePegCollisions(ball, substepCount, minDist, minDistSq) {
  for (let i = 0; i < PEGS.length; i++) {
    const peg = PEGS[i];
    const dx = ball.x - peg.x;
    const dy = ball.y - peg.y;
    const distSq = dx * dx + dy * dy;
    if (distSq < minDistSq && distSq > 0.0001) {
      if (substepCount % PATH_DOWNSAMPLE === 0) {
        ball.path.push({ x: ball.x, y: ball.y });
      }
      const dist = Math.sqrt(distSq);
      const nx = dx / dist;
      const ny = dy / dist;
      const bounced = bounce(ball.vx, ball.vy, nx, ny, ball.rand);
      ball.vx = bounced.vx;
      ball.vy = bounced.vy;
      ball.x = peg.x + nx * minDist;
      ball.y = peg.y + ny * minDist;
    }
  }
}

/**
 * Simulate two balls in lockstep with elastic ball-ball collision.
 * Both balls share the same substep count per frame so they advance
 * equal wall-clock distance — no drift between the two tracks.
 *
 * @param {object} p1 - { startX, power, angleDeg, seed }
 * @param {object} p2 - { startX, power, angleDeg, seed }
 * @returns {{
 *   result1: { path, fellOut, finalX, finalY, bucketIndex, points, exitReason },
 *   result2: { path, fellOut, finalX, finalY, bucketIndex, points, exitReason },
 * }}
 */
export function simulateDualBalls(p1, p2) {
  // Validate both inputs identically to simulateBall. Throw early so
  // server-store bugs surface in dev/test.
  assertInRange("p1.startX", p1.startX, 0, BOARD.width);
  assertInRange("p1.power", p1.power, 0, 100);
  assertInRange("p1.angleDeg", p1.angleDeg, -ANGLE_LIMIT_DEG, ANGLE_LIMIT_DEG);
  // Same defensive `>>> 0` coercion as simulateBall so the dual
  // simulator can't 500 the match route on int32-negative hashes.
  assertInRange("p1.seed", p1.seed >>> 0, 0, Number.MAX_SAFE_INTEGER);
  assertInRange("p2.startX", p2.startX, 0, BOARD.width);
  assertInRange("p2.power", p2.power, 0, 100);
  assertInRange("p2.angleDeg", p2.angleDeg, -ANGLE_LIMIT_DEG, ANGLE_LIMIT_DEG);
  // Same defensive `>>> 0` coercion as simulateBall so the dual
  // simulator can't 500 the match route on int32-negative hashes.
  assertInRange("p2.seed", p2.seed >>> 0, 0, Number.MAX_SAFE_INTEGER);

  // Ball state objects — mutated in-place by the substep loop. Mirrors
  // simulateBall's locals, lifted to object fields for dual readability.
  const angleRad1 = (p1.angleDeg * Math.PI) / 180;
  const angleRad2 = (p2.angleDeg * Math.PI) / 180;

  const ball1 = {
    x: p1.startX,
    y: BOARD.topY,
    vx: p1.power * POWER_SCALE * Math.sin(angleRad1),
    vy: p1.power * POWER_SCALE * Math.cos(angleRad1),
    rand: mulberry32(p1.seed),
    active: true,
    fellOut: false,
    gatePassed: false,
    finalX: p1.startX,
    finalY: BOARD.topY,
    bucketIndex: -1,
    path: [{ x: p1.startX, y: BOARD.topY }],
    substepCount: 0,
  };
  const ball2 = {
    x: p2.startX,
    y: BOARD.topY,
    vx: p2.power * POWER_SCALE * Math.sin(angleRad2),
    vy: p2.power * POWER_SCALE * Math.cos(angleRad2),
    rand: mulberry32(p2.seed),
    active: true,
    fellOut: false,
    gatePassed: false,
    finalX: p2.startX,
    finalY: BOARD.topY,
    bucketIndex: -1,
    path: [{ x: p2.startX, y: BOARD.topY }],
    substepCount: 0,
  };

  const minDist = BALL_RADIUS + PEG_RADIUS;
  const minDistSq = minDist * minDist;
  // Ball-ball collision threshold: when the two centers are within
  // (2 * BALL_RADIUS) of each other along the contact normal.
  const ballMinDist = BALL_RADIUS * 2;
  const ballMinDistSq = ballMinDist * ballMinDist;

  // Outer loop. Both balls terminate when they hit the bucket row
  // OR fall out, OR we hit MAX_FRAMES. If ball1 lands early ball2
  // keeps simulating so its own path is recorded (useful when
  // ball1 falls out and ball2 still gets a 100-pt safe-bucket).
  for (let f = 0; f < MAX_FRAMES; f++) {
    const speed1 = ball1.active
      ? Math.max(Math.abs(ball1.vx), Math.abs(ball1.vy))
      : 0;
    const speed2 = ball2.active
      ? Math.max(Math.abs(ball2.vx), Math.abs(ball2.vy))
      : 0;
    const maxSpeed = Math.max(speed1, speed2, 0.001);
    const substeps = Math.max(1, Math.ceil(maxSpeed / SUBSTEP_MAX_PX));
    const subGravity = GRAVITY / substeps;
    const subFriction = Math.pow(FRICTION, 1 / substeps);

    for (let s = 0; s < substeps; s++) {
      // 1. Integrate both balls. Inactive (fell-out) balls are skipped.
      if (ball1.active) {
        ball1.vy += subGravity;
        ball1.vx *= subFriction;
        ball1.vy *= subFriction;
        ball1.x += ball1.vx / substeps;
        ball1.y += ball1.vy / substeps;
        ball1.substepCount++;
      }
      if (ball2.active) {
        ball2.vy += subGravity;
        ball2.vx *= subFriction;
        ball2.vy *= subFriction;
        ball2.x += ball2.vx / substeps;
        ball2.y += ball2.vy / substeps;
        ball2.substepCount++;
      }

      // 2. Per-ball fall-out detection (only after the top peg row).
      if (ball1.active && !ball1.gatePassed && ball1.y > FALL_OUT_GATE_Y) {
        ball1.gatePassed = true;
      }
      if (ball1.active && ball1.gatePassed &&
          (ball1.x <= 0 || ball1.x >= BOARD.width)) {
        ball1.fellOut = true;
        ball1.finalX = ball1.x;
        ball1.finalY = ball1.y;
        ball1.active = false;
      }
      if (ball2.active && !ball2.gatePassed && ball2.y > FALL_OUT_GATE_Y) {
        ball2.gatePassed = true;
      }
      if (ball2.active && ball2.gatePassed &&
          (ball2.x <= 0 || ball2.x >= BOARD.width)) {
        ball2.fellOut = true;
        ball2.finalX = ball2.x;
        ball2.finalY = ball2.y;
        ball2.active = false;
      }

      // 3. Peg collisions (peg first, ball-on-ball second — order
      //    matters because the ball-ball impulse depends on a stable
      //    post-peg position estimate).
      if (ball1.active) resolvePegCollisions(ball1, ball1.substepCount, minDist, minDistSq);
      if (ball2.active) resolvePegCollisions(ball2, ball2.substepCount, minDist, minDistSq);

      // 4. Ball-ball elastic collision. Only when BOTH balls are
      //    active (an already-fell-out ball can't be kicked).
      if (ball1.active && ball2.active) {
        const dx = ball2.x - ball1.x;
        const dy = ball2.y - ball1.y;
        const distSq = dx * dx + dy * dy;
        if (distSq < ballMinDistSq && distSq > 0.0001) {
          const dist = Math.sqrt(distSq);
          const nx = dx / dist;
          const ny = dy / dist;
          const vrx = ball2.vx - ball1.vx;
          const vry = ball2.vy - ball1.vy;
          const vDot = vrx * nx + vry * ny;
          // Apply velocity impulse only when balls are approaching
          // (vDot < 0). If they're already separating, skip impulse
          // to prevent jitter.
          if (vDot < 0) {
            const impulse =
              (-(1 + BALL_COLLISION_RESTITUTION) * vDot) / 2;
            // Equal-mass elastic: ball1 receives -impulse along n,
            // ball2 receives +impulse along n.
            ball1.vx -= impulse * nx;
            ball1.vy -= impulse * ny;
            ball2.vx += impulse * nx;
            ball2.vy += impulse * ny;
          }
          // ALWAYS apply position correction when balls overlap,
          // even when vDot >= 0 (zero relative velocity or already
          // separating). Without this, overlapping balls that start
          // with identical velocities (e.g. both launched straight
          // down from nearby positions) never get separated and
          // visually merge into one blob — the user-reported
          // "sometimes only one ball falls" bug.
          const overlap = ballMinDist - dist;
          const correction = Math.min(
            overlap / 2,
            BALL_COLLISION_MAX_CORRECTION_PX,
          );
          ball1.x -= nx * correction;
          ball1.y -= ny * correction;
          ball2.x += nx * correction;
          ball2.y += ny * correction;
        }
      }

      // 5. Bucket arrival for either ball — record final spot and
      //    freeze that ball. The other ball keeps simulating.
      if (ball1.active && ball1.y >= BOARD.bucketY) {
        ball1.finalX = ball1.x;
        ball1.finalY = BOARD.bucketY;
        ball1.bucketIndex = classifyBucket(ball1.finalX);
        ball1.active = false;
      }
      if (ball2.active && ball2.y >= BOARD.bucketY) {
        ball2.finalX = ball2.x;
        ball2.finalY = BOARD.bucketY;
        ball2.bucketIndex = classifyBucket(ball2.finalX);
        ball2.active = false;
      }

      // 6. Record downsampled path entries (post-collision positions
      //    so the client renders the post-bump motion correctly).
      if (ball1.active &&
          ball1.substepCount % PATH_DOWNSAMPLE === 0) {
        ball1.path.push({ x: ball1.x, y: ball1.y });
      }
      if (ball2.active &&
          ball2.substepCount % PATH_DOWNSAMPLE === 0) {
        ball2.path.push({ x: ball2.x, y: ball2.y });
      }

      // Short-circuit: both balls are finalised.
      if (!ball1.active && !ball2.active) break;
    }
    if (!ball1.active && !ball2.active) break;
  }

  // MAX_FRAMES safety net — classify any ball that didn't terminate
  // cleanly but is at/under the bucket row.
  for (const b of [ball1, ball2]) {
    if (b.bucketIndex === -1 && !b.fellOut) {
      b.finalX = b.x;
      b.finalY = b.y;
      if (b.y >= BOARD.bucketY) {
        b.bucketIndex = classifyBucket(b.finalX);
      }
    }
  }

  return {
    result1: finalizeBall(ball1, { exitReason: ball1.fellOut ? "fellOut" : ball1.bucketIndex >= 0 ? "bucket" : "maxFrames" }),
    result2: finalizeBall(ball2, { exitReason: ball2.fellOut ? "fellOut" : ball2.bucketIndex >= 0 ? "bucket" : "maxFrames" }),
  };
}
