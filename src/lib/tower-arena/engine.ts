// src/lib/tower-arena/engine.ts
//
// Deterministic, server-authoritative Tower Arena engine.
//
// This module is the SINGLE source of truth for tower geometry, gravity and
// stability. It contains no Math.random() and no client-supplied state, so
// identical game states always produce identical outcomes. Clients only
// submit intent (block shape + drop column + rotation); the server resolves
// the placement through these pure functions and persists the resulting
// `towerState`.
//
// Geometry model — a 2D line tower floating in a void (deliberately simple
// so it is reproducible and cheap to verify, unlike arbitrary client physics):
//
//   * The world is a 2D slice. The FLOOR is a 1-cell-thick line of
//     GRID_WIDTH columns at z = 0. Everything around it — left, right and
//     below — is the VOID (bottomless; nothing to land on there).
//   * A block is a solid rectangle (width × height) of unit cells. Players
//     DROP blocks from the sky at a chosen x (the block's leftmost column).
//     There are NO side walls: the block may be aimed anywhere across the
//     stage, including fully into the void beside the platform — a drop
//     with no in-bounds column under it misses everything and falls.
//   * The block falls straight down and settles at z = 1 + the tallest
//     column height under its footprint (only in-bounds columns count).
//     Blocks are SLIGHTLY SLIPPERY: if the landing is off-balance the
//     block slips sideways at its landing height (up to SLIDE_BUDGET cells,
//     same level) toward the stronger support — it never teleports to
//     another height. Still unstable after slipping → it tips and falls.
//   * Stability is a deterministic physics predicate evaluated on a block
//     AND the whole stack resting on it: a block is stable only if its
//     gravity stack (itself + every block supported by it, transitively)
//     has its combined center of mass over the direct support below (with
//     a small overhang allowance) and enough touching cells. Adding a block
//     on top can shift a lower stack's center of mass off its support —
//     that is CONTACT + SHOCK: the shocked stacks shed off the tower and
//     fall into the void together.
//   * A void fall (dropped block OR shed stacks) removes those blocks from
//     play and the tower CONTINUES in its post-fall state: landing-only
//     falls leave the tower untouched, shock sheds trim it to what remains
//     stable — if the whole tower goes, the game continues on the empty
//     floor. The player whose turn caused any block to fall is eliminated
//     (elimination rules live in the turn resolver / store).
//   * There is NO height ceiling: the tower can grow as tall as players keep
//     stacking it. The shared pool and the risk of wide drops on narrow
//     support (and of leaning stacks tipping) keep the game moving.

// ── Grid constants ─────────────────────────────────────────────────────

export const GRID_WIDTH = 5;

/** The board is a 2D slice: the floor line is one cell "deep". */
export const GRID_DEPTH = 1;

/** Legacy export (blocks now vary in height; see BLOCK_DIMS). */
export const BLOCK_HEIGHT = 1;

/**
 * How far a block's center of mass may sit past the edge of its direct
 * support (in cells) before it tips. Allows the classic one-cell Jenga
 * overhang; anything beyond that falls into the void.
 */
export const OVERHANG_ALLOWANCE = 1;

/** Minimum number of directly-supported cells a block needs to balance. */
export function minSupportWidth(width: number): number {
  return Math.max(1, Math.ceil(width / 2));
}

// ── Block definitions ──────────────────────────────────────────────────
//
// Each shape is a solid rectangle of (width × height) cells in side view.
// Width matters for balancing (wide blocks need wide support); height builds
// the tower faster while raising the risk surface for every later drop.

export const BLOCK_SHAPES = ["I", "L", "T", "square", "short"] as const;
export type BlockShape = (typeof BLOCK_SHAPES)[number];

// Blocks are intentionally on the small side so the floor stays visible and
// drops stay delicate: the widest block spans just over half the floor.
export const BLOCK_DIMS: Record<BlockShape, { w: number; h: number }> = {
  I: { w: 3, h: 1 }, // long beam
  L: { w: 1, h: 2 }, // spire
  T: { w: 2, h: 2 }, // post
  square: { w: 2, h: 1 }, // brick
  short: { w: 1, h: 1 }, // cube
};

