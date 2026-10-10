/**
 * Barricade — the strongly typed shapes the rules engine reads and writes.
 *
 * Everything here is plain data: JSON-serialisable, immutable by convention
 * (`./rules` returns frozen state) and free of React/HTTP/DB/browser types, so
 * the exact same state object can travel through a Drizzle row, a socket push
 * and a board component.
 *
 * GEOMETRY
 *
 *   * Squares are `(col, row)` with `0 ≤ col, row < BOARD_SIZE`. Column 0 is the
 *     left edge as seen from player1; row 0 is player1's own baseline and row
 *     BOARD_SIZE - 1 is player2's. So player1 walks up (row + 1) and player2
 *     walks down — the algebraic convention of the board game (a1 near-left).
 *   * A barricade is addressed by the SLOT (a groove intersection) its
 *     north-west square touches: `(col, row)` with `0 ≤ col, row < WALL_SLOTS`.
 *     `horizontal` spans the groove between rows `row` and `row + 1` across
 *     columns `col` and `col + 1` (it blocks up/down movement);
 *     `vertical` spans the groove between columns `col` and `col + 1` across
 *     rows `row` and `row + 1` (it blocks left/right movement).
 *   * Two barricades on the same slot overlap when their orientation matches
 *     and cross when it does not; touching at a point (different slots) is
 *     legal, exactly as in the physical game.
 *
 * Note `WallPlacement` (the payload of a wall action) is deliberately separate
 * from `PlacedWall` (a barricade already on the board): the owner is derived
 * from the acting seat by the engine and can never be supplied by a client.
 */

import type {
  ACTION_TYPES,
  END_REASONS,
  MATCH_STATUS,
  MOVE_KINDS,
  ORIENTATIONS,
  REJECTION,
  SEATS,
} from "./constants";

/** Who is acting. Derived from the match's seats — never from the request body. */
export type Seat = (typeof SEATS)[number];

/** Wall orientation: horizontal blocks up/down, vertical blocks left/right. */
export type Orientation = (typeof ORIENTATIONS)[number];

/** Match lifecycle state. Kept in the same vocabulary as the other GRYND stores. */
export type MatchStatus = (typeof MATCH_STATUS)[keyof typeof MATCH_STATUS];

/** `"move"` or `"wall"` — a turn is exactly one of the two. */
export type ActionType = (typeof ACTION_TYPES)[keyof typeof ACTION_TYPES];

/** How a pawn travelled: one square, over the opponent, or around them. */
export type MoveKind = (typeof MOVE_KINDS)[keyof typeof MOVE_KINDS];

/** Why a match is over. The engine only produces `"reached-baseline"`. */
export type EndReason = (typeof END_REASONS)[keyof typeof END_REASONS];

/** Machine-readable rejection code (also the API/UI error key). */
export type RejectionCode = (typeof REJECTION)[keyof typeof REJECTION];

/** A board square. Integer `col`/`row` inside the board. */
export interface Position {
  readonly col: number;
  readonly row: number;
}

/** A barricade being placed: its slot plus orientation. */
export interface WallPlacement {
  readonly col: number;
  readonly row: number;
  readonly orientation: Orientation;
}

/** A barricade already on the board. `owner` is cosmetic — it blocks everyone. */
export interface PlacedWall extends WallPlacement {
  readonly owner: Seat;
}

/** A request to walk the acting pawn to `to`. `kind` is derived and advisory. */
export interface PawnMoveAction {
  readonly type: "move";
  readonly to: Position;
  readonly kind?: MoveKind;
}

/** A move as the engine emits it — `kind` is always resolved. */
export interface LegalMoveAction extends PawnMoveAction {
  readonly kind: MoveKind;
}

/** A request to place `wall`. */
export interface WallAction {
  readonly type: "wall";
  readonly wall: WallPlacement;
}

/** Anything `validateAction` / `applyAction` will accept as a turn. */
export type BarricadeAction = PawnMoveAction | WallAction;

/** Anything `legalActions` emits — always accepted by `applyAction`. */
export type LegalAction = LegalMoveAction | WallAction;

/** One accepted turn, as recorded on the state and (later) in match history. */
export interface ActionRecord {
  readonly seat: Seat;
  readonly action: LegalAction;
}

/** Terminal result. A Barricade match can never be drawn. */
export interface MatchOutcome {
  readonly winner: Seat;
  readonly reason: EndReason;
}

/**
 * The whole match, as pure data.
 *
 * When `status` is not `"playing"` the match accepts nothing further: `turn` is
 * then informational only (it still advances to the other seat) and
 * `legalActions` returns an empty list. `winner`/`outcome` are the truth.
 */
export interface BarricadeState {
  readonly status: MatchStatus;
  readonly turn: Seat;
  /** Number of accepted actions so far. */
  readonly ply: number;
  readonly pawns: Readonly<Record<Seat, Position>>;
  /** Barricades in placement order. Ownership is cosmetic. */
  readonly walls: readonly PlacedWall[];
  readonly wallsRemaining: Readonly<Record<Seat, number>>;
  readonly winner: Seat | null;
  readonly outcome: MatchOutcome | null;
  readonly lastAction: ActionRecord | null;
}

/** Why a specific pawn destination is or is not legal. */
export type PawnMoveVerdict =
  | { readonly ok: true; readonly kind: MoveKind }
  | { readonly ok: false; readonly code: RejectionCode; readonly message: string };

/** Why a specific barricade is or is not legal. */
export type WallVerdict =
  | { readonly ok: true; readonly kind: "wall" }
  | { readonly ok: false; readonly code: RejectionCode; readonly message: string };

/** The result of validating a turn against the current state. */
export type ActionValidation =
  | { readonly ok: true; readonly kind: MoveKind | "wall" }
  | { readonly ok: false; readonly code: RejectionCode; readonly message: string };

/** `overlap` (same slot, same orientation), `crossing` (same slot, other), or null. */
export type WallsConflict = "overlap" | "crossing" | null;
