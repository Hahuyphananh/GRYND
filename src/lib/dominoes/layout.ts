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
 *     side, travelling the way the chain already was.
 *
 *   * THE LINE TURNS AT THE BOARD'S EDGE, IN SHELVES. A run that reaches the felt
 *     turns at right angles — its long side against the end tile's end edge,
 *     exactly how a player turns a line of dominoes on a real table — and the
 *     tile after the corner turns back to horizontal, so the table becomes a
 *     stack of shelves. The RIGHT arm shelves downward and the LEFT arm upward,
 *     so the two halves of the chain grow away from the opening tile and never
 *     into each other. With no board to fit into, a run still bends at
 *     `RUN_CELLS`, so a table can never become one endless row.
 *
 *   * THE TABLE IS STABLE. Every tile is seated from the tiles before it and
 *     nothing else: the walk is a single deterministic pass, with no whole-chain
 *     retry and no plan chosen from the chain's total length. A tile, once laid,
 *     keeps its square and its rotation as the chain grows — the table only ever
 *     gains tiles. (The two arms are walked in step, one ring at a time, so a play
 *     on either end is equally additive.)
 *
 *   * TILES NEVER OVERLAP AND NEVER FLOAT OFF. Every tile is checked against the
 *     tiles already placed; only a table with no room left at all falls back to a
 *     short break, so the board always shows where every tile went.
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
 * The caller sizes it from the felt it actually has; nothing here knows about
 * pixels. The opening tile is centred across it, and each arm shelves into its
 * own half of it, so the table is drawn where the player can see it.
 */
export type ChainLimits = {
  /** Cells across the board. */
  readonly cols: number;
  /** Cells down the board. */
  readonly rows: number;
};

/** Which way one arm's shelves run, away from the opening tile. */
type ShelfDirection = "down" | "up";

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

/** The felt one arm may use, in cells, measured from the opening tile. */
type Bounds = { minX: number; maxX: number; minY: number; maxY: number };

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

/** The state the walk carries from one tile to the next. */
type WalkState = {
  /** The edge the next tile attaches to. */
  point: Point;
  /** The way the line travels: horizontal on a shelf, vertical at a corner. */
  heading: LayoutDirection;
  /** The horizontal way the current shelf travels. */
  lane: LayoutDirection;
  /** Cells run along `lane` since this shelf began. */
  run: number;
  /** Which way this arm's shelves run, away from the opening tile. */
  shelf: ShelfDirection;
};

/** Is this heading straight up or down the felt? */
function isVertical(direction: LayoutDirection): boolean {
  return direction === "down" || direction === "up";
}

/** One way the next tile can leave the line. */
type Move = { heading: LayoutDirection; turned: boolean };

/**
 * The ways the next tile can leave the line, most wanted first.
 *
 * THE TILE AFTER A CORNER ALWAYS GOES BACK TO HORIZONTAL. A shelf is: across,
 * turn down at the edge, then straight back the other way — ONE corner, not two.
 * Left open, the line would take a second corner and staircase diagonally into
 * the corner of the felt, and once it had nowhere left to go the join would break.
 */
function movesFrom(state: WalkState): Move[] {
  if (isVertical(state.heading)) {
    const back = opposite(state.lane);
    return [
      { heading: back, turned: true },
      { heading: opposite(back), turned: true },
    ];
  }
  return [
    { heading: state.heading, turned: false },
    { heading: state.shelf, turned: true },
    { heading: opposite(state.heading), turned: true },
  ];
}

/**
 * Lay one tile: where it goes, how it is drawn, and the walk it hands on.
 *
 * A TURN HAPPENS AROUND THE CORNER. The turning tile is set half its own width
 * along the heading the line came in on, so its LONG side meets the end edge of
 * the tile it attaches to — the right-angled joint a real table makes — and it
 * advances by its own length into the new shelf. The shelf therefore sits two and
 * a half cells below the one before it (or above it, on the arm that shelves up),
 * which is the pitch that packs a table without ever overlapping it.
 *
 * A DOUBLE NEEDS NO SPECIAL CASE: it advances by its short side only, so the
 * point it hands on is the middle of its leading long side — exactly where the
 * next tile attaches.
 */