/** Legacy alias of BLOCK_DIMS (footprints previously described the top-down grid). */
export const BLOCK_FOOTPRINTS: Record<BlockShape, Array<[number, number]>> = {
  I: [[0, 0], [1, 0], [2, 0]],
  L: [[0, 0], [0, 1]],
  T: [[0, 0], [1, 0], [0, 1], [1, 1]],
  square: [[0, 0], [1, 0]],
  short: [[0, 0]],
};

function normalizedRotation(rotation: number): number {
  if (!Number.isInteger(rotation)) return 0;
  return ((rotation % 4) + 4) % 4;
}

/** Effective width (cells) of a shape at a rotation. Odd rotations flip width↔height. */
export function blockWidth(shape: BlockShape, rotation: number): number {
  const { w, h } = BLOCK_DIMS[shape];
  return normalizedRotation(rotation) % 2 === 1 ? h : w;
}

/** Effective height (cells) of a shape at a rotation. */
export function blockHeight(shape: BlockShape, rotation: number): number {
  const { w, h } = BLOCK_DIMS[shape];
  return normalizedRotation(rotation) % 2 === 1 ? w : h;
}

/**
 * Relative (x, z) cells of a shape + rotation, normalized to the origin.
 * Rotation 1 (and 3) transpose the rectangle: a flat beam becomes a post.
 */
export function blockCells(shape: BlockShape, rotation: number): Array<[number, number]> {
  const w = blockWidth(shape, rotation);
  const h = blockHeight(shape, rotation);
  const cells: Array<[number, number]> = [];
  for (let rx = 0; rx < w; rx += 1) {
    for (let rz = 0; rz < h; rz += 1) cells.push([rx, rz]);
  }
  return cells;
}

/** Legacy alias — the "footprint" of a block is now its side-view cells. */
export const footprintFor = blockCells;

/** Extent of a block: maxX = width−1, maxDepth = height−1 (name kept for callers). */
export function footprintExtent(shape: BlockShape, rotation: number): { maxX: number; maxDepth: number } {
  return { maxX: blockWidth(shape, rotation) - 1, maxDepth: blockHeight(shape, rotation) - 1 };
}

/**
 * Legal aim range for a drop — there are NO side walls: the block's leftmost
 * column may sit anywhere from fully left of the platform (its columns are
 * all in the void) to fully right of it. Aiming into the void is legal and
 * resolves as a void fall (eliminating the dropper); the WILL-FALL preview
 * warns before that happens. Only completely wild aims outside this window
 * are rejected.
 */
export function dropRangeFor(shape: BlockShape, rotation: number): { minX: number; maxX: number } {
  const w = blockWidth(shape, rotation);
  return { minX: -(w), maxX: GRID_WIDTH };
}

/** True if `x` is a legal drop column for the shape+rotation. */
export function dropInBounds(shape: BlockShape, rotation: number, x: number): boolean {
  const { minX, maxX } = dropRangeFor(shape, rotation);
  return Number.isInteger(x) && x >= minX && x <= maxX;
}

/**
 * Slipperiness: how far a block may slip sideways at its landing height to
 * find a stable seat before it tips and falls. Deliberately small — blocks
 * are "slightly slippery, still solid", never skate across the board.
 */
export const SLIDE_BUDGET = 2;

/** Anchors a block visually centered on the X axis (used by safe/fallback moves). */
export function centerXFor(shape: BlockShape, rotation: number): number {
  return Math.max(0, Math.floor((GRID_WIDTH - blockWidth(shape, rotation)) / 2));
}

/** The line board has no depth axis — the centered depth is always 0. */
export function centerDepthFor(_shape?: BlockShape, _rotation?: number): number {
  return 0;
}

/**
 * True if every x-cell of the footprint is inside the grid when anchored at
 * `anchorX` (i.e. the block sits fully on the platform). Drop aim may
 * legitimately overhang via `dropInBounds` instead.
 */
