/**
 * Dominoes — the strongly typed shapes the rules engine reads and writes.
 *
 * Everything here is plain data: JSON-serialisable, immutable by convention
 * (`./rules` returns frozen state) and free of React/HTTP/DB/browser types, so
 * the exact same state object can travel through a Drizzle `jsonb` column, a
 * socket push and a board component.
 *
 * TILE IDENTITY
 *
 *   A tile is named by its canonical id: the two half-values joined by a
 *   hyphen, major half first (`"6-6"`, `"6-3"`, `"0-0"`). A tile is unordered —
 *   `6-3` and `3-6` are the same physical tile — so the id is the identity and
 *   the canonical form is the ONLY way to name it. `TILE_IDS` lists all 28, and
 *   `isTileId()` tests membership, which is what makes a duplicate (or a
 *   reversed id) unrepresentable at the boundary: a client that sends `"3-6"`
 *   is sending garbage, not a second tile.
 *
 *   The `TileId` TYPE is the whole 0..6 × 0..6 id space; canonical membership is
 *   a RUNTIME question (`isTileId`), exactly as a `Seat` type cannot express
 *   "the seat that is on turn".
 *
 * CHAIN ORIENTATION
 *
 *   `ChainTile` records the orientation the engine resolved, because the chain
 *   is a sequence, not a set: `left` is the value facing the left-hand end and
 *   `right` the value facing the right-hand end, so the chain reads
 *   left-to-right and the two exposed values are `chain[0].left` and
 *   `chain[chain.length - 1].right`. A double has `left === right`; the UI
 *   draws it crosswise, the rules do not care.
 *
 *   `DominoesState.openEnds` is stored EXPLICITLY (rather than only derived) so
 *   the persisted row carries the two values the next turn matches against, and
 *   `openEndsOf()` is the one derivation the engine and the tests cross-check it
 *   against.
 */

import type {
  ACTION_TYPES,
  CHAIN_ENDS,
  END_REASONS,
  MATCH_STATUS,
  PIP_VALUES,
  REJECTION,
  SEATS,
  STARTING_RULES,
} from "./constants";

/** Who is acting. Derived from the match's seats — never from a request body. */
export type Seat = (typeof SEATS)[number];

/** One half of a tile. */
export type Pip = (typeof PIP_VALUES)[number];

/**
 * A tile's canonical id: `"<high>-<low>"` with `high >= low`.
 *
 * The type admits every 0..6 pair (including a reversed or repeated string);
 * `isTileId()` is the canonical membership test against `TILE_IDS`, and every
 * engine entry point runs it before trusting an id.
 */
export type TileId = `${Pip}-${Pip}`;

/** Which end of the chain a tile is attached to (or opened). */
export type ChainEnd = (typeof CHAIN_ENDS)[number];

/** Match lifecycle state. Kept in the same vocabulary as the other GRYND stores. */
export type MatchStatus = (typeof MATCH_STATUS)[keyof typeof MATCH_STATUS];

/** `"play"`, `"draw"` or `"pass"` — one action per turn, except repeated draws. */
export type ActionType = (typeof ACTION_TYPES)[keyof typeof ACTION_TYPES];

/** Why the round is over. The engine produces `emptied-hand` / `blocked-pips`. */
export type EndReason = (typeof END_REASONS)[keyof typeof END_REASONS];

/** How the starting seat was chosen (descriptive; see `chooseStartingSeat`). */
export type StartingRule = (typeof STARTING_RULES)[keyof typeof STARTING_RULES];

/** Machine-readable rejection code (also the API/UI error key). */
export type RejectionCode = (typeof REJECTION)[keyof typeof REJECTION];

/** One tile already on the shared chain, with the orientation the engine chose. */
export interface ChainTile {
  readonly id: TileId;
  /** The end it was attached to; the opening tile records `"left"`. */
  readonly end: ChainEnd;
  /** Value facing the left-hand end of the chain. */
  readonly left: number;
  /** Value facing the right-hand end of the chain. */
  readonly right: number;
  /** `left === right` — draw it crosswise, match it normally. */
  readonly isDouble: boolean;
  /** Who played it. Cosmetic (the board highlights the last tile); never a rule. */
  readonly seat: Seat;
}

