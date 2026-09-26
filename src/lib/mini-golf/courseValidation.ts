// src/lib/mini-golf/courseValidation.ts
//
// Deterministic geometric validation for generated Mini Golf holes.
//
// The generator is allowed to invent nothing, but it *is* allowed to jitter
// its parameters — so every candidate hole is checked here before it can be
// handed to a match. Validation is purely geometric (no physics integration,
// no floating-point simulation), which keeps it fast, reproducible, and
// independent of the rendering layer.
//
// What is checked
// ───────────────
//   1. shape/tuning sanity — positive size, positive cup radius, friction ∈ (0, 1]
//   2. tee and cup inside the course rectangle with ball/cup clearance
//   3. tee and cup are not buried in a wall, bumper, sand or water
//   4. obstacles do not overlap illegally (same-category circle collisions)
//   5. walls do not form a pinch narrower than MIN_CHANNEL_WIDTH — neither
//      between each other nor against the boundary
//   6. deterministic grid flood-fill reachability: the ball's centre can
//      actually travel from the tee to the cup over free cells, and the hole
//      exposes at least MIN_REACHABLE_CELLS of playable space
//
// (6) is the "ball can theoretically travel through the course" requirement.
// A full physics-based search would be non-deterministic in cost and would
// duplicate the simulator, so this discretized free-space connectivity test is
// used instead: it is exact for the stated criterion (no wall/bumper blocks the
// ball centre anywhere along a path) and cheap enough to run on every re-roll.

import { clamp } from "../physics2d/kinematics";
import {
  BALL_RADIUS,
  MIN_CHANNEL_WIDTH,
  MIN_REACHABLE_CELLS,
  REACHABILITY_CELL,
} from "./constants";
import { distancePointToSegment, isInsideCircle } from "./collision";
import type { Hole, HoleGeometry, Segment, Vec2 } from "./types";

// ── Segment helpers ───────────────────────────────────────────────────────

/** The four rectangle edges, as plain distance targets (no inward normals needed). */
function rectBoundary(width: number, height: number): Segment[] {
  return [
    { a: { x: 0, y: 0 }, b: { x: width, y: 0 } },
    { a: { x: width, y: 0 }, b: { x: width, y: height } },
    { a: { x: width, y: height }, b: { x: 0, y: height } },
    { a: { x: 0, y: height }, b: { x: 0, y: 0 } },
  ];
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** Strict proper crossing test (shared endpoints are NOT a crossing). */
function segmentsCross(s1: Segment, s2: Segment): boolean {
  const d1 = orient(s2.a.x, s2.a.y, s2.b.x, s2.b.y, s1.a.x, s1.a.y);
  const d2 = orient(s2.a.x, s2.a.y, s2.b.x, s2.b.y, s1.b.x, s1.b.y);
  const d3 = orient(s1.a.x, s1.a.y, s1.b.x, s1.b.y, s2.a.x, s2.a.y);
  const d4 = orient(s1.a.x, s1.a.y, s1.b.x, s1.b.y, s2.b.x, s2.b.y);
  return (d1 > 0) !== (d2 > 0) && d1 !== 0 && d2 !== 0 && (d3 > 0) !== (d4 > 0) && d3 !== 0 && d4 !== 0;
}

/**
 * Shortest distance between two segments. Returns 0 when they touch or cross,
 * which callers treat as "joined, not a channel".
 */
function segmentDistance(s1: Segment, s2: Segment): number {
  if (segmentsCross(s1, s2)) return 0;
  return Math.min(
    distancePointToSegment(s1.a, s2),
    distancePointToSegment(s1.b, s2),
    distancePointToSegment(s2.a, s1),
    distancePointToSegment(s2.b, s1),
  );
}

// ── Free-space model ──────────────────────────────────────────────────────

/** True when the ball's centre can sit at (x, y) without overlapping anything solid. */
export function isBallPositionFree(geometry: HoleGeometry, x: number, y: number): boolean {
  const r = BALL_RADIUS;
  const width = geometry.width ?? 0;
  const height = geometry.height ?? 0;
  if (x < r || x > width - r || y < r || y > height - r) return false;

  for (const wall of geometry.walls ?? []) {
    if (distancePointToSegment({ x, y }, wall) < r) return false;
  }
  for (const bumper of geometry.bumpers ?? []) {
    const dx = x - bumper.x;
    const dy = y - bumper.y;
    const min = bumper.r + r;
    if (dx * dx + dy * dy < min * min) return false;
  }
  return true;
}

export type ReachabilityAnalysis = {
  /** Number of free cells connected to the tee. 0 when the tee is not free. */
  reachable: number;
  /** True when the cell nearest the cup belongs to the tee-connected region. */
  cupReachable: boolean;
  cols: number;
  rows: number;
};

const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/**
 * Nearest free cell to a point: the containing cell, then an expanding ring
 * search. Returns null when the point is walled in.
 */
function nearestFreeCell(
  free: Uint8Array,
  cols: number,
  rows: number,
  x: number,
  y: number,
): number | null {
  const col0 = clamp(Math.floor(x / REACHABILITY_CELL), 0, cols - 1);
  const row0 = clamp(Math.floor(y / REACHABILITY_CELL), 0, rows - 1);
  for (let radius = 0; radius <= 3; radius += 1) {
    for (let dr = -radius; dr <= radius; dr += 1) {
      for (let dc = -radius; dc <= radius; dc += 1) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue;
        const col = col0 + dc;
        const row = row0 + dr;
        if (col < 0 || col >= cols || row < 0 || row >= rows) continue;
        const index = row * cols + col;
        if (free[index]) return index;
      }
    }
  }
  return null;
}

