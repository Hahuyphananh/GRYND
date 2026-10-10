/**
 * Barricade — the PURE rules engine. No React, no HTTP, no DB, no browser APIs,
 * no randomness: the same input state always produces the same output, which is
 * what lets the board UI, the AI and the server all share it.
 *
 * This module is the ONLY place the rules exist. The server store validates
 * human and bot turns through `validateAction`, both seats' options come from
 * `legalActions`, and the board renders whatever `applyAction` returns —
 * nothing re-derives a legal move, a wall conflict or a winner anywhere else.
 *
 * THE RULES, AND WHERE THEY COME FROM
 *
 *   1. Setup — 9×9 board; each pawn starts on the centre square of its own
 *      baseline; 10 barricades each. (barricade.gg/rules; Quoridor rulebook)
 *   2. Turn — exactly one action: move the pawn one square, or place one
 *      barricade. You may not pass, and once your stock is empty you must move.
 *   3. Movement — one square up, down, left or right (forwards or backwards),
 *      never diagonally; a barricade or the board edge blocks it.
 *   4. Jumps — with the pawns face to face across an open groove, the player may
 *      jump straight over the opponent when the square beyond is free. If a
 *      barricade or the board edge sits directly behind the opponent, the pawn
 *      may instead move diagonally to one of the two squares beside them —
 *      provided that lateral route is itself open ("walls may not be jumped").
 *      A barricade BETWEEN the pawns cancels every jump (Quoridor: the pawns
 *      must face each other "not separated by a fence").
 *   5. Barricades — two squares long, laid in the groove between squares,
 *      horizontal or vertical; they block both players; they may not overlap or
 *      cross; and a placement may never remove the last route from EITHER pawn
 *      to its own goal baseline.
 *   6. Victory — the first pawn to reach any square of the opposite baseline
 *      wins immediately, and a finished match accepts no further action.
 *
 * See docs/GAME_BARRICADE.md for the two places barricade.gg's published rules
 * are silent and the original Quoridor rulebook was used to decide them.
 *
 * COST: `legalWalls` runs one breadth-first search per candidate barricade
 * (≤128 × 2 pawns over 81 squares), i.e. the whole turn menu is a few thousand
 * integer operations — cheap enough to compute on every render, and cheap
 * enough for the AI to call inside a search.
 */

import {
  ACTION_TYPES,
  BOARD_SIZE,
  CENTRE_COLUMN,
  FIRST_SEAT,
  MATCH_STATUS,
  MOVE_KINDS,
  ORIENTATIONS,
  REJECTION,
  SEATS,
  WALL_SLOTS,
  WALLS_PER_PLAYER,
  WIN_REASON,
} from "./constants";
import type {
  ActionRecord,
  ActionValidation,
  BarricadeAction,
  BarricadeState,
  LegalAction,
  LegalMoveAction,
  MoveKind,
  PawnMoveVerdict,
  PlacedWall,
  Position,
  RejectionCode,
  Seat,
  WallAction,
  WallPlacement,
  WallVerdict,
  WallsConflict,
} from "./types";

/** The four orthogonal unit steps, in a fixed order so output is deterministic. */
const STEP_DIRECTIONS: readonly Position[] = Object.freeze([
  Object.freeze({ col: 0, row: 1 }), // up (player1's direction of travel)
  Object.freeze({ col: 0, row: -1 }), // down
  Object.freeze({ col: -1, row: 0 }), // left
  Object.freeze({ col: 1, row: 0 }), // right
]);

/**
 * The two ways around the opponent: the unit steps at right angles to the
 * direction of travel. Rotating the direction is what keeps this correct for
 * jumps along EITHER axis — a fixed pair of vectors is only perpendicular to a
 * vertical jump, and on a horizontal one would resolve to the straight-jump
 * square and the pawn's own square (which is how "move diagonally" once offered
 * a pawn the square it was standing on).
 */
function perpendicularsFor(direction: Position): readonly [Position, Position] {
  return [
    { col: -direction.row, row: direction.col }, // left of the travel axis
    { col: direction.row, row: -direction.col }, // right of it
  ];
}

/* -------------------------------------------------------------------------- *
 * Seats, baselines and goals
 * -------------------------------------------------------------------------- */

/** `true` when `value` is one of the two seats. */
export function isSeat(value: unknown): value is Seat {
  return value === SEATS[0] || value === SEATS[1];
}

/** The other player. */
export function otherSeat(seat: Seat): Seat {
  return seat === SEATS[0] ? SEATS[1] : SEATS[0];
}

/** The row a seat's pawn starts on and must never be pushed back past. */
export function baselineRowFor(seat: Seat): number {
  return seat === FIRST_SEAT ? 0 : BOARD_SIZE - 1;
}

/** The row that wins the game for a seat — the far side of the board. */
export function goalRowFor(seat: Seat): number {
  return seat === FIRST_SEAT ? BOARD_SIZE - 1 : 0;
}

/** The centre square of a seat's own baseline ("middle square of their back row"). */
export function startPositionFor(seat: Seat): Position {
  return Object.freeze({ col: CENTRE_COLUMN, row: baselineRowFor(seat) });
}

/** A seat wins by landing anywhere on this row, not just its centre. */
export function isGoalPositionFor(seat: Seat, position: Position): boolean {
  return position.row === goalRowFor(seat);
}

/* -------------------------------------------------------------------------- *
 * Coordinates, guards and keys
 * -------------------------------------------------------------------------- */

/** `true` for integer numbers. */
export function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/** `true` for an integer column/row inside the board. */
export function isValidCoordinate(value: unknown): boolean {
  return isInteger(value) && value >= 0 && value < BOARD_SIZE;
}

/** `true` for an integer slot coordinate inside the groove grid. */
export function isValidSlotCoordinate(value: unknown): boolean {
  return isInteger(value) && value >= 0 && value < WALL_SLOTS;
}

/** Structural guard for a board square. */
export function isValidPosition(value: unknown): value is Position {
  const candidate = value as { col?: unknown; row?: unknown } | null | undefined;
  if (!candidate || typeof candidate !== "object") return false;
  return isValidCoordinate(candidate.col) && isValidCoordinate(candidate.row);
}

/** Structural guard for an orientation. */
export function isValidOrientation(value: unknown): value is WallPlacement["orientation"] {
  return value === ORIENTATIONS[0] || value === ORIENTATIONS[1];
}

/** Structural guard for a barricade placement (slot + orientation). */
export function isValidWall(value: unknown): value is WallPlacement {
  const candidate = value as Partial<WallPlacement> | null | undefined;
  if (!candidate || typeof candidate !== "object") return false;
  return (
    isValidSlotCoordinate(candidate.col) &&
    isValidSlotCoordinate(candidate.row) &&
    isValidOrientation(candidate.orientation)
  );
}

/** Stable key for a square (`"4,0"`) — used for maps, sets and log lines. */
export function positionKey(position: Position): string {
  return `${position.col},${position.row}`;
}

/** Stable key for a barricade (`"horizontal:3,0"`). */
export function wallKey(wall: WallPlacement): string {
  return `${wall.orientation}:${wall.col},${wall.row}`;
}

/** Square equality. */
export function positionsEqual(a: Position, b: Position): boolean {
  return a.col === b.col && a.row === b.row;
}

/* -------------------------------------------------------------------------- *
 * Barricade geometry
 * -------------------------------------------------------------------------- */

/**
 * How two barricades relate. A barricade is a domino, and the only way two of
 * them can touch illegally is sharing the same slot: same orientation overlaps
 * the identical groove, the other orientation crosses. Meeting at a single
 * point (different slots) is legal in the physical game.
 */
export function wallsConflict(a: WallPlacement, b: WallPlacement): WallsConflict {
  if (a.col !== b.col || a.row !== b.row) return null;
  return a.orientation === b.orientation ? "overlap" : "crossing";
}

/** The first conflict `wall` has with the barricades already on the board. */
export function findWallConflict(
  walls: readonly WallPlacement[],
  wall: WallPlacement,
): WallsConflict {
  for (const placed of walls) {
    const conflict = wallsConflict(placed, wall);
    if (conflict) return conflict;
  }
  return null;
}

/**
 * Does `wall` lie across the step `from` → `to`? Answers for orthogonal
 * neighbours only; that is all a pawn ever does.
 *
 * A horizontal barricade on slot `(col, row)` blocks the boundary between rows
 * `row` and `row + 1` for columns `col` and `col + 1`; a vertical one blocks the
 * boundary between columns `col` and `col + 1` for rows `row` and `row + 1`.
 */
export function wallBlocksStep(wall: WallPlacement, from: Position, to: Position): boolean {
  const deltaCol = to.col - from.col;
  const deltaRow = to.row - from.row;
  if (wall.orientation === ORIENTATIONS[0]) {
    if (deltaCol !== 0 || Math.abs(deltaRow) !== 1) return false;
    const boundary = Math.min(from.row, to.row);
    return wall.row === boundary && (wall.col === from.col || wall.col === from.col - 1);
  }
  if (deltaRow !== 0 || Math.abs(deltaCol) !== 1) return false;
  const boundary = Math.min(from.col, to.col);
  return wall.col === boundary && (wall.row === from.row || wall.row === from.row - 1);
}

/** The barricade (owner included) lying across a step, or null. */
export function findBlockingWall<T extends WallPlacement>(
  walls: readonly T[],
  from: Position,
  to: Position,
): T | null {
  for (const wall of walls) {
    if (wallBlocksStep(wall, from, to)) return wall;
  }
  return null;
}

/** Is any barricade lying across the step `from` → `to`? */
export function isStepBlocked(
  walls: readonly WallPlacement[],
  from: Position,
  to: Position,
): boolean {
  return findBlockingWall(walls, from, to) !== null;
}

/**
 * Fast groove lookup — the barricades on a board compiled into a hash set of
 * occupied boundary segments. Internally the hot loops (pathfinding, wall
 * search) use this instead of rescanning the wall list at every step; the two
 * answers are asserted equal, exhaustively, in the test suite.
 */
function buildGrooveIndex(walls: readonly WallPlacement[]): Set<string> {
  const index = new Set<string>();
  for (const wall of walls) {
    index.add(`${wall.orientation === ORIENTATIONS[0] ? "h" : "v"}:${wall.col},${wall.row}`);
  }
  return index;
}

/** The index-based twin of `isStepBlocked`, for a step between neighbours. */
function stepBlockedByIndex(index: ReadonlySet<string>, from: Position, to: Position): boolean {
  const deltaRow = to.row - from.row;
  if (deltaRow !== 0) {
    const boundary = Math.min(from.row, to.row);
    return index.has(`h:${from.col},${boundary}`) || index.has(`h:${from.col - 1},${boundary}`);
  }
  const boundary = Math.min(from.col, to.col);
  return index.has(`v:${boundary},${from.row}`) || index.has(`v:${boundary},${from.row - 1}`);
}

/* -------------------------------------------------------------------------- *
 * Pathfinding
 * -------------------------------------------------------------------------- */

/**
 * Breadth-first shortest walk from `from` to any square of `goalRow`, or
 * `Infinity` when the barricades have cut it off. Pawns are ignored on purpose:
 * the rule the game enforces is that a BARRIER may not seal a route, and the
 * opponent's pawn is never a permanent obstruction.
 */
function shortestWalkToRow(
  index: ReadonlySet<string>,
  from: Position,
  goalRow: number,
): number {
  if (from.row === goalRow) return 0;
  const seen = new Set<string>([positionKey(from)]);
  let frontier: Position[] = [from];
  let distance = 0;
  while (frontier.length > 0) {
    distance += 1;
    const next: Position[] = [];
    for (const cell of frontier) {
      for (const direction of STEP_DIRECTIONS) {
        const to = { col: cell.col + direction.col, row: cell.row + direction.row };
        if (!isValidPosition(to)) continue;
        if (stepBlockedByIndex(index, cell, to)) continue;
        const key = positionKey(to);
        if (seen.has(key)) continue;
        if (to.row === goalRow) return distance;
        seen.add(key);
        next.push(to);
      }
    }
    frontier = next;
  }
  return Number.POSITIVE_INFINITY;
}

