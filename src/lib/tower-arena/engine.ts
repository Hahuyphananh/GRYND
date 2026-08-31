// src/lib/tower-arena/engine.ts
//
// Deterministic, server-authoritative Tower Arena engine.
//
// This module is the SINGLE source of truth for tower geometry and
// stability. It contains no Math.random() and no client-supplied state,
// so identical game states always produce identical outcomes. Clients
// only submit intent (block shape + anchor x + rotation); the server
// resolves the placement through these pure functions and persists the
// resulting `towerState`.
//
// Geometry model (deliberately simple so it is reproducible and cheap
// to verify, unlike arbitrary client physics):
//
//   * The tower is a grid of WIDTH × DEPTH columns. The grid floor is
//     at z = 0 and always supports what rests on it.
//   * Each block occupies a set of footprint cells (x,depth) and stacks
//     one level high: a cell at (x,d) sits at z = 1 + current height of
//     that column.
//   * Stability is a deterministic, documented predicate over the whole
//     tower (center of mass within the base + no floating/overhung
//     cells). A placement that leaves the tower unstable is a COLLAPSE.
//   * On collapse the tower is trimmed from the top, one block at a
//     time, until the retained remainder is stable again — i.e. the
//     highest stable portion is kept. Crash physics / 3D rendering
//     fidelity is a UI concern; the authoritative result the UI must
//     reproduce is `towerState` produced here.

// ── Grid constants ─────────────────────────────────────────────────────

export const GRID_WIDTH = 6;
export const GRID_DEPTH = 6;

/**
 * Baseline allowed deviation of the tower center of mass from the grid
 * center (either axis) before it is considered toppling. Blocks placed
 * off-center exceed this — good placements keep the tower centered.
 */
export const COM_MARGIN_BASE = 1.0;

/**
 * The allowed COM deviation grows slightly with the tower's average
 * height, so a well-centered tall tower stays buildable while still
 * having a finite ceiling (kept modest so risk never disappears).
 */
export const COM_HEIGHT_FACTOR = 0.35;

/**
 * Max vertical drop (in levels) between a column and its best orthogonal
 * neighbor. If a column towers more than this above every adjacent
 * column it is unsupported / floating and counts as collapse.
 */
export const MAX_SUPPORT_SLOPE = 2;

/**
 * Hard ceiling for any single column regardless of how centered it is —
 * prevents an unbounded, perfectly even "spire" that can never topple.
 */
export const MAX_ABSOLUTE_HEIGHT = 13;

/** Number of levels of interior space a cuboid occupies (all blocks are 1). */
export const BLOCK_HEIGHT = 1;

export interface TowerCell {
  x: number;
  depth: number;
  z: number;
}

export interface TowerBlock {
  /** Stable id so collapsed blocks are referenceable, e.g. "b:3". */
  id: string;
  /** One of BLOCK_SHAPES */
  shape: string;
  /** 0..3 */
  rotation: number;
  /** Anchor column (leftmost x) the footprint is shifted to. */
  x: number;
  /** Anchor depth. */
  depth: number;
  /** Resolved occupied cells — stored so the tower reproduces exactly. */
  cells: TowerCell[];
  placedByUserId: string;
  turnNumber: number;
}

export type TowerState = TowerBlock[];

export interface PlacementOutcome {
  stable: boolean;
  collapsed: boolean;
  /** Full tower after the placement + (if collapse) truncation. */
  tower: TowerState;
  /** Ids of blocks removed by a collapse (the unstable upper section). */
  removedBlockIds: string[];
  /** The freshly placed block (present even on collapse). */
  placedBlock: TowerBlock | null;
}

// ── Controlled block definitions ───────────────────────────────────────
//
// Each shape is defined by its base footprint (relative x, depth cells).
// `rotation` is applied as 90° increments in the x/depth plane; the
// footprint is normalized to the origin before use.
export const BLOCK_SHAPES = ["I", "L", "T", "square", "short"] as const;
export type BlockShape = (typeof BLOCK_SHAPES)[number];

/** Base footprint (relative x, depth) before rotation/normalization. */
export const BLOCK_FOOTPRINTS: Record<BlockShape, Array<[number, number]>> = {
  // Long straight (3 cells).
  I: [
    [0, 0],
    [0, 1],
    [0, 2],
  ],
  // Elbow (4 cells).
  L: [
    [0, 0],
    [0, 1],
    [0, 2],
    [1, 2],
  ],
  // Tee (4 cells).
  T: [
    [0, 1],
    [1, 1],
    [2, 1],
    [1, 0],
  ],
  // 2×2 square (4 cells).
  square: [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ],
  // Short straight (2 cells) — the "small block".
  short: [
    [0, 0],
    [0, 1],
  ],
};