export function fitsInGrid(cells: Array<[number, number]>, anchorX: number, _anchorDepth?: number): boolean {
  for (const [cx] of cells) {
    const gx = anchorX + cx;
    if (gx < 0 || gx >= GRID_WIDTH) return false;
  }
  return true;
}

// ── Tower model ────────────────────────────────────────────────────────

export interface TowerCell {
  x: number;
  depth: number;
  z: number;
}

export interface TowerBlock {
  /** Stable id so blocks are referenceable, e.g. "b:3". */
  id: string;
  /** One of BLOCK_SHAPES */
  shape: string;
  /** 0..3 (odd = transposed rectangle) */
  rotation: number;
  /** Drop column (leftmost x of the footprint). */
  x: number;
  /** Always 0 in the 2D model (line board). */
  depth: number;
  /** Landing height of the block's bottom row (z ≥ 1; −1 when it missed the floor). */
  z: number;
  /** Resolved block width (cells). */
  width: number;
  /** Resolved block height (cells). */
  height: number;
  /** Resolved occupied cells — stored so the tower reproduces exactly. */
  cells: TowerCell[];
  placedByUserId: string;
  turnNumber: number;
}

export type TowerState = TowerBlock[];

export interface PlacementOutcome {
  /** True when the placed block landed and the resulting tower is stable. */
  stable: boolean;
  /** True = blocks fell into the void this placement (eliminates its dropper). */
  collapsed: boolean;
  /** Tower after the placement: unchanged on a landing fall, trimmed by sheds. */
  tower: TowerState;
  /** Ids of every block removed by a void fall (dropped block + shed stacks). */
  removedBlockIds: string[];
  /** The freshly placed block as resolved (present even on a void fall). */
  placedBlock: TowerBlock | null;
  /** Every block that fell this placement (with its pre-fall cells). */
  fallenBlocks: TowerBlock[];
  /** Whether the block slipped sideways (SLIDE_BUDGET) to find its seat. */
  slid: boolean;
  /** Final leftmost column after any slide (== placedBlock.x). */
  finalX: number;
}

// ── Tower helpers ──────────────────────────────────────────────────────

function heightMap(tower: TowerState): number[] {
  const h = new Array<number>(GRID_WIDTH).fill(0);
  for (const b of tower) {
    for (const c of b.cells) {
      if (c.x >= 0 && c.x < GRID_WIDTH) h[c.x] = Math.max(h[c.x], c.z);
    }
  }
  return h;
}

/**
 * Resolve the cells a block would occupy if dropped at column `x` (rotated
 * `rotation`) onto the current tower: it falls straight down and settles at
 * z = 1 + the tallest in-bounds column under its footprint. If no in-bounds
 * column is under the footprint the block misses the floor — cells are
 * returned empty and it falls into the void.
 */
export function applyPlacementBlock(
  tower: TowerState,
  params: {
    shape: BlockShape;
    x: number;
    rotation?: number;
    blockId: string;
    placedByUserId: string;
    turnNumber: number;
  },
): TowerBlock {
  const rotation = normalizedRotation(params.rotation ?? 0);
  const cells2 = blockCells(params.shape, rotation);
  const w = blockWidth(params.shape, rotation);
  const h = blockHeight(params.shape, rotation);
  const hm = heightMap(tower);

  let maxUnder = -1;
  let anyInBounds = false;
  for (const [rx] of cells2) {
    const gx = params.x + rx;
    if (gx >= 0 && gx < GRID_WIDTH) {
      anyInBounds = true;
      maxUnder = Math.max(maxUnder, hm[gx]);
    }
  }
  const z0 = anyInBounds ? 1 + Math.max(0, maxUnder) : -1;

  const cells: TowerCell[] = z0 >= 0
    ? cells2.map(([rx, rz]) => ({ x: params.x + rx, depth: 0, z: z0 + rz }))
    : [];

  return {
    id: params.blockId,
    shape: params.shape,
    rotation,
    x: params.x,
    depth: 0,
    z: z0,
    width: w,
    height: h,
    cells,      placedByUserId: params.placedByUserId,
    turnNumber: params.turnNumber,
  };
}

// ── Stability physics ──────────────────────────────────────────────────

/** Bottom row z of a resolved block (its landing height). */
function blockBottomZ(block: TowerBlock): number {
  let z = Infinity;
  for (const c of block.cells) z = Math.min(z, c.z);
  return z;
}

/** Top row z of a resolved block. */
function blockTopZ(block: TowerBlock): number {
  let z = -Infinity;
  for (const c of block.cells) z = Math.max(z, c.z);
  return z;
}

/** Average x of the block's cell centers (its own center of mass). */
function blockComX(block: TowerBlock): number {
  let sum = 0;
  let n = 0;
  for (const c of block.cells) {
    sum += c.x + 0.5;
    n += 1;
  }
  return n === 0 ? 0 : sum / n;
}

/**
 * Direct support of a block: the columns under its bottom row that touch
 * something (the floor — only inside the grid — or a block top exactly one
 * level below), as the support span + count. The block's own cells are
 * above the bottom row, so they can never count as support.
 */
function supportOf(
  block: TowerBlock,
  tower: TowerState,
): { minS: number; maxS: number; count: number } {
  const zBot = blockBottomZ(block);
  const cells = block.cells;
  if (cells.length === 0) return { minS: Infinity, maxS: -Infinity, count: 0 };

  const occupied = new Set<string>();
  for (const b of tower) for (const c of b.cells) occupied.add(`${c.x}:${c.z}`);

  let minS = Infinity;
  let maxS = -Infinity;
  let count = 0;
  for (const c of cells) {
    if (c.z !== zBot) continue; // only the bottom row matters
    const overFloor = c.x >= 0 && c.x < GRID_WIDTH;
    const supported = (overFloor && zBot === 1) || occupied.has(`${c.x}:${zBot - 1}`);
    if (supported) {
      minS = Math.min(minS, c.x);
      maxS = Math.max(maxS, c.x);
      count += 1;
    }
  }
  return { minS, maxS, count };
}

/**
 * Blocks that rest (directly or transitively) on `block` within `tower`:
 * X rests on Y when X's bottom row touches Y's top row in some column.
 * The returned stack includes `block` itself.
 */
function gravityStack(block: TowerBlock, tower: TowerState): TowerBlock[] {
  const stack = [block];
  const rest = tower.filter((b) => b.id !== block.id);
  let grew = true;
  while (grew) {
    grew = false;
    for (const x of rest) {
      if (stack.some((s) => s.id === x.id)) continue;
      const xZ = blockBottomZ(x);
      for (const s of stack) {
        const sTop = blockTopZ(s);
        if (sTop !== xZ - 1) continue;
        const xCols = new Set<number>();
        for (const c of x.cells) if (c.z === xZ) xCols.add(c.x);
        for (const c of s.cells) {
          if (c.z === sTop && xCols.has(c.x)) {
            stack.push(x);
            grew = true;
            break;
          }
        }
        if (grew) break;
      }
      if (grew) break;
    }
  }
  return stack;
}

/**
 * Deterministic physics predicate: would `block` tip and fall, given the
 * whole tower it stands in? A block is stable iff its gravity stack (itself
 * plus everything supported by it) has its combined center of mass over the
 * direct support span below (with OVERHANG_ALLOWANCE each side) and the base
 * touches enough support cells. This is what makes "contact + shock" work:
 * a new block on top can shift a lower stack's load off its support.
 */
export function stackUnstable(block: TowerBlock, tower: TowerState): boolean {
  if (block.cells.length === 0) return true; // missed the platform entirely

  const stack = gravityStack(block, tower);
  let sum = 0;
  let mass = 0;
  for (const b of stack) {
    for (const c of b.cells) {
      sum += c.x + 0.5;
      mass += 1;
    }
  }
  const com = sum / mass;

  const { minS, maxS, count } = supportOf(block, tower);
  if (count === 0 || count < minSupportWidth(block.width)) return true;
  if (com < minS - OVERHANG_ALLOWANCE || com > maxS + OVERHANG_ALLOWANCE) return true;

  return false;
}

/**
 * Landing predicate: would the given (already resolved) block tip when
 * dropped onto the given tower? Evaluated against the tower WITHOUT the
 * block (the block is not yet a member on placement). A freshly landed
 * block carries nothing above it, so this is the own-mass case of
 * `stackUnstable`.
 */
export function wouldFall(block: TowerBlock, tower: TowerState): boolean {
  return stackUnstable(block, [...tower, block]);
}

/**
 * Deterministic stability predicate over the whole tower: every block plus
 * its load passes the support/balance rules. Blocks placed through this
 * engine are stable by construction (unstable drops never join and shock
 * sheds remove anything that tipped), so this audits stored towers and
 * client-side drop previews.
 */
export function isStable(tower: TowerState): boolean {
  for (const b of tower) {
    if (stackUnstable(b, tower)) return false;
  }
  return true;
}

/**
 * Blocks that directly support `block` (their top row touches its bottom row
 * in some column).
 */
function supportsOf(block: TowerBlock, tower: TowerState): TowerBlock[] {
  const zBot = blockBottomZ(block);
  const cols = new Set<number>();
  for (const c of block.cells) if (c.z === zBot) cols.add(c.x);
  const out: TowerBlock[] = [];
  for (const y of tower) {
    if (y.id === block.id) continue;
    if (blockTopZ(y) !== zBot - 1) continue;
    for (const c of y.cells) {
      if (c.z === zBot - 1 && cols.has(c.x)) {
        out.push(y);
        break;
      }
    }
  }
  return out;
}

/**
 * Contact + shock: after a placement settles, any stack whose load has been
 * pushed off-balance sheds — top-down, each unstable block takes everything
 * resting on it into the void. The tower was stable before the drop, so ONLY
 * the dropped block's support chain can become unbalanced — blocks elsewhere
 * carry identical loads. Loads (each block + everything resting on it) are
 * computed in ONE top-down pass, so the sweep stays fast even when the tower
 * grows (no height ceiling) instead of BFS-ing every candidate. The tower
 * continues in its stable remainder (which may be empty: the whole tower can
 * fall and the game goes on).
 */