function layTile({
  state,
  heading,
  turned,
  isDouble,
  arm,
}: {
  state: WalkState;
  heading: LayoutDirection;
  turned: boolean;
  isDouble: boolean;
  arm: Arm;
}): Seated {
  const advance = isDouble ? TILE_WIDTH_CELLS : TILE_LENGTH_CELLS;
  const cornerShift = (isDouble ? TILE_LENGTH_CELLS : TILE_WIDTH_CELLS) / 2;
  const base = turned ? shift(state.point, state.heading, cornerShift) : state.point;
  const step = STEP[heading];
  const cx = base.x + (step.x * advance) / 2;
  const cy = base.y + (step.y * advance) / 2;
  const rotation = rotationFor(heading, isDouble, arm.mirrored);
  const horizontal = !isVertical(heading);
  return {
    cx,
    cy,
    rotation,
    direction: heading,
    box: footprint(cx, cy, rotation),
    gap: false,
    state: {
      point: shift(base, heading, advance),
      heading,
      lane: horizontal ? heading : state.lane,
      // A turn starts a fresh shelf; carrying straight on extends this one.
      run: horizontal && !turned ? state.run + advance : advance,
      shelf: state.shelf,
    },
  };
}

/** Is this box inside the felt the walk was given? */
function fitsInside(box: Rect, bounds: Bounds | null): boolean {
  if (!bounds) return true;
  const epsilon = 0.01;
  return (
    box.x0 >= bounds.minX - epsilon &&
    box.x1 <= bounds.maxX + epsilon &&
    box.y0 >= bounds.minY - epsilon &&
    box.y1 <= bounds.maxY + epsilon
  );
}

/**
 * The felt ONE ARM may use.
 *
 * The two arms leave the opening tile in opposite directions, so they shelf in
 * opposite directions too: the right arm stacks downwards from the pivot row and
 * the left arm upwards. Each gets HALF the felt's height and all of its width, so
 * the two together fill the felt instead of growing into each other.
 */
function boundsFor(limits: ChainLimits | null, shelf: ShelfDirection): Bounds | null {
  if (!limits) return null;
  // EACH ARM GETS HALF THE FELT'S HEIGHT: they shelf in opposite directions, so
  // halving the reach is what keeps their union inside the felt the board has.
  const reach = Math.max(TILE_LENGTH_CELLS, Math.floor(limits.rows / 2));
  return {
    minX: -limits.cols / 2,
    maxX: limits.cols / 2,
    minY: shelf === "down" ? -TILE_LENGTH_CELLS : -reach,
    maxY: shelf === "down" ? reach : TILE_LENGTH_CELLS,
  };
}

/** The felt a RUN may use: the same felt, with room at both ends to turn. */
function boundForRun(bounds: Bounds | null): Bounds | null {
  if (!bounds) return null;
  const reserve = TILE_LENGTH_CELLS - 0.5;
  return {
    minX: bounds.minX + reserve,
    maxX: bounds.maxX - reserve,
    minY: bounds.minY,
    maxY: bounds.maxY,
  };
}

/** One side of the chain: the tiles past the pivot, and the way it is walked. */
type Arm = {
  readonly order: readonly number[];
  readonly cursor: Point;
  readonly direction: LayoutDirection;
  /** True when this side is walked AGAINST the chain's array order. */
  readonly mirrored: boolean;
  readonly shelf: ShelfDirection;
  /** The felt this arm may use. */
  readonly bounds: Bounds | null;
  /** The felt a RUN may use: smaller, so its end always has room to turn. */
  readonly runBounds: Bounds | null;
};

/** A tile that has been seated, plus the state it hands to the next one. */
type Seated = {
  cx: number;
  cy: number;
  rotation: TileRotation;
  direction: LayoutDirection;
  box: Rect;
  state: WalkState;
  /** True when the line had to break to reach this tile (last resort only). */
  gap: boolean;
};