/** Rotate a cell 90° clockwise `rot` times around the origin. */
function rotateCell(
  x: number,
  depth: number,
  rot: number,
): [number, number] {
  let rx = x;
  let rd = depth;
  const r = ((rot % 4) + 4) % 4;
  for (let i = 0; i < r; i += 1) {
    const nx = rd; // (x,d) -> (d, -x) is 90° CW in x,d
    const nd = -rx;
    rx = nx;
    rd = nd;
  }
  return [rx, rd];
}

/** Normalize a list of cells so min x and min depth are 0. */
function normalize(cells: Array<[number, number]>): Array<[number, number]> {
  let minX = Infinity;
  let minD = Infinity;
  for (const [cx, cd] of cells) {
    minX = Math.min(minX, cx);
    minD = Math.min(minD, cd);
  }
  return cells.map(([cx, cd]) => [cx - minX, cd - minD]);
}

/**
 * Footprint (relative x, depth) for a shape + rotation, normalized to
 * the origin. Deterministic — used by the sim and exposed for clients to
 * render the same orientation.
 */
export function footprintFor(shape: BlockShape, rotation: number): Array<[number, number]> {
  const base = BLOCK_FOOTPRINTS[shape];
  const rotated = base.map(([cx, cd]) => rotateCell(cx, cd, rotation));
  return normalize(rotated);
}

/** Extent (maxX, maxDepth) of a footprint, used for grid-bounds checks. */
export function footprintExtent(shape: BlockShape, rotation: number): { maxX: number; maxDepth: number } {
  let maxX = 0;
  let maxDepth = 0;
  for (const [cx, cd] of footprintFor(shape, rotation)) {
    maxX = Math.max(maxX, cx);
    maxDepth = Math.max(maxDepth, cd);
  }
  return { maxX, maxDepth };
}

/**
 * Anchor depth that centers a footprint on the depth axis, so a default
 * placement lands over the supporting base rather than at the grid edge.
 * Clients still control `x`; depth centering keeps the simple deterministic
 * model intuitive while leaving side-to-side skill placement meaningful.
 */
export function centerDepthFor(shape: BlockShape, rotation: number): number {
  const { maxDepth } = footprintExtent(shape, rotation);
  return Math.max(0, Math.floor((GRID_DEPTH - (maxDepth + 1)) / 2));
}

/** Anchors a footprint centered on the X axis (used by safe/fallback moves). */
export function centerXFor(shape: BlockShape, rotation: number): number {
  const xs = footprintFor(shape, rotation).map(([a]) => a);
  const span = Math.max(...xs) - Math.min(...xs);
  return Math.max(0, Math.floor((GRID_WIDTH - 1 - span) / 2));
}

/** True if the resolved cells all sit inside the grid. */
export function fitsInGrid(cells: Array<[number, number]>, anchorX: number, anchorDepth: number): boolean {
  for (const [cx, cd] of cells) {
    const gx = anchorX + cx;
    const gd = anchorDepth + cd;
    if (gx < 0 || gx >= GRID_WIDTH || gd < 0 || gd >= GRID_DEPTH) return false;
  }
  return true;
}

// ── Tower helpers ──────────────────────────────────────────────────────

function heightMap(tower: TowerState): number[][] {
  const h: number[][] = Array.from({ length: GRID_WIDTH }, () =>
    new Array<number>(GRID_DEPTH).fill(0),
  );
  for (const b of tower) {
    for (const c of b.cells) {
      h[c.x][c.depth] = Math.max(h[c.x][c.depth], c.z);
    }
  }
  return h;
}

/**
 * Compute the resolved cells of a placed block: each footprint cell sits
 * at z = 1 + current column height at that (x,depth). `existing` is the
 * current height map (pre-placement).
 */
function resolveBlockCells(
  shape: BlockShape,
  x: number,
  depth: number,
  rotation: number,
  h: number[][],
): TowerCell[] {
  return footprintFor(shape, rotation).map(([cx, cd]) => {
    const gx = x + cx;
    const gd = depth + cd;
    return { x: gx, depth: gd, z: 1 + h[gx][gd] };
  });
}

/**
 * Center of mass of the tower (each occupied cell = unit mass). AXES are
 * 0.5-based so a single column at x=0 reads 0.5, the grid center reads 3.
 */