/** A tile being played. `end` is omitted only when the chain is still empty. */
export interface PlayAction {
  readonly type: "play";
  readonly tile: TileId;
  readonly end?: ChainEnd;
}

/** Take the next tile off the draw pile. Legal only when nothing is playable. */
export interface DrawAction {
  readonly type: "draw";
}

/** Give up the turn: the pile is empty and nothing is playable. */
export interface PassAction {
  readonly type: "pass";
}

/** Anything `validateAction` / `applyAction` will accept as a turn. */
export type DominoesAction = PlayAction | DrawAction | PassAction;

/** A play as `legalPlays` emits it — `end` is always resolved for a live chain. */
export type LegalPlayAction = PlayAction & { readonly end: ChainEnd };

/** Anything `legalActions` emits — always accepted by `applyAction`. */
export type LegalAction = LegalPlayAction | DrawAction | PassAction;

/** One accepted action, as recorded on the state and (later) in match history. */
export interface ActionRecord {
  readonly seat: Seat;
  readonly action: LegalAction;
}

/** Terminal result. `winner: null` is the tied-pip draw. */
export interface DominoesOutcome {
  readonly winner: Seat | null;
  readonly reason: EndReason;
  /** Remaining pips per seat at the final position (0 for the empty hand). */
  readonly pips: Readonly<Record<Seat, number>>;
}

/**
 * The whole match, as pure data.
 *
 * When `status` is not `"playing"` the match accepts nothing further: `turn` is
 * then informational only, `legalActions` returns an empty list and
 * `winner`/`outcome` are the truth.
 *
 * `hands`, `drawPile` and `chain` partition the 28 tiles exactly — no tile is
 * ever duplicated or lost, which the tests assert after every action.
 */
export interface DominoesState {
  readonly status: MatchStatus;
  /** The seat to act. Stays put across a draw, advances on a play or a pass. */
  readonly turn: Seat;
  /** Number of accepted actions so far (draws included). */
  readonly ply: number;
  /** Each seat's own tiles, in the order dealt and drawn. SECRET per seat. */
  readonly hands: Readonly<Record<Seat, readonly TileId[]>>;
  /** Face-down tiles, in shuffled order. The NEXT draw is index 0. SECRET. */
  readonly drawPile: readonly TileId[];
  /** The shared chain, left to right, in the order it was built. */
  readonly chain: readonly ChainTile[];
  /** The two values the next tile must match. `null` until the chain opens. */
  readonly openEnds: Readonly<Record<ChainEnd, number | null>>;
  /** The seat the deal's own starting rule selected. */
  readonly startingSeat: Seat;
  /**
   * The tile that decided it (`highest-double` or `highest-total`).
   *
   * For a highest-double deal this tile has already been PLAYED — it is the
   * chain's opening tile — so it is public; for a highest-total deal it is
   * still in the starting seat's hand and is never projected.
   */
  readonly startingTile: TileId;
  readonly winner: Seat | null;
  readonly outcome: DominoesOutcome | null;
  readonly lastAction: ActionRecord | null;
}

/** A dealt match before it is turned into a state: 7 / 7 / 14, all 28 tiles. */
export interface Deal {
  readonly hands: Readonly<Record<Seat, readonly TileId[]>>;
  readonly drawPile: readonly TileId[];
}

/** How the starting seat was chosen, for the store/UI and the tests. */
export interface StartingChoice {
  readonly seat: Seat;
  readonly tile: TileId;
  readonly rule: StartingRule;
}

/** The result of validating a turn against the current state. */
export type ActionValidation =
  | { readonly ok: true; readonly kind: ActionType }
  | { readonly ok: false; readonly code: RejectionCode; readonly message: string };