/**
 * The rendered rotation of a tile on this side, facing its chain neighbour.
 *
 * VALUES READ IN CHAIN ORDER. `chain[i].left` faces `chain[i-1]` and
 * `chain[i].right` faces `chain[i+1]`, and the array is spatially ordered — so a
 * tile is drawn with its OWN left half toward whichever screen side holds the
 * previous tile. The left arm is walked against that order, which flips the
 * direction its faces point in; the walk heading alone would print every tile on
 * that arm backwards and break the joins.
 */
function rotationFor(
  direction: LayoutDirection,
  isDouble: boolean,
  mirrored: boolean,
): TileRotation {
  const forward = mirrored ? opposite(direction) : direction;
  return ((ROTATION_OF[forward] + (isDouble ? 90 : 0)) % 360) as TileRotation;
}

/**
 * Seat one tile, or null when nothing at all fits.
 *
 * Candidates are tried in preference order — straight on, then the shelf's turn,
 * then the other corner, then back — and the first one that neither overlaps a
 * tile already on the table nor leaves the felt wins. That is the whole decision:
 * it reads the tiles before it and nothing else, which is what keeps the table
 * stable while the chain grows.
 */
function seatTile({
  chain,
  index,
  state,
  occupied,
  runCells,
  arm,
}: {
  chain: readonly ChainTileLike[];
  index: number;
  state: WalkState;
  occupied: readonly Rect[];
  runCells: number;
  arm: Arm;
}): Seated | null {
  const isDouble = isDoubleTile(chain[index]);
  const advance = isDouble ? TILE_WIDTH_CELLS : TILE_LENGTH_CELLS;
  for (const move of movesFrom(state)) {
    const straight = !move.turned;
    // A run never fills its whole band: it stops a tile short of the end, so the
    // corner it turns into always has room to be laid.
    if (straight && state.run + advance > runCells) continue;
    const seat = layTile({ state, heading: move.heading, turned: move.turned, isDouble, arm });
    // A tile carrying the run on stops short of the edge; a tile turning into a
    // new shelf may use the whole felt.
    const bound = straight ? arm.runBounds : arm.bounds;
    if (!fitsInside(seat.box, bound)) continue;
    if (occupied.some((taken) => overlaps(seat.box, taken))) continue;
    return seat;
  }
  return null;
}

/**
 * The last resort: a tile that could not be seated anywhere gets a short break
 * from the line, so the table still shows where it went. A broken line is a
 * visible imperfection; a dropped tile is a wrong position, and this module never
 * produces one. (A double-six chain seats every tile contiguously, so this is
 * only reached by a felt far too small for the chain it is given.)
 */
function seatWithGap({
  chain,
  index,
  state,
  occupied,
  runCells,
  arm,
}: {
  chain: readonly ChainTileLike[];
  index: number;
  state: WalkState;
  occupied: readonly Rect[];
  runCells: number;
  arm: Arm;
}): Seated | null {
  const isDouble = isDoubleTile(chain[index]);
  const advance = isDouble ? TILE_WIDTH_CELLS : TILE_LENGTH_CELLS;
  // Walking outward from the end of the line, in every direction it can leave
  // from — the shelf's turn first, so the break is as short as possible.
  for (const move of movesFrom(state)) {
    const step = STEP[move.heading];
    for (let gap = 0.5; gap <= TILE_LENGTH_CELLS * 10; gap += 0.5) {
      const from = {
        x: state.point.x + step.x * gap,
        y: state.point.y + step.y * gap,
      };
      const cx = from.x + (step.x * advance) / 2;
      const cy = from.y + (step.y * advance) / 2;
      const rotation = rotationFor(move.heading, isDouble, arm.mirrored);
      const box = footprint(cx, cy, rotation);
      if (!fitsInside(box, arm.bounds)) continue;
      if (occupied.some((taken) => overlaps(box, taken))) continue;
      const vertical = isVertical(move.heading);
      return {
        cx,
        cy,
        rotation,
        direction: move.heading,
        box,
        gap: true,
        state: {
          point: { x: from.x + step.x * advance, y: from.y + step.y * advance },
          heading: move.heading,
          lane: vertical ? state.lane : move.heading,
          run: vertical ? 0 : advance,
          shelf: state.shelf,
        },
      };
    }
  }

  // AND IF THE LINE CANNOT LEAVE AT ALL — a felt packed so tightly that every
  // direction runs off it — the first free square will do. Candidates are tried
  // in a fixed order, so the answer is still deterministic.
  if (!arm.bounds) return null;
  for (let cy = arm.bounds.minY + 0.5; cy <= arm.bounds.maxY - 0.5; cy += 0.5) {
    for (let cx = arm.bounds.minX + 0.5; cx <= arm.bounds.maxX - 0.5; cx += 0.5) {
      for (const rotation of [isDouble ? 90 : 0, isDouble ? 0 : 90] as TileRotation[]) {
        const box = footprint(cx, cy, rotation);
        if (!fitsInside(box, arm.bounds)) continue;
        if (occupied.some((taken) => overlaps(box, taken))) continue;
        return { cx, cy, rotation, direction: "right", box, state, gap: true };
      }
    }
  }
  return null;
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
 * Walk both arms of the chain, one ring at a time.
 *
 * THE ARMS ARE INTERLEAVED BY DISTANCE FROM THE PIVOT, and that is not a
 * detail — it is what makes the table additive. Each arm's tile at distance `d`
 * is decided from the tiles at distances `< d` (and the pivot), on either side,
 * so growing the chain at one end appends work after what is already laid and
 * can never revise it. Laying one arm fully and then the other would let a new
 * tile on the second arm shove the first one around.
 */
function layoutTable({
  chain,
  pivot,
  arms,
  runCells,
}: {
  chain: readonly ChainTileLike[];
  pivot: number;
  arms: readonly Arm[];
  runCells: number;
}): { placed: (PlacedTile | undefined)[] } {
  const placed: (PlacedTile | undefined)[] = new Array(chain.length);
  const pivotDouble = isDoubleTile(chain[pivot]);
  const pivotRotation: TileRotation = pivotDouble ? 90 : 0;
  placed[pivot] = {
    index: pivot,
    cx: 0,
    cy: 0,
    rotation: pivotRotation,
    direction: "right",
    isDouble: pivotDouble,
  };
  const occupied: Rect[] = [footprint(0, 0, pivotRotation)];

  const states: WalkState[] = arms.map((arm) => ({
    point: { ...arm.cursor },
    heading: arm.direction,
    lane: arm.direction,
    run: 0,
    shelf: arm.shelf,
  }));

  const furthest = arms.reduce((max, arm) => Math.max(max, arm.order.length), 0);

  for (let distance = 0; distance < furthest; distance += 1) {
    for (let armIndex = 0; armIndex < arms.length; armIndex += 1) {
      const arm = arms[armIndex];
      const index = arm.order[distance];
      if (index === undefined) continue;

      const shared = {
        chain,
        index,
        state: states[armIndex],
        occupied,
        runCells,
        arm,
      };
      const seat = seatTile(shared) ?? seatWithGap(shared);
      // Unreachable for any real felt: the free-square pass always finds a spot
      // once the arm has one. A tile with nowhere at all to go is simply not
      // drawn rather than drawn on top of another.
      if (!seat) continue;

      placed[index] = {
        index,
        cx: seat.cx,
        cy: seat.cy,
        rotation: seat.rotation,
        direction: seat.direction,
        isDouble: isDoubleTile(chain[index]),
      };
      occupied.push(seat.box);
      states[armIndex] = seat.state;
    }
  }

  return { placed };
}

/**
 * The whole table for one chain.
 *
 * Empty chain → empty layout (the board keeps its table-sized floor and shows the
 * "this opens the chain" copy). One tile → that tile alone, centred, horizontal.
 * An opening double → crosswise, and the two arms leave its long sides.
 *
 * `limits` IS THE BOARD, AND IT IS OBEYED. The felt is measured from the board it
 * is drawn on, so a chain that fits is a chain the player can see; a tile that
 * would grow the table past that felt is turned at right angles into a new shelf
 * instead. Only a chain that genuinely cannot be seated inside the felt (a very
 * small window, a pathological projection) falls back to an unbounded table,
 * which the board is allowed to scroll.
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
  const pivotDouble = isDoubleTile(tiles[pivot]);

  // AN OPENING DOUBLE IS CROSSWISE, SO THE CHAIN LEAVES IT HORIZONTALLY. Its long
  // sides are its left and right edges, and the two arms attach to those: the run
  // runs ACROSS the double rather than in line with it, which is the whole point
  // of laying a double down.
  const cursor = pivotDouble ? TILE_WIDTH_CELLS / 2 : TILE_LENGTH_CELLS / 2;

  /**
   * One arm, with the felt it may use.
   *
   * THE CORNER IS PAID FOR UP FRONT. A tile laid at right angles sits half a tile
   * PAST the end of the run, its long side against the run's end edge, so a run
   * keeps a cell and a half of felt in hand for that. The run therefore always has
   * the room to turn, and the table is never snapped off at the edge to fit.
   */
  const armFor = ({
    order,
    cursorPoint,
    direction,
    mirrored,
    shelf,
  }: {
    order: number[];
    cursorPoint: Point;
    direction: LayoutDirection;
    mirrored: boolean;
    shelf: ShelfDirection;
  }): Arm => {
    const bounds = boundsFor(limits, shelf);
    return {
      order,
      cursor: cursorPoint,
      direction,
      mirrored,
      shelf,
      bounds,
      // THE RESERVE IS HORIZONTAL ONLY. A run travels horizontally, and the
      // corner it turns into sits half a tile past its end — so the run keeps a
      // cell and a half in hand at either END of the band. Its row needs no
      // reserve: that is what `bounds` already gives it.
      runBounds: boundForRun(bounds),
    };
  };

  const arms: Arm[] = [
    armFor({
      order: rightwardsOf(tiles, pivot),
      cursorPoint: { x: cursor, y: 0 },
      direction: "right",
      mirrored: false,
      // …downwards, away from the opening tile.
      shelf: "down",
    }),
    armFor({
      order: leftwardsOf(tiles, pivot),
      cursorPoint: { x: -cursor, y: 0 },
      direction: "left",
      mirrored: true,
      // …upwards, so the two halves of the chain grow apart.
      shelf: "up",
    }),
  ];

  let { placed } = layoutTable({ chain: tiles, pivot, arms, runCells });

  // A bounded pass only counts when the table it produced really fits the felt;
  // otherwise the same chain is laid out unbounded, so no tile is ever missing.
  if (limits && overflowsFelt(placed, limits)) {
    const freeArms = arms.map((arm) => ({ ...arm, bounds: null, runBounds: null }));
    ({ placed } = layoutTable({ chain: tiles, pivot, arms: freeArms, runCells }));
  }

  const finalTiles = placed.filter(Boolean) as PlacedTile[];
  const { minX, minY, maxX, maxY } = boundsOf(placed);

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

/** Does the table this pass produced stick out past the felt it was given? */
function overflowsFelt(
  placed: readonly (PlacedTile | undefined)[],
  limits: ChainLimits,
): boolean {
  const { minX, minY, maxX, maxY } = boundsOf(placed);
  const epsilon = 0.01;
  // Measured as a SIZE, not against a fixed origin: the opening tile is not the
  // centre of the table once one arm has shelved further than the other.
  return (
    maxX - minX > limits.cols + epsilon || maxY - minY > limits.rows + epsilon
  );
}

/** The indices after the pivot, nearest first. */
function rightwardsOf(chain: readonly ChainTileLike[], pivot: number): number[] {
  const order: number[] = [];
  for (let index = pivot + 1; index < chain.length; index += 1) order.push(index);
  return order;
}

/** The indices before the pivot, nearest first (the arm is walked against the array). */
function leftwardsOf(chain: readonly ChainTileLike[], pivot: number): number[] {
  const order: number[] = [];
  for (let index = pivot - 1; index >= 0; index -= 1) order.push(index);
  return order;
}