export function towerCenterOfMass(tower: TowerState): { cx: number; cd: number; mass: number } {
  let mass = 0;
  let sx = 0;
  let sd = 0;
  for (const b of tower) {
    for (const c of b.cells) {
      sx += c.x + 0.5;
      sd += c.depth + 0.5;
      mass += 1;
    }
  }
  if (mass === 0) return { cx: GRID_WIDTH / 2, cd: GRID_DEPTH / 2, mass: 0 };
  return { cx: sx / mass, cd: sd / mass, mass };
}

const ORTHO: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * Deterministic stability predicate.
 *
 * A tower is stable when:
 *   1. No column towers more than MAX_SUPPORT_SLOPE above its best
 *      orthogonal neighbor (no unsupported / floating protrusions).
 *   2. The tower center of mass stays within COM_MARGIN levels of the
 *      grid center on BOTH axes (it is not tilting over the edge).
 *
 * The empty tower and a tower resting entirely on the floor always pass
 * check 1; check 2 uses the compact column height map, so this is O(grid)
 * per evaluation.
 */
export function isStable(tower: TowerState): boolean {
  const h = heightMap(tower);

  // (1) Uniformity of support around each column.
  for (let x = 0; x < GRID_WIDTH; x += 1) {
    for (let d = 0; d < GRID_DEPTH; d += 1) {
      const col = h[x][d];
      if (col <= 1) continue; // sits on / near the floor
      let bestNeighbor = 0;
      for (const [dx, dd] of ORTHO) {
        const nx = x + dx;
        const nd = d + dd;
        if (nx < 0 || nx >= GRID_WIDTH || nd < 0 || nd >= GRID_DEPTH) continue;
        bestNeighbor = Math.max(bestNeighbor, h[nx][nd]);
      }
      if (col - bestNeighbor > MAX_SUPPORT_SLOPE) return false;
    }
  }

  // (2) No column may exceed the absolute build ceiling.
  for (let x = 0; x < GRID_WIDTH; x += 1) {
    for (let d = 0; d < GRID_DEPTH; d += 1) {
      if (h[x][d] > MAX_ABSOLUTE_HEIGHT) return false;
    }
  }

  // (3) The center of mass must stay acceptably near the grid center
  // (i.e. over the supporting base), with a gentle allowance that grows
  // with the tower's average height.
  let sumH = 0;
  let count = 0;
  for (let x = 0; x < GRID_WIDTH; x += 1) {
    for (let d = 0; d < GRID_DEPTH; d += 1) {
      if (h[x][d] > 0) {
        sumH += h[x][d];
        count += 1;
      }
    }
  }
  const avgH = count > 0 ? sumH / count : 1;
  const margin = COM_MARGIN_BASE + COM_HEIGHT_FACTOR * avgH;

  const { cx, cd } = towerCenterOfMass(tower);
  const centerX = GRID_WIDTH / 2; // 3 for WIDTH 6
  const centerD = GRID_DEPTH / 2;
  if (Math.abs(cx - centerX) > margin) return false;
  if (Math.abs(cd - centerD) > margin) return false;

  return true;
}

/**
 * Place a block and return the resulting tower (always added, even if the
 * placement would be unstable — stability is judged by the caller).
 */
export function applyPlacementBlock(
  tower: TowerState,
  params: {
    shape: BlockShape;
    x: number;
    depth?: number;
    rotation?: number;
    blockId: string;
    placedByUserId: string;
    turnNumber: number;
  },
): TowerBlock {
  const depth = params.depth ?? 0;
  const rotation = Number.isInteger(params.rotation) ? params.rotation : 0;
  const h = heightMap(tower);
  const cells = resolveBlockCells(params.shape, params.x, depth, rotation, h);
  const block: TowerBlock = {
    id: params.blockId,
    shape: params.shape,
    rotation,
    x: params.x,
    depth,
    cells,
    placedByUserId: params.placedByUserId,
    turnNumber: params.turnNumber,
  };
  return block;
}

/**
 * Run a full placement: resolve the block, append it, check stability,
 * and on collapse trim from the top until the retained remainder passes
 * the stability predicate (keeps the highest stable portion).
 */