export function shedUnstableStacks(tower: TowerState): { tower: TowerState; fallen: TowerBlock[] } {
  const remaining = tower.slice();
  const fallen: TowerBlock[] = [];
  if (remaining.length === 0) return { tower: remaining, fallen };

  // The block dropped THIS placement is the newest (highest turnNumber).
  const dropped = remaining.reduce((a, b) => (b.turnNumber > a.turnNumber ? b : a));

  // Blocks resting DIRECTLY on each block (their bottom row touches its top
  // row in some column) — the load-flow edges. Built once per placement,
  // grouped by bottom level so the scan stays ~linear in tower size.
  const byBottomLevel = new Map<number, TowerBlock[]>();
  for (const b of remaining) {
    const lv = blockBottomZ(b);
    const list = byBottomLevel.get(lv) || [];
    list.push(b);
    byBottomLevel.set(lv, list);
  }
  const restersOf = new Map<string, TowerBlock[]>();
  for (const b of remaining) {
    const bTop = blockTopZ(b);
    const topCols = new Set<number>();
    for (const c of b.cells) if (c.z === bTop) topCols.add(c.x);
    const list: TowerBlock[] = [];
    for (const y of byBottomLevel.get(bTop + 1) || []) {
      if (y.id === b.id) continue;
      for (const c of y.cells) {
        if (c.z === bTop + 1 && topCols.has(c.x)) {
          list.push(y);
          break;
        }
      }
    }
    restersOf.set(b.id, list);
  }

  // One top-down pass: each block's load = itself + the loads of every block
  // resting on it (those are all processed already, since they sit higher).
  const order = remaining
    .slice()
    .sort((a, b) => blockTopZ(b) - blockTopZ(a) || b.turnNumber - a.turnNumber);
  const loadMass = new Map<string, number>();
  const loadX = new Map<string, number>();
  for (const b of order) {
    let m = 0;
    let s = 0;
    for (const c of b.cells) {
      m += 1;
      s += c.x + 0.5;
    }
    for (const y of restersOf.get(b.id) || []) {
      m += loadMass.get(y.id) || 0;
      s += loadX.get(y.id) || 0;
    }
    loadMass.set(b.id, m);
    loadX.set(b.id, s);
  }

  // Only the dropped block's support chain can be new-unbalanced. Process it
  // top-down; each shedding only lightens stacks below, so one pass suffices.
  const chain = [dropped];
  let grew = true;
  while (grew) {
    grew = false;
    const add: TowerBlock[] = [];
    for (const x of chain) {
      for (const y of supportsOf(x, remaining)) {
        if (!chain.some((c) => c.id === y.id)) add.push(y);
      }
    }
    for (const y of add) chain.push(y);
    grew = add.length > 0;
  }
  chain.sort((a, b) => blockTopZ(b) - blockTopZ(a) || b.turnNumber - a.turnNumber);

  for (const b of chain) {
    if (!remaining.some((x) => x.id === b.id)) continue; // already shed
    const m = loadMass.get(b.id) || 0;
    if (m === 0) continue;
    const com = (loadX.get(b.id) || 0) / m;
    const { minS, maxS, count } = supportOf(b, remaining);
    const unstable =
      count === 0 ||
      count < minSupportWidth(b.width) ||
      com < minS - OVERHANG_ALLOWANCE ||
      com > maxS + OVERHANG_ALLOWANCE;
    if (unstable) {
      for (const s of gravityStack(b, remaining)) {
        const idx = remaining.findIndex((x) => x.id === s.id);
        if (idx >= 0) remaining.splice(idx, 1);
        fallen.push(s);
      }
    }
  }
  return { tower: remaining, fallen };
}

// ── Placement ──────────────────────────────────────────────────────────

/**
 * Slippery landing: resolve the drop at its aim column; if it lands
 * off-balance, slip it sideways (at the SAME landing height — never across
 * a gap to another level) up to SLIDE_BUDGET cells toward the stronger
 * support. A completely off-platform aim (no in-bounds column) never slips
 * back on — it falls. Returns `fell` when no stable seat exists.
 */
function settleWithSlide(
  tower: TowerState,
  params: {
    shape: BlockShape;
    x: number;
    rotation?: number;
    blockId: string;
    placedByUserId: string;
    turnNumber: number;
  },
): { fell: boolean; block: TowerBlock; finalX: number; slid: boolean } {
  const base = applyPlacementBlock(tower, params);
  if (base.cells.length === 0) return { fell: true, block: base, finalX: params.x, slid: false };
  if (!wouldFall(base, tower)) return { fell: false, block: base, finalX: params.x, slid: false };

  // Which way to slip: toward the side whose load tips (a block leaning
  // right slips left and vice-versa); on thin support, toward the support.
  const { minS, maxS, count } = supportOf(base, tower);
  const cx = blockComX(base);
  let dir = 0;
  if (count > 0) {
    if (cx > maxS + OVERHANG_ALLOWANCE) dir = -1;
    else if (cx < minS - OVERHANG_ALLOWANCE) dir = 1;
    else dir = cx * 2 >= minS + maxS ? -1 : 1; // thin support → toward it
  }

  const attempts: number[] = [];
  const push = (d: number) => {
    if (d !== 0 && !attempts.includes(d)) attempts.push(d);
  };
  push(dir);
  push(2 * dir);
  push(-dir);
  push(-2 * dir);

  for (const d of attempts) {
    const probe = applyPlacementBlock(tower, { ...params, x: params.x + d });
    // Same-height slip only: the probe must land on the same surface, not
    // fall to another level (that's a fall, not a slip).
    if (probe.cells.length === 0) continue;
    if (blockBottomZ(probe) !== blockBottomZ(base)) continue;
    if (!wouldFall(probe, tower)) return { fell: false, block: probe, finalX: probe.x, slid: true };
  }
  return { fell: true, block: base, finalX: params.x, slid: false };
}