/**
 * Discretize the hole into a grid of ball-centre positions and flood-fill from
 * the tee. Deterministic: same geometry (and same cell size) → same result.
 */
export function analyzeReachability(geometry: HoleGeometry): ReachabilityAnalysis {
  const cols = Math.floor((geometry.width ?? 0) / REACHABILITY_CELL);
  const rows = Math.floor((geometry.height ?? 0) / REACHABILITY_CELL);
  if (cols <= 0 || rows <= 0) {
    return { reachable: 0, cupReachable: false, cols: Math.max(cols, 0), rows: Math.max(rows, 0) };
  }

  const free = new Uint8Array(cols * rows);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x = col * REACHABILITY_CELL + REACHABILITY_CELL / 2;
      const y = row * REACHABILITY_CELL + REACHABILITY_CELL / 2;
      if (isBallPositionFree(geometry, x, y)) free[row * cols + col] = 1;
    }
  }

  const teeCell = nearestFreeCell(free, cols, rows, geometry.tee.x, geometry.tee.y);
  const cupCell = nearestFreeCell(free, cols, rows, geometry.cup.x, geometry.cup.y);
  if (teeCell === null) return { reachable: 0, cupReachable: false, cols, rows };

  const visited = new Uint8Array(cols * rows);
  const stack: number[] = [teeCell];
  visited[teeCell] = 1;
  let reachable = 0;

  while (stack.length > 0) {
    const index = stack.pop() as number;
    reachable += 1;
    const col = index % cols;
    const row = (index - col) / cols;
    for (const [dc, dr] of NEIGHBOURS) {
      const nc = col + dc;
      const nr = row + dr;
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
      const neighbour = nr * cols + nc;
      if (visited[neighbour] || !free[neighbour]) continue;
      visited[neighbour] = 1;
      stack.push(neighbour);
    }
  }

  const cupReachable = cupCell !== null && visited[cupCell] === 1;
  return { reachable, cupReachable, cols, rows };
}

/** Convenience wrapper: a hole is reachable when the tee-connected region covers the cup. */
export function isHoleReachable(hole: Hole): boolean {
  if (!hole?.geometry) return false;
  return analyzeReachability(hole.geometry).cupReachable;
}

// ── Circle clearance helpers ──────────────────────────────────────────────

type Circle = { x: number; y: number; r: number };

function pointCircleOverlap(point: Vec2, circle: Circle, extra: number): boolean {
  return isInsideCircle(point, { x: circle.x, y: circle.y, r: circle.r + extra });
}

// ── The validator ─────────────────────────────────────────────────────────

/**
 * Validate a hole's playability invariants. Returns a list of human-readable
 * problems; an empty list means the hole is good and may be served to a match.
 */
export function validateHole(hole: Hole): string[] {
  const problems: string[] = [];
  const geo = hole?.geometry;
  if (!geo) return ["hole has no geometry"];

  const { width, height, tee, cup } = geo;
  const ballRadius = BALL_RADIUS;

  // 1. Shape / tuning sanity.
  if (!(width > 0) || !(height > 0)) problems.push("course must have positive size");
  if (!(cup.r > 0)) problems.push("cup radius must be positive");
  if (typeof geo.friction === "number" && !(geo.friction > 0 && geo.friction <= 1)) {
    problems.push(`friction must be in (0, 1], got ${geo.friction}`);
  }

  // 2. Tee / cup inside the rectangle.
  for (const [name, point] of [
    ["tee", tee],
    ["cup", cup],
  ] as const) {
    if (point.x < 0 || point.x > width || point.y < 0 || point.y > height) {
      problems.push(`${name} is outside the course rectangle`);
    }
  }

  if (tee.x < ballRadius || tee.x > width - ballRadius || tee.y < ballRadius || tee.y > height - ballRadius) {
    problems.push("tee is too close to the boundary for the ball");
  }
  if (cup.x < cup.r || cup.x > width - cup.r || cup.y < cup.r || cup.y > height - cup.r) {
    problems.push("cup is too close to the boundary to be entered");
  }

  // 3. Walls must not obstruct the cup or overlap the tee.
  for (const wall of geo.walls ?? []) {
    const cupClearance = distancePointToSegment(cup, wall);
    if (cupClearance < cup.r + ballRadius) {
      problems.push(`wall obstructs the cup (clearance ${cupClearance.toFixed(2)})`);
    }
    if (distancePointToSegment(tee, wall) < ballRadius * 2) {
      problems.push("wall overlaps the tee");
    }
  }

  // 4. Circular features must not sit on the tee/cup.
  for (const bumper of geo.bumpers ?? []) {
    if (pointCircleOverlap(cup, bumper, cup.r)) problems.push("bumper obstructs the cup");
    if (pointCircleOverlap(tee, bumper, ballRadius)) problems.push("bumper overlaps the tee");
  }
  for (const patch of geo.sand ?? []) {
    if (pointCircleOverlap(cup, patch, cup.r)) problems.push("sand covers the cup");
    if (pointCircleOverlap(tee, patch, ballRadius)) problems.push("sand covers the tee");
  }
  for (const water of geo.water ?? []) {
    if (pointCircleOverlap(cup, water, cup.r)) problems.push("water covers the cup");
    if (pointCircleOverlap(tee, water, ballRadius)) problems.push("water covers the tee");
  }

  // 5. Same-category obstacles must not overlap illegally.
  const overlap = (label: string, circles: readonly Circle[]) => {
    for (let i = 0; i < circles.length; i += 1) {
      for (let j = i + 1; j < circles.length; j += 1) {
        const a = circles[i];
        const b = circles[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < a.r + b.r - 1e-9) {
          problems.push(`${label} obstacles overlap (${d.toFixed(2)} < ${(a.r + b.r).toFixed(2)})`);
        }
      }
    }
  };
  overlap("bumper", geo.bumpers ?? []);
  overlap("sand", geo.sand ?? []);
  overlap("water", geo.water ?? []);

  // 6. Walls must not create a pinch the ball cannot fit through.
  const walls = geo.walls ?? [];
  for (let i = 0; i < walls.length; i += 1) {
    for (let j = i + 1; j < walls.length; j += 1) {
      const d = segmentDistance(walls[i], walls[j]);
      if (d > 1e-9 && d < MIN_CHANNEL_WIDTH) {
        problems.push(`walls form a channel too narrow for the ball (${d.toFixed(2)} < ${MIN_CHANNEL_WIDTH})`);
      }
    }
    for (const boundary of rectBoundary(width, height)) {
      const d = segmentDistance(walls[i], boundary);
      if (d > 1e-9 && d < MIN_CHANNEL_WIDTH) {
        problems.push(`wall forms a channel too narrow against the boundary (${d.toFixed(2)} < ${MIN_CHANNEL_WIDTH})`);
      }
    }
  }

  // 7. The ball must be able to travel tee → cup, over enough open space.
  if (!isBallPositionFree(geo, tee.x, tee.y)) {
    problems.push("tee is blocked by a wall or obstacle");
  }
  if (!isBallPositionFree(geo, cup.x, cup.y)) {
    problems.push("cup is blocked by a wall or obstacle");
  }
  const reachability = analyzeReachability(geo);
  if (!reachability.cupReachable) {
    problems.push("cup is not reachable from the tee");
  }
  if (reachability.reachable < MIN_REACHABLE_CELLS) {
    problems.push(
      `hole exposes too little playable space (${reachability.reachable} < ${MIN_REACHABLE_CELLS} reachable cells)`,
    );
  }

  return problems;
}