export function simulatePlacement(
  tower: TowerState,
  params: {
    shape: BlockShape;
    x: number;
    depth?: number;
    rotation?: number;
    blockId: string;
    placedByUserId: string;
    turnNumber: number;
  },
): PlacementOutcome {
  const block = applyPlacementBlock(tower, params);
  const provisional = [...tower, block];
  if (isStable(provisional)) {
    return { stable: true, collapsed: false, tower: provisional, removedBlockIds: [], placedBlock: block };
  }

  // Collapse: trim the highest block(s) from the top until stable.
  const removed: string[] = [];
  let retained = provisional;
  while (retained.length > 0 && !isStable(retained)) {
    // Remove the block whose highest cell is tallest; tie-break by
    // ascending id so the result is fully deterministic.
    let idx = 0;
    let maxZ = -1;
    retained.forEach((b, i) => {
      const bz = b.cells.reduce((m, c) => Math.max(m, c.z), 0);
      if (bz > maxZ) {
        maxZ = bz;
        idx = i;
      }
    });
    removed.push(retained[idx].id);
    retained = retained.filter((_, i) => i !== idx);
  }

  return {
    stable: retained.length > 0,
    collapsed: removed.length > 0,
    tower: retained,
    removedBlockIds: removed,
    placedBlock: block,
  };
}

// ── Resource pool ──────────────────────────────────────────────────────
//
// The shared pool is server-owned. Composition scales with seat count so
// more players -> more resources. The pieces are arranged deterministically
// (seeded by match id + cycle) so audits can reproduce availability order.

export interface ResourcePiece {
  id: string;
  shape: BlockShape;
}

/**
 * Per-player-count pacing — how many of EACH shape a fresh cycle carries.
 * Tuned so the total placement budget (pool pieces ÷ active players per turn)
 * lands the targeted match durations:
 *
 *   players   blocks/cycle   ~placements/cycle   ~match time @8s/turn
 *   2         10             ~10                ~1–2 min
 *   3         15             ~5 /player          ~1.5–2.5 min
 *   4         20             ~5 /player          ~2–3 min
 *   5         25             ~5 /player          ~2.5–3.5 min
 *   6         30             ~5 /player          ~3–4 min
 *
 * Each placement consumes one piece and costs one 8s window; a cycle refills
 * on every elimination, so the match keeps momentum toward 1 survivor without
 * letting a cycle run so long the match drags.
 */
const CYCLE_SHAPES_PER_PLAYER: Record<number, number> = {
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
};

/** Composition of a fresh pool for `maxPlayers` seats. */
function poolComposition(maxPlayers: number): BlockShape[] {
  const p = Math.max(2, Math.min(6, Math.trunc(maxPlayers)));
  const perShape = CYCLE_SHAPES_PER_PLAYER[p] ?? 2;
  const shapes: BlockShape[] = [];
  const add = (s: BlockShape, n: number) => {
    for (let i = 0; i < n; i += 1) shapes.push(s);
  };
  add("I", perShape);
  add("L", perShape);
  add("T", perShape);
  add("square", perShape);
  add("short", perShape);
  return shapes;
}

/** Small deterministic PRNG (mulberry32) seeded from a string. */
function seededRandom(seedStr: string): () => number {
  let a = 0;
  for (let i = 0; i < seedStr.length; i += 1) {
    a = (a + seedStr.charCodeAt(i)) | 0;
    a = Math.imul(a, 2654435761);
  }
  a = a >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a fresh, deterministic resource pool for a cycle. `nonce`
 * disambiguates multiple refills within one match (e.g. matchId:cycle).
 */
export function buildResourcePool(maxPlayers: number, nonce: string): ResourcePiece[] {
  const shapes = poolComposition(maxPlayers);
  const rand = seededRandom(`tower-arena:${nonce}:${maxPlayers}`);
  // Fisher-Yates deterministic shuffle.
  for (let i = shapes.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [shapes[i], shapes[j]] = [shapes[j], shapes[i]];
  }
  return shapes.map((shape, idx) => ({
    id: `p:${nonce}:${idx}`,
    shape,
  }));
}

/** Remove one piece of `shape` from the pool; returns the taken piece (or null). */
export function takeFromPool(pool: ResourcePiece[], shape: BlockShape): { pool: ResourcePiece[]; piece: ResourcePiece | null } {
  const idx = pool.findIndex((p) => p.shape === shape);
  if (idx === -1) return { pool, piece: null };
  const [piece] = pool.splice(idx, 1);
  return { pool, piece };
}

/** Append a fresh set of pieces to an existing pool (non-empty refill). */
export function refillResourcePool(pool: ResourcePiece[], maxPlayers: number, nonce: string): ResourcePiece[] {
  return [...pool, ...buildResourcePool(maxPlayers, nonce)];
}