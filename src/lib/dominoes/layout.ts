/**
 * Dominoes — WHERE EACH TILE SITS ON THE TABLE.
 *
 * The engine owns the chain as an ORDER (`chain[0]` … `chain[n-1]`, left to
 * right, with each tile's exposed halves). It says nothing about geometry, and it
 * must not: a line of tiles is a table, and a table is drawn.
 *
 * This module turns that order into a real table path — the layout a physical or
 * online domino game produces:
 *
 *   * THE CHAIN GROWS FROM ITS OPENING TILE, IN BOTH DIRECTIONS. The engine
 *     PREPENDS a tile played on the left end and APPENDS one played on the right,
 *     and every tile records the end it was attached to (`end`). So the opening
 *     tile is the LAST tile in the array that was attached on the left — the
 *     left-hand segment sits before it in reverse-chronological order and the
 *     right-hand segment after it. Laying the chain out from that pivot means a
 *     left play widens the table leftwards and a right play widens it rightwards,
 *     without the line sliding under the player.
 *
 *   * A DOUBLE LIES ACROSS THE RUN, AND THE RUN CARRIES STRAIGHT ON. It is set
 *     down with its long side against the tile that led in — the cross a real
 *     domino makes — and the tile after it leaves from the double's leading LONG
 *     side, travelling the way the chain already was. A VERTICAL DOUBLE DOES NOT
 *     TURN THE TABLE: the tiles after it are horizontal, abreast of it, which is
 *     what the eye expects of a double. An opening double is crosswise too, and
 *     the chain leaves it to the left and to the right.
 *
 *   * THE LINE TURNS AT THE BOARD'S EDGE. The caller may pass the board it has
 *     (`limits`, in cells); a tile that would stick out past those limits is
 *     turned inwards instead, so the chain snakes inside the felt the player can
 *     see rather than growing into a region they would have to scroll to find.
 *     With no limits a run still bends at `RUN_CELLS`, so a table can never
 *     become one endless row.
 *
 *   * TILES NEVER OVERLAP AND NEVER FLOAT OFF. Every tile is checked against the
 *     tiles already placed, and the walk BACKTRACKS to an earlier tile when the
 *     ones after it cannot be seated at all: a chain that curled back through
 *     itself is a real shape, a tile hanging in space is not.
 *
 * UNITS: one cell is HALF A TILE. A tile is 2 cells long and 1 cell wide, so a
 * normal tile advances the chain by 2 cells and a crosswise double by 1. The
 * board converts cells to pixels with one CSS variable (`--dm-half`), which is
 * why nothing here needs to know the screen size.
 *
 * PURE: no React, no CSS, no engine rule. The caller passes the projection's
 * chain and gets positions back; the clock, the hand and the server are none of
 * its business.
 */

/** One tile of the engine's chain, as a projection sends it. */
export type ChainTileLike = {
  id?: unknown;
  end?: unknown;
  isDouble?: unknown;
};

/** Which way the chain is travelling at a tile. Screen coordinates: y grows DOWN. */
export type LayoutDirection = "right" | "down" | "left" | "up";

/** A tile's drawn rotation, in degrees, of its natural horizontal 2:1 box. */
export type TileRotation = 0 | 90 | 180 | 270;

/** Where one tile sits, in half-tile cells, with the opening tile at (0, 0). */
export type PlacedTile = {
  /** Index into the engine's `chain` array. */
  readonly index: number;
  /** Centre of the tile, in cells. */
  readonly cx: number;
  readonly cy: number;
  readonly rotation: TileRotation;
  readonly direction: LayoutDirection;
  readonly isDouble: boolean;
};

/** The whole table: every tile, and the box the caller must make room for. */
export type ChainLayout = {
  readonly tiles: readonly PlacedTile[];
  /** Cell bounds, grown from the tiles actually placed. */
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  /** Size of the table in cells (`max - min`). 0 when the chain is empty. */
  readonly cols: number;
  readonly rows: number;
  /** Index of the opening tile the path was grown from, or -1 when empty. */
  readonly pivot: number;
};

/** A tile's long axis, in cells. */
export const TILE_LENGTH_CELLS = 2;
/** A tile's short axis, in cells. */
export const TILE_WIDTH_CELLS = 1;
/**
 * How far the chain runs in one direction before the path turns.
 *
 * Eight cells is four tiles: the longest run that still reads at a glance on a
 * phone without the player having to scroll to find where the chain went. It is
 * the fallback for a caller that hands over no board to fit into — given
 * `limits`, the BOARD'S OWN EDGE is what turns the line, however long that run
 * happens to be.
 */
export const RUN_CELLS = 8;

/**
 * The board the chain has to stay inside, in half-tile cells.
 *
 * Centred on the opening tile (which is where the surface is centred too), so a
 * chain that respects these bounds is a chain that is on screen. The caller sizes
 * it from the felt it actually has; nothing here knows about pixels.
 */
export type ChainLimits = {
  /** Cells across the board. */
  readonly cols: number;
  /** Cells down the board. */
  readonly rows: number;
};

const STEP: Readonly<Record<LayoutDirection, { x: number; y: number }>> = {
  right: { x: 1, y: 0 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  up: { x: 0, y: -1 },
};

/** The rotation that lays a normal tile along the chain's direction. */
const ROTATION_OF: Readonly<Record<LayoutDirection, TileRotation>> = {
  right: 0,
  down: 90,
  left: 180,
  up: 270,
};

/** Turn a quarter clockwise on screen: right → down → left → up → right. */
function clockwise(direction: LayoutDirection): LayoutDirection {
  switch (direction) {
    case "right":
      return "down";
    case "down":
      return "left";
    case "left":
      return "up";
    default:
      return "right";
  }
}

function counterClockwise(direction: LayoutDirection): LayoutDirection {
  switch (direction) {
    case "right":
      return "up";
    case "up":
      return "left";
    case "left":
      return "down";
    default:
      return "right";
  }
}

function opposite(direction: LayoutDirection): LayoutDirection {
  return clockwise(clockwise(direction));
}

/** `"6-3"` → `["6", "3"]`, or null when the projection carried no usable id. */
function halvesOf(tile: ChainTileLike): [string, string] | null {
  const match = /^(\d+)-(\d+)$/.exec(String(tile?.id ?? ""));
  return match ? [match[1], match[2]] : null;
}

/** A double, from the engine's flag or — if it was not projected — the id. */
export function isDoubleTile(tile: ChainTileLike): boolean {
  if (tile?.isDouble === true) return true;
  if (tile?.isDouble === false) return false;
  const halves = halvesOf(tile);
  return halves ? halves[0] === halves[1] : false;
}

type Rect = { x0: number; y0: number; x1: number; y1: number };
type Point = { x: number; y: number };

/** The box a tile of this rotation covers, centred on (cx, cy). */
function footprint(cx: number, cy: number, rotation: TileRotation): Rect {
  const crosswise = rotation % 180 === 90;
  const w = crosswise ? TILE_WIDTH_CELLS : TILE_LENGTH_CELLS;
  const h = crosswise ? TILE_LENGTH_CELLS : TILE_WIDTH_CELLS;
  return { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
}

/** Overlap with a tolerance, so two tiles may touch along an edge. */
function overlaps(a: Rect, b: Rect): boolean {
  const epsilon = 0.01;
  return (
    a.x0 < b.x1 - epsilon &&
    b.x0 < a.x1 - epsilon &&
    a.y0 < b.y1 - epsilon &&
    b.y0 < a.y1 - epsilon
  );
}

/**
 * The opening tile: the LAST tile that was attached to the left end.
 *
 * The engine keeps the chain in spatial order, so everything appended to the
 * right end sits after the opening tile, and everything prepended to the left end
 * sits before it in reverse-chronological order. The opening tile is therefore
 * the rightmost tile whose `end` is `"left"`. A projection that carries no `end`
 * at all (a fixture, or a very old row) falls back to index 0, which lays the
 * chain out in array order.
 */
export function pivotIndex(chain: readonly ChainTileLike[]): number {
  if (chain.length === 0) return -1;
  let pivot = -1;
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    if (String(chain[index]?.end ?? "") === "left") {
      pivot = index;
      break;
    }
  }
  return pivot === -1 ? 0 : pivot;
}

/** A connection point moved along a direction. */
function shift(point: Point, direction: LayoutDirection, distance: number): Point {
  const step = STEP[direction];
  return { x: point.x + step.x * distance, y: point.y + step.y * distance };
}

/**
 * Where a tile lands, given the edge it attaches to (its connection point).
 *
 * A normal tile fills both cells ahead of the point. A double only reaches half a
 * cell ahead — its width — because it lies ACROSS the run; its long side is what
 * meets the tile it was played against.
 */
function placeAt(
  from: Point,
  direction: LayoutDirection,
  isDouble: boolean,
): { cx: number; cy: number; rotation: TileRotation; advance: number } {
  const step = STEP[direction];
  const advance = isDouble ? TILE_WIDTH_CELLS : TILE_LENGTH_CELLS;
  return {
    cx: from.x + (step.x * advance) / 2,
    cy: from.y + (step.y * advance) / 2,
    rotation: ((ROTATION_OF[direction] + (isDouble ? 90 : 0)) % 360) as TileRotation,
    advance,
  };
}

/** One place the next tile could attach, and the way it would run from there. */
type Attempt = {
  from: Point;
  direction: LayoutDirection;
};

/** Which way the path turns when it decides to turn. */
type TurnBias = (direction: LayoutDirection) => LayoutDirection;

/** The state the walk carries from one tile to the next. */
type WalkState = {
  /** The edge the next tile attaches to. */
  point: Point;
  heading: LayoutDirection;
  /** Cells run in `heading` since the last turn. */
  run: number;
};

/**
 * Where the next tile may attach, most wanted first.
 *
 * CARRYING ON COMES FIRST, WHETHER OR NOT THE LAST TILE WAS A DOUBLE. A double is
 * DRAWN across the run (see `rotationOf`) but it does not BEND it: `placeAt`
 * advanced it by its short side only, so the point it hands on is the middle of
 * its leading long side and the next tile leaves from there, in the same
 * direction. A vertical double is therefore followed by horizontal tiles. Turning
 * is now only what the board's edge (or a caller's `runCells`) asks for, and it is
 * offered as the three preferences after straight on.
 */
function attemptsFrom(
  state: WalkState,
  isDouble: boolean,
  turnBias: TurnBias,
  runCells: number,
): Attempt[] {
  let preferred = state.heading;
  if (state.run >= runCells) preferred = turnBias(state.heading);

  // Two tiles at right angles cannot share their full end edges: the turn happens
  // around the corner, so a tile that changes direction starts half its own width
  // further along, and its long side meets the previous tile's end edge. Carrying
  // straight on needs no shift — the edges already meet.
  const cornerShift = (isDouble ? TILE_LENGTH_CELLS : TILE_WIDTH_CELLS) / 2;

  return [preferred, turnBias(preferred), turnBias(turnBias(turnBias(preferred))), opposite(preferred)].map(
    (direction) => ({
      from:
        direction === state.heading
          ? { ...state.point }
          : shift(state.point, state.heading, cornerShift),
      direction,
    }),
  );
}

/**
 * The state after this tile has been laid.
 *
 * A DOUBLE NEEDS NO SPECIAL CASE HERE: `placeAt` already advanced it by its short
 * side only, so the point it hands on is the middle of its leading long side —
 * exactly where the next tile attaches.
 */
function advanceState(
  state: WalkState,
  attempt: Attempt,
  placement: { cx: number; cy: number; advance: number },
): WalkState {
  return {
    point: shift(attempt.from, attempt.direction, placement.advance),
    heading: attempt.direction,
    // A turn starts a fresh band; carrying straight on extends the current one.
    run:
      attempt.direction === state.heading
        ? state.run + placement.advance
        : placement.advance,
  };
}

/**
 * How many placements one arm may try before it settles for the fallback.
 *
 * A double-six chain is at most 28 tiles, and the walk only BACKTRACKS when a run
 * genuinely boxes itself in — so a real chain needs a few dozen nodes. This
 * ceiling is what keeps a pathological one from stalling a frame.
 */
const WALK_NODE_BUDGET = 20000;

/**
 * Lay one half of the chain out from the pivot.
 *
 * `order` is walked AWAY from the opening tile, so the cursor always starts at
 * the tile the previous one was played next to.
 *
 * ── WHY IT SEARCHES ───────────────────────────────────────────────────────
 *
 * A greedy walk can corner itself: the run carries on, the next tile has every
 * side blocked, and the only way out is to leave a gap — a tile floating off its
 * neighbour, which is exactly what this module exists to avoid. So the walk is a
 * depth-first search in preference order. It only goes back to an earlier tile
 * when the tiles after it cannot be seated at all, which leaves ordinary chains
 * identical to the greedy walk and keeps the table CONNECTED when it curls back
 * through itself.
 *
 * Returns true when every tile of `order` was seated contiguously. With
 * `allowGaps` the remaining tiles are placed after a short break instead, which
 * is the last resort the caller only reaches when no plan fits — a broken line
 * still shows where every tile went.
 *
 * THE BOARD IS A LIMIT, NOT A TARGET. When `limits` is given, every candidate tile
 * is checked against it with the same rejection as an overlap, so a tile that
 * would stick out past the felt is never chosen: the walk simply takes the next
 * preference, which is a turn, and the chain snakes along the edge instead of
 * growing the table. The later attempts in `attemptsFrom` are what make that work
 * — straight on is the first choice, turning is the one that survives the limit.
 */
function walkSide({
  chain,
  order,
  cursor,
  direction,
  mirrored,
  placed,
  occupied,
  runCells,
  limits,
  turnBias,
  allowGaps,
}: {
  chain: readonly ChainTileLike[];
  order: readonly number[];
  cursor: Point;
  direction: LayoutDirection;
  /** True when this side is walked AGAINST the chain's array order. */
  mirrored: boolean;
  placed: (PlacedTile | undefined)[];
  occupied: Rect[];
  runCells: number;
  /** The board the tiles must stay inside, or null for an unbounded table. */
  limits: ChainLimits | null;
  turnBias: TurnBias;
  allowGaps: boolean;
}): boolean {
  let budget = WALK_NODE_BUDGET;

  /** The rendered rotation of a tile on this side, facing its chain neighbour. */
  const rotationOf = (attempt: Attempt, isDouble: boolean): TileRotation => {
    // VALUES READ IN CHAIN ORDER. `chain[i].left` faces `chain[i-1]` and
    // `chain[i].right` faces `chain[i+1]`, and the array is spatially ordered —
    // so a tile is drawn with its OWN left half toward whichever screen side
    // holds the previous tile. The left arm is walked against that order, which
    // flips the direction its faces point in; the walk heading alone would print
    // every tile on that arm backwards and break the joins.
    const forward = mirrored ? opposite(attempt.direction) : attempt.direction;
    return ((ROTATION_OF[forward] + (isDouble ? 90 : 0)) % 360) as TileRotation;
  };

  const extend = (position: number, state: WalkState): boolean => {
    if (position >= order.length) return true;
    if (budget <= 0) return false;
    budget -= 1;

    const index = order[position];
    const tile = chain[index];
    const isDouble = isDoubleTile(tile);

    for (const attempt of attemptsFrom(state, isDouble, turnBias, runCells)) {
      const placement = placeAt(attempt.from, attempt.direction, isDouble);
      const box = footprint(placement.cx, placement.cy, placement.rotation);
      if (occupied.some((taken) => overlaps(box, taken))) continue;
      // Off the felt: rejected exactly like an overlap, so the walk turns into
      // the board rather than stretching it.
      if (!fitsInside(box, limits)) continue;

      const previous = placed[index];
      placed[index] = {
        index,
        cx: placement.cx,
        cy: placement.cy,
        rotation: rotationOf(attempt, isDouble),
        direction: attempt.direction,
        isDouble,
      };
      occupied.push(box);

      if (extend(position + 1, advanceState(state, attempt, placement))) return true;

      occupied.pop();
      placed[index] = previous;
    }

    return false;
  };

  const start: WalkState = {
    point: { ...cursor },
    heading: direction,
    run: 0,
  };
  if (extend(0, start)) return true;
  if (!allowGaps) return false;

  // Last resort: no contiguous plan fits (a table packed far denser than a
  // double-six chain produces, or the budget ran out). Place the rest with short
  // breaks rather than dropping them, so every tile still has a place on the
  // board and the player can follow the line.
  let state = start;
  for (const index of order) {
    if (placed[index]) continue;
    const tile = chain[index];
    const isDouble = isDoubleTile(tile);
    const attempts = attemptsFrom(state, isDouble, turnBias, runCells);

    let chosen: { attempt: Attempt; placement: ReturnType<typeof placeAt> } | null = null;
    for (const attempt of attempts) {
      const placement = placeAt(attempt.from, attempt.direction, isDouble);
      const box = footprint(placement.cx, placement.cy, placement.rotation);
      if (occupied.some((taken) => overlaps(box, taken))) continue;
      chosen = { attempt, placement };
      break;
    }
    if (!chosen && attempts.length > 0) {
      const { from, direction: gapDirection } = attempts[0];
      const step = STEP[gapDirection];
      for (let gap = 0.5; gap <= 24; gap += 0.5) {
        const shifted = { x: from.x + step.x * gap, y: from.y + step.y * gap };
        const placement = placeAt(shifted, gapDirection, isDouble);
        const box = footprint(placement.cx, placement.cy, placement.rotation);
        if (!occupied.some((taken) => overlaps(box, taken))) {
          chosen = { attempt: { from: shifted, direction: gapDirection }, placement };
          break;
        }
      }
    }
    if (!chosen) continue;

    placed[index] = {
      index,
      cx: chosen.placement.cx,
      cy: chosen.placement.cy,
      rotation: rotationOf(chosen.attempt, isDouble),
      direction: chosen.attempt.direction,
      isDouble,
    };
    occupied.push(footprint(chosen.placement.cx, chosen.placement.cy, chosen.placement.rotation));
    state = advanceState(state, chosen.attempt, chosen.placement);
  }

  return false;
}

/**
 * The plans the table is built with, most natural first.
 *
 * Each side of the chain is one long path starting at the opening tile, and the
 * two paths share one board — so the side that is laid out first can wall the
 * other one in. Rather than accept that (a tile would have to float off the
 * line), the table is retried: the other side first, and with the turns bending
 * the other way. One of them seats every tile, and the first that does wins, so
 * an ordinary chain still gets the plain plan.
 */
const PLANS: readonly { rightFirst: boolean; turnBias: TurnBias }[] = [
  { rightFirst: true, turnBias: clockwise },
  { rightFirst: false, turnBias: clockwise },
  { rightFirst: true, turnBias: counterClockwise },
  { rightFirst: false, turnBias: counterClockwise },
];

/**
 * Is this box inside the board the caller gave us?
 *
 * A tile may touch the limit exactly — the chain can run along the edge of the
 * felt — so the comparison is inclusive, within a hair of rounding.
 */
function fitsInside(box: Rect, limits: ChainLimits | null): boolean {
  if (!limits) return true;
  const epsilon = 0.01;
  const halfCols = limits.cols / 2;
  const halfRows = limits.rows / 2;
  return (
    box.x0 >= -halfCols - epsilon &&
    box.x1 <= halfCols + epsilon &&
    box.y0 >= -halfRows - epsilon &&
    box.y1 <= halfRows + epsilon
  );
}

/** The bounds of a placed table, or the origin when it is empty. */
function boundsOf(placed: readonly (PlacedTile | undefined)[]) {
  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;
  for (const tile of placed) {
    if (!tile) continue;
    const box = footprint(tile.cx, tile.cy, tile.rotation);
    minX = Math.min(minX, box.x0);
    minY = Math.min(minY, box.y0);
    maxX = Math.max(maxX, box.x1);
    maxY = Math.max(maxY, box.y1);
  }
  return { minX, minY, maxX, maxY };
}

/**
 * The whole table for one chain.
 *
 * Empty chain → empty layout (the board keeps its table-sized floor and shows the
 * "this opens the chain" copy). One tile → that tile alone, centred, horizontal.
 *
 * `limits` IS THE BOARD, AND IT IS OBEYED. The bounds are centred on the opening
 * tile — which is where the surface centres itself — so a chain that fits is a
 * chain the player can see. A plan that cannot be seated inside those bounds is
 * not a failure: the layout is retried WITHOUT them, so a table that genuinely
 * does not fit (a very small window, a pathological chain) still gets every tile
 * placed, and the board is simply allowed to scroll.
 */
export function layoutChain(
  chain: readonly ChainTileLike[] | null | undefined,
  {
    runCells = RUN_CELLS,
    limits = null,
  }: { runCells?: number; limits?: ChainLimits | null } = {},
): ChainLayout {
  const tiles = Array.isArray(chain) ? chain : [];
  if (tiles.length === 0) {
    return { tiles: [], minX: 0, minY: 0, maxX: 0, maxY: 0, cols: 0, rows: 0, pivot: -1 };
  }

  const pivot = pivotIndex(tiles);
  const pivotTile = tiles[pivot];
  const pivotDouble = isDoubleTile(pivotTile);
  const pivotRotation: TileRotation = pivotDouble ? 90 : 0;

  const rightwards: number[] = [];
  for (let index = pivot + 1; index < tiles.length; index += 1) rightwards.push(index);
  const leftwards: number[] = [];
  for (let index = pivot - 1; index >= 0; index -= 1) leftwards.push(index);

  // AN OPENING DOUBLE IS CROSSWISE, SO THE CHAIN LEAVES IT HORIZONTALLY. Its long
  // sides are its left and right edges, and the two arms attach to those: the run
  // runs ACROSS the double rather than in line with it, which is the whole point
  // of laying a double down. The tiles after it are therefore flat, not upright.
  const arms = pivotDouble
    ? [
        {
          order: leftwards,
          cursor: { x: -TILE_WIDTH_CELLS / 2, y: 0 },
          direction: "left" as LayoutDirection,
          mirrored: true,
        },
        {
          order: rightwards,
          cursor: { x: TILE_WIDTH_CELLS / 2, y: 0 },
          direction: "right" as LayoutDirection,
          mirrored: false,
        },
      ]
    : [
        {
          order: rightwards,
          cursor: { x: TILE_LENGTH_CELLS / 2, y: 0 },
          direction: "right" as LayoutDirection,
          mirrored: false,
        },
        {
          order: leftwards,
          cursor: { x: -TILE_LENGTH_CELLS / 2, y: 0 },
          direction: "left" as LayoutDirection,
          mirrored: true,
        },
      ];

  // INSIDE THE BOARD FIRST, AND ONLY INSIDE IT: a chain that fits must never be
  // drawn past the felt. The pass without limits is the fallback for a board too
  // small for the chain, where scrolling beats a tile that floats off the table.
  const limitSets: (ChainLimits | null)[] = limits ? [limits, null] : [null];
  let placed: (PlacedTile | undefined)[] | null = null;

  // THE BAND WIDTH A BOUNDED BOARD IS PACKED AT. A run allowed to go on for ever
  // only turns when it is blocked, which packs a tall felt beautifully and can box
  // itself in on a SHORT one — where the retry below gives the line a band it may
  // not exceed, so it turns at a predictable place and fills the rows it has.
  const packedRun = (board: ChainLimits) => {
    const bands = Math.max(1, Math.floor(board.rows / (TILE_WIDTH_CELLS * 2)));
    const chainCells = tiles.length * TILE_LENGTH_CELLS;
    return Math.max(4, Math.min(board.cols, Math.ceil(chainCells / bands) + 1));
  };

  for (const activeLimits of limitSets) {
    const runCaps: number[] = activeLimits
      ? [runCells, packedRun(activeLimits)].filter(
          (cap, index, all) => all.indexOf(cap) === index,
        )
      : [runCells];
    // A line with gaps breaks the run, so it is a last resort for an unbounded
    // table only: a bounded one takes the retry without limits instead.
    for (const activeRun of runCaps) {
    for (const allowGaps of activeLimits ? [false] : [false, true]) {
      for (const plan of PLANS) {
        const attempt: (PlacedTile | undefined)[] = new Array(tiles.length);
        const occupied: Rect[] = [footprint(0, 0, pivotRotation)];
        attempt[pivot] = {
          index: pivot,
          cx: 0,
          cy: 0,
          rotation: pivotRotation,
          direction: "right",
          isDouble: pivotDouble,
        };

        const ordered = plan.rightFirst ? [arms[0], arms[1]] : [arms[1], arms[0]];

        let connected = true;
        for (const arm of ordered) {
          const seated = walkSide({
            chain: tiles,
            order: arm.order,
            cursor: arm.cursor,
            direction: arm.direction,
            mirrored: arm.mirrored,
            placed: attempt,
            occupied,
            runCells: activeRun,
            limits: activeLimits,
            turnBias: plan.turnBias,
            allowGaps,
          });
          if (!seated) connected = false;
        }

        // With gaps allowed this pass always places something, so it is the plan
        // of last resort and is accepted even though it is not fully connected.
        if (connected || allowGaps) {
          placed = attempt;
          break;
        }
      }
      if (placed) break;
    }
    if (placed) break;
    }
    if (placed) break;
  }

  // Unreachable: the last pass always seats every tile. Kept so the type stays
  // narrow without a non-null assertion.
  const finalTiles = (placed ?? []).filter(Boolean) as PlacedTile[];
  const { minX, minY, maxX, maxY } = boundsOf(placed ?? []);

  return {
    tiles: finalTiles,
    minX,
    minY,
    maxX,
    maxY,
    cols: maxX - minX,
    rows: maxY - minY,
    pivot,
  };
}