/** Shortest number of pawn steps `seat` needs to reach its goal row. */
export function distanceToGoal(state: BarricadeState, seat: Seat): number {
  return shortestWalkToRow(buildGrooveIndex(state.walls), state.pawns[seat], goalRowFor(seat));
}

/** Does `seat` still have at least one route to its goal baseline? */
export function hasPathToGoal(state: BarricadeState, seat: Seat): boolean {
  return Number.isFinite(distanceToGoal(state, seat));
}

/**
 * Would dropping `wall` on the board seal EITHER pawn's last route? This is the
 * rule that makes Barricade fair — you may block, you may never imprison.
 */
export function wallSealsAPath(state: BarricadeState, wall: WallPlacement): boolean {
  const index = buildGrooveIndex([...state.walls, wall]);
  for (const seat of SEATS) {
    if (!Number.isFinite(shortestWalkToRow(index, state.pawns[seat], goalRowFor(seat)))) {
      return true;
    }
  }
  return false;
}

/* -------------------------------------------------------------------------- *
 * Pawn movement — one generator, two views
 * -------------------------------------------------------------------------- */

/**
 * Every square this seat's pawn can geometrically reach next, mapped to the
 * verdict for that square (`ok` when it is a legal move, otherwise why not).
 *
 * This is the canonical implementation of movement, jumps included. Legal-move
 * generation filters it for the `ok` entries; action validation looks the
 * requested square up in it. There is deliberately no second copy of the jump
 * rules anywhere in the app.
 */
function pawnMoveCandidates(
  state: BarricadeState,
  seat: Seat,
): Map<string, { position: Position; verdict: PawnMoveVerdict }> {
  const from = state.pawns[seat];
  const opponent = state.pawns[otherSeat(seat)];
  const index = buildGrooveIndex(state.walls);
  const opponentKey = positionKey(opponent);
  const candidates = new Map<string, { position: Position; verdict: PawnMoveVerdict }>();

  const offer = (position: Position, verdict: PawnMoveVerdict): void => {
    const key = positionKey(position);
    if (!candidates.has(key)) candidates.set(key, { position, verdict });
  };
  const blocked = (message: string): PawnMoveVerdict => ({
    ok: false,
    code: REJECTION.MOVE_BLOCKED_BY_WALL,
    message,
  });
  const separated: PawnMoveVerdict = {
    ok: false,
    code: REJECTION.JUMP_NOT_AVAILABLE,
    message: "a barricade separates you from your opponent — you may not jump over one",
  };

  for (const direction of STEP_DIRECTIONS) {
    const neighbour = { col: from.col + direction.col, row: from.row + direction.row };
    if (!isValidPosition(neighbour)) continue;
    const neighbourIsOpponent = positionKey(neighbour) === opponentKey;

    if (stepBlockedByIndex(index, from, neighbour)) {
      if (neighbourIsOpponent) {
        // Face to face across a barricade: neither the step, the jump nor the
        // way around the opponent is available (the Quoridor "not separated by
        // a fence" precondition).
        offer(neighbour, blocked("a barricade separates you from your opponent"));
        offer(
          { col: neighbour.col + direction.col, row: neighbour.row + direction.row },
          separated,
        );
        for (const perpendicular of perpendicularsFor(direction)) {
          offer(
            { col: neighbour.col + perpendicular.col, row: neighbour.row + perpendicular.row },
            separated,
          );
        }
      } else {
        offer(neighbour, blocked("a barricade blocks that square"));
      }
      continue;
    }

    if (!neighbourIsOpponent) {
      offer(neighbour, { ok: true, kind: MOVE_KINDS.STEP });
      continue;
    }

    // Face to face across an open groove — `beyond` is the straight-jump square.
    const beyond = { col: neighbour.col + direction.col, row: neighbour.row + direction.row };
    const beyondInBounds = isValidPosition(beyond);
    const beyondOpen = beyondInBounds && !stepBlockedByIndex(index, neighbour, beyond);
    if (beyondOpen) {
      offer(beyond, { ok: true, kind: MOVE_KINDS.JUMP_STRAIGHT });
    } else if (beyondInBounds) {
      offer(beyond, blocked("a barricade blocks the square behind your opponent"));
    }

    for (const perpendicular of perpendicularsFor(direction)) {
      const side = { col: from.col + perpendicular.col, row: from.row + perpendicular.row };
      const diagonal = {
        col: neighbour.col + perpendicular.col,
        row: neighbour.row + perpendicular.row,
      };
      if (!isValidPosition(diagonal)) continue;
      if (beyondOpen) {
        // The straight jump is available, so the diagonal is not: barricade.gg —
        // "If there's a barricade (or the board edge) directly behind your
        // opponent… instead you move diagonally".
        offer(diagonal, {
          ok: false,
          code: REJECTION.JUMP_NOT_AVAILABLE,
          message: "you may only move diagonally when the square behind your opponent is blocked",
        });
        continue;
      }
      if (!isValidPosition(side)) {
        offer(diagonal, blocked("a barricade blocks the way around your opponent"));
        continue;
      }
      if (stepBlockedByIndex(index, from, side)) {
        offer(diagonal, blocked("a barricade blocks the way around your opponent"));
        continue;
      }
      if (stepBlockedByIndex(index, side, diagonal)) {
        offer(diagonal, blocked("a barricade blocks the way around your opponent"));
        continue;
      }
      offer(diagonal, { ok: true, kind: MOVE_KINDS.JUMP_DIAGONAL });
    }
  }

  return candidates;
}

/**
 * Why a specific destination is or is not legal for this seat's pawn — the
 * engine's answer to "why can't I go there?", safe to surface in the UI.
 *
 * The opponent's own square is reported as `destination-occupied` before any
 * barricade explanation: pawns never share a square, whatever the walls say.
 */
export function classifyPawnMove(state: BarricadeState, seat: Seat, to: Position): PawnMoveVerdict {
  if (!isValidPosition(to)) {
    return {
      ok: false,
      code: REJECTION.OUT_OF_BOUNDS,
      message: "that square is off the board",
    };
  }
  const from = state.pawns[seat];
  if (positionsEqual(from, to)) {
    return {
      ok: false,
      code: REJECTION.MOVE_NOT_ADJACENT,
      message: "your pawn is already there",
    };
  }
  if (positionsEqual(state.pawns[otherSeat(seat)], to)) {
    return {
      ok: false,
      code: REJECTION.DESTINATION_OCCUPIED,
      message: "your opponent's pawn is there — you must jump over it, not onto it",
    };
  }
  const candidate = pawnMoveCandidates(state, seat).get(positionKey(to));
  if (!candidate) {
    return {
      ok: false,
      code: REJECTION.MOVE_NOT_ADJACENT,
      message: "a pawn moves one square, or jumps over the opponent when face to face",
    };
  }
  return candidate.verdict;
}

/**
 * Every legal pawn move for `seat`, in deterministic order. Empty once the
 * match is over — a finished board offers nothing to a human, a bot or a test.
 */
export function legalMoves(state: BarricadeState, seat: Seat = state.turn): LegalMoveAction[] {
  if (state.status !== MATCH_STATUS.PLAYING) return [];
  const actions: LegalMoveAction[] = [];
  for (const candidate of pawnMoveCandidates(state, seat).values()) {
    if (!candidate.verdict.ok) continue;
    actions.push(
      Object.freeze({
        type: ACTION_TYPES.MOVE,
        to: Object.freeze({ col: candidate.position.col, row: candidate.position.row }),
        kind: candidate.verdict.kind,
      }),
    );
  }
  return actions;
}

/* -------------------------------------------------------------------------- *
 * Barricades
 * -------------------------------------------------------------------------- */

/**
 * Why a specific barricade is or is not legal, in rule order: affordable, free
 * slot, path-preserving.
 */
export function classifyWall(state: BarricadeState, seat: Seat, wall: WallPlacement): WallVerdict {
  const candidate = wall as Partial<WallPlacement> | null | undefined;
  if (!candidate || typeof candidate !== "object" || !isInteger(candidate.col) || !isInteger(candidate.row)) {
    return {
      ok: false,
      code: REJECTION.OUT_OF_BOUNDS,
      message: "a barricade is addressed by the groove it sits in",
    };
  }
  if (!isValidSlotCoordinate(candidate.col) || !isValidSlotCoordinate(candidate.row)) {
    return {
      ok: false,
      code: REJECTION.OUT_OF_BOUNDS,
      message: `a barricade sits between squares: col and row must be 0…${WALL_SLOTS - 1}`,
    };
  }
  if (!isValidOrientation(candidate.orientation)) {
    return {
      ok: false,
      code: REJECTION.INVALID_ORIENTATION,
      message: 'a barricade is either "horizontal" or "vertical"',
    };
  }
  if (state.wallsRemaining[seat] <= 0) {
    return {
      ok: false,
      code: REJECTION.NO_WALLS_REMAINING,
      message: "you have no barricades left — you must move your pawn",
    };
  }
  const conflict = findWallConflict(state.walls, candidate as WallPlacement);
  if (conflict === "overlap") {
    return {
      ok: false,
      code: REJECTION.WALL_OVERLAP,
      message: "a barricade already occupies that groove",
    };
  }
  if (conflict === "crossing") {
    return {
      ok: false,
      code: REJECTION.WALL_CROSSING,
      message: "that barricade would cross one already on the board",
    };
  }
  if (wallSealsAPath(state, candidate as WallPlacement)) {
    return {
      ok: false,
      code: REJECTION.WALL_BLOCKS_PATH,
      message: "both players must keep a route to their goal — that barricade seals one off",
    };
  }
  return { ok: true, kind: ACTION_TYPES.WALL };
}

/**
 * Every legal barricade placement for `seat`, in deterministic order. Empty
 * once the match is over, or when the seat has spent its reserve.
 */
export function legalWalls(state: BarricadeState, seat: Seat = state.turn): WallAction[] {
  if (state.status !== MATCH_STATUS.PLAYING) return [];
  if (state.wallsRemaining[seat] <= 0) return [];
  const occupiedSlots = new Set(state.walls.map((wall) => `${wall.col},${wall.row}`));
  const actions: WallAction[] = [];
  for (const orientation of ORIENTATIONS) {
    for (let row = 0; row < WALL_SLOTS; row += 1) {
      for (let col = 0; col < WALL_SLOTS; col += 1) {
        // A slot holds at most one barricade, whatever the orientation.
        if (occupiedSlots.has(`${col},${row}`)) continue;
        const wall: WallPlacement = { col, row, orientation };
        if (wallSealsAPath(state, wall)) continue;
        actions.push(
          Object.freeze({ type: ACTION_TYPES.WALL, wall: Object.freeze({ ...wall }) }),
        );
      }
    }
  }
  return actions;
}

/* -------------------------------------------------------------------------- *
 * The canonical action menu
 * -------------------------------------------------------------------------- */

/**
 * Everything the seat on turn may legally do this turn, moves first then
 * barricades. An empty list means the match is over.
 *
 * Human clicks, bot search and the store's turn validation all read this one
 * function — there is no second generator to drift out of sync.
 */
export function legalActions(state: BarricadeState): LegalAction[] {
  if (state.status !== MATCH_STATUS.PLAYING) return [];
  return [...legalMoves(state), ...legalWalls(state)];
}

/** Has the match stopped accepting actions? */
export function isMatchFinished(state: BarricadeState): boolean {
  return state.status !== MATCH_STATUS.PLAYING;
}

/* -------------------------------------------------------------------------- *
 * Validation and application
 * -------------------------------------------------------------------------- */

/**
 * Can `seat` play `action` right now? Rejections are returned, not thrown, so
 * the API route can map `code` straight onto a 400 body.
 *
 * Order matters and is part of the contract: the SHAPE of the action is checked
 * first (a malformed turn is nonsense whichever match it targets), then the
 * lifecycle (a finished match accepts nothing), then turn ownership — checked
 * before any rule so a seat can never probe the board out of turn — and only
 * then the rule itself.
 */
export function validateAction(
  state: BarricadeState,
  seat: Seat,
  action: BarricadeAction,
): ActionValidation {
  // The turn arrives from a client, a bot or a socket, so it is inspected as
  // loose data first: the declared types only describe what a good caller sends.
  const candidate = action as
    | { type?: unknown; to?: unknown; wall?: unknown; kind?: unknown }
    | null
    | undefined;
  if (!candidate || typeof candidate !== "object" || !isSeat(seat)) {
    return {
      ok: false,
      code: REJECTION.INVALID_ACTION,
      message: "a turn is either a pawn move or a barricade placement",
    };
  }
  if (candidate.type !== ACTION_TYPES.MOVE && candidate.type !== ACTION_TYPES.WALL) {
    return {
      ok: false,
      code: REJECTION.INVALID_ACTION,
      message: 'a turn is either of type "move" or of type "wall"',
    };
  }
  if (candidate.type === ACTION_TYPES.MOVE && !candidate.to) {
    return {
      ok: false,
      code: REJECTION.INVALID_ACTION,
      message: "a pawn move needs a destination",
    };
  }
  if (candidate.type === ACTION_TYPES.WALL && !candidate.wall) {
    return {
      ok: false,
      code: REJECTION.INVALID_ACTION,
      message: "a barricade needs a placement",
    };
  }

  if (state.status !== MATCH_STATUS.PLAYING) {
    return {
      ok: false,
      code: REJECTION.MATCH_NOT_PLAYING,
      message: "the match is over — no further moves are accepted",
    };
  }
  if (seat !== state.turn) {
    return { ok: false, code: REJECTION.NOT_YOUR_TURN, message: "it is not your turn" };
  }

  if (candidate.type === ACTION_TYPES.MOVE) {
    const verdict = classifyPawnMove(state, seat, candidate.to as Position);
    if (!verdict.ok) return verdict;
    if (candidate.kind != null && candidate.kind !== verdict.kind) {
      // `kind` is derived by the engine; a caller-supplied value is only ever
      // checked, never trusted.
      return {
        ok: false,
        code: REJECTION.ACTION_MISMATCH,
        message: `that move is a "${verdict.kind}", not a "${candidate.kind}"`,
      };
    }
    return { ok: true, kind: verdict.kind };
  }

  const wallVerdict = classifyWall(state, seat, candidate.wall as WallPlacement);
  if (!wallVerdict.ok) return wallVerdict;
  return { ok: true, kind: ACTION_TYPES.WALL };
}

/** Thrown by `applyAction` for any turn the rules reject. */
export class BarricadeRuleError extends Error {
  readonly code: RejectionCode;
  readonly seat: Seat | null;
  readonly action: BarricadeAction | null;

  constructor(
    code: RejectionCode,
    message: string,
    details: { seat?: Seat; action?: BarricadeAction } = {},
  ) {
    super(message);
    this.name = "BarricadeRuleError";
    this.code = code;
    this.seat = details.seat ?? null;
    this.action = details.action ?? null;
  }
}

/** Narrow a caught error back to a rule rejection (for route handlers). */
export function isBarricadeRuleError(value: unknown): value is BarricadeRuleError {
  return value instanceof BarricadeRuleError;
}

function freezeState(state: BarricadeState): BarricadeState {
  return Object.freeze({
    ...state,
    pawns: Object.freeze({ ...state.pawns }),
    walls: Object.freeze([...state.walls]),
    wallsRemaining: Object.freeze({ ...state.wallsRemaining }),
    outcome: state.outcome ? Object.freeze({ ...state.outcome }) : null,
    lastAction: state.lastAction
      ? Object.freeze({ seat: state.lastAction.seat, action: state.lastAction.action })
      : null,
  });
}

/** A fresh, ready-to-play match: both pawns home, 10 barricades each, player1 to move. */
export function createInitialState(): BarricadeState {
  return freezeState({
    status: MATCH_STATUS.PLAYING,
    turn: FIRST_SEAT,
    ply: 0,
    pawns: {
      player1: startPositionFor(SEATS[0]),
      player2: startPositionFor(SEATS[1]),
    },
    walls: [],
    wallsRemaining: {
      player1: WALLS_PER_PLAYER,
      player2: WALLS_PER_PLAYER,
    },
    winner: null,
    outcome: null,
    lastAction: null,
  });
}

/** An independent frozen copy of a state (never aliases the caller's arrays). */
export function cloneState(state: BarricadeState): BarricadeState {
  return freezeState(state);
}

/**
 * Play `action` for `seat` and return the NEXT state. The input state is never
 * touched — neither when the action is accepted (a new frozen object is
 * returned, the old one still reads exactly as before) nor when it is rejected
 * (a `BarricadeRuleError` carrying `code` is thrown, and nothing was written).
 *
 * A winning move ends the match inside the same call: `status` becomes
 * `"finished"`, `winner`/`outcome` record the result, and `turn` still advances
 * to the other seat (informational once the match is over).
 */
export function applyAction(
  state: BarricadeState,
  seat: Seat,
  action: BarricadeAction,
): BarricadeState {
  const validation = validateAction(state, seat, action);
  if (validation.ok === false) {
    throw new BarricadeRuleError(validation.code, validation.message, { seat, action });
  }

  const turn = otherSeat(seat);
  const ply = state.ply + 1;

  // `validateAction` has already rejected anything that is not a wall or a
  // move, so the action's own tag is the authority for which branch to take.
  if (action.type === ACTION_TYPES.WALL) {
    const placement = action.wall;
    const wall: PlacedWall = Object.freeze({
      col: placement.col,
      row: placement.row,
      orientation: placement.orientation,
      owner: seat,
    });
    const record: ActionRecord = Object.freeze({
      seat,
      action: Object.freeze({
        type: ACTION_TYPES.WALL,
        wall: Object.freeze({
          col: placement.col,
          row: placement.row,
          orientation: placement.orientation,
        }),
      }) as WallAction,
    });
    return freezeState({
      ...state,
      ply,
      turn,
      walls: [...state.walls, wall],
      wallsRemaining: {
        ...state.wallsRemaining,
        [seat]: state.wallsRemaining[seat] - 1,
      },
      lastAction: record,
    });
  }

  const to = action.to;
  const destination = Object.freeze({ col: to.col, row: to.row });
  const won = isGoalPositionFor(seat, destination);
  const record: ActionRecord = Object.freeze({
    seat,
    action: Object.freeze({
      type: ACTION_TYPES.MOVE,
      to: destination,
      kind: validation.kind as MoveKind,
    }) as LegalMoveAction,
  });
  return freezeState({
    ...state,
    status: won ? MATCH_STATUS.FINISHED : state.status,
    ply,
    turn,
    pawns: { ...state.pawns, [seat]: destination },
    winner: won ? seat : state.winner,
    outcome: won ? Object.freeze({ winner: seat, reason: WIN_REASON }) : state.outcome,
    lastAction: record,
  });
}

/**
 * Convenience for callers that would rather branch on a boolean than catch:
 * applies the action or returns null. Used by the AI and by tests.
 */
export function tryApplyAction(
  state: BarricadeState,
  seat: Seat,
  action: BarricadeAction,
): BarricadeState | null {
  try {
    return applyAction(state, seat, action);
  } catch (error) {
    if (isBarricadeRuleError(error)) return null;
    throw error;
  }
}