/**
 * Run a full placement: the block drops from the sky, slips into a stable
 * seat if it can, then the tower sheds whatever its landing shocked
 * off-balance. A landing fall leaves the tower unchanged; a shock shed
 * trims it to the stable remainder — the game continues either way (the
 * dropper is eliminated when ANY block fell).
 */
export function simulatePlacement(
  tower: TowerState,
  params: {
    shape: BlockShape;
    x: number;
    rotation?: number;
    blockId: string;
    placedByUserId: string;
    turnNumber: number;
  },
): PlacementOutcome {
  const landed = settleWithSlide(tower, params);
  if (landed.fell) {
    return {
      stable: false,
      collapsed: true,
      tower,
      removedBlockIds: [landed.block.id],
      placedBlock: landed.block,
      fallenBlocks: [landed.block],
      slid: false,
      finalX: landed.finalX,
    };
  }

  const joined = [...tower, landed.block];
  const { tower: after, fallen } = shedUnstableStacks(joined);
  const collapsed = fallen.length > 0;
  return {
    stable: !collapsed,
    collapsed,
    tower: after,
    removedBlockIds: fallen.map((f) => f.id),
    placedBlock: landed.block,
    fallenBlocks: fallen,
    slid: landed.slid,
    finalX: landed.finalX,
  };
}

/**
 * Deterministic "safe drop" search for fallback/AI moves: tries the smallest
 * available shapes first, at centered-then-outward aim columns and both
 * rotations, and returns the first placement that would NOT fall into the
 * void. Returns null when every option is doomed (e.g. the tower tops out).
 */
export function findSafeDrop(
  tower: TowerState,
  available: BlockShape[],
): { shape: BlockShape; x: number; rotation: number } | null {
  const preference: BlockShape[] = ["short", "square", "I", "T", "L"];
  const shapes = preference.filter((s) => available.includes(s));
  if (shapes.length === 0) return null;

  for (const shape of shapes) {
    for (const rotation of [0, 1]) {
      const { minX, maxX } = dropRangeFor(shape, rotation);
      const cx = centerXFor(shape, rotation);
      // Centered first, then fan outward — the most natural safe anchor.
      const tried = new Set<number>();
      const attempts: number[] = [];
      for (let d = 0; d <= GRID_WIDTH; d += 1) {
        const l = cx - d;
        const r = cx + d;
        if (l >= minX && !tried.has(l)) {
          tried.add(l);
          attempts.push(l);
        }
        if (r <= maxX && !tried.has(r)) {
          tried.add(r);
          attempts.push(r);
        }
      }
      for (const x of attempts) {
        // Full placement outcome — a drop that LOOKS balanced but shocks a
        // leaning stack off the tower is NOT safe (it kills the dropper).
        const out = simulatePlacement(tower, {
          shape,
          x,
          rotation,
          blockId: "probe",
          placedByUserId: "",
          turnNumber: 0,
        });
        if (!out.collapsed) return { shape, x, rotation };
      }
    }
  }
  return null;
}

// ── Resource pool ──────────────────────────────────────────────────────
//
// The shared pool is server-owned — the game's LIMITED RESOURCE. Composition
// scales with seat count so more players -> more resources, and pieces are
// arranged deterministically (seeded by match id + cycle) so audits can
// reproduce availability order.

export interface ResourcePiece {
  id: string;
  shape: BlockShape;
}

/**
 * Per-player-count pacing — how many of EACH shape a fresh cycle carries.
 * Tuned so the total placement budget (pool pieces ÷ active players per turn)
 * lands the targeted match durations. Each placement consumes one piece;
 * a cycle refills on every elimination and when it runs dry, keeping matches
 * from stalling on the shared pool.
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