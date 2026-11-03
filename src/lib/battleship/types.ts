/**
 * Battleship — the strongly typed shapes the rules engine reads and writes.
 *
 * Everything here is plain data: JSON-serialisable, free of React/HTTP/SQL
 * types, so one state object can travel through a Drizzle row, a socket push and
 * a board component unchanged.
 *
 * ── THE SEPARATION THAT PROTECTS THE FLEETS ───────────────────────────────
 *
 * `PrivateMatchState` is the SERVER's truth: both fleets, in full. It must never
 * be sent to a client. Everything a client may see is produced by
 * `publicMatchState(state)` / `matchViewForSeat(state, seat)` in `./rules`, and
 * those shapes have NO field that can carry an enemy ship position:
 *
 *   PrivateMatchState          fleet placements + the authoritative attack log
 *     └─ publicMatchState      per-seat attack grids (unknown/miss/hit/sunk)
 *     └─ matchViewForSeat      the same, plus ONLY the viewer's own fleet
 *
 * `BoardCell` can therefore only ever be `unknown | miss | hit | sunk` — a
 * `sunk` cell is public precisely because the ship is already destroyed.
 */

import type {
  BOARD_CELL,
  MATCH_OUTCOME,
  MATCH_STATUS,
  ORIENTATIONS,
  REJECTION,
  SEATS,
  SEAT_RESULTS,
  SHIP_KEYS,
  SHOT_RESULTS,
} from "./constants";

/** `"player1"` or `"player2"`. Derived from the match row, never a request. */
export type Seat = (typeof SEATS)[number];

/** Horizontal grows along +x, vertical along +y. */
export type Orientation = (typeof ORIENTATIONS)[number];

/** A ship identity from the fleet table. */
export type ShipKey = (typeof SHIP_KEYS)[number];

/** `playing` or `finished`. */
export type MatchStatus = (typeof MATCH_STATUS)[keyof typeof MATCH_STATUS];

/** `miss`, `hit` or `sunk`. */
export type ShotResult = (typeof SHOT_RESULTS)[keyof typeof SHOT_RESULTS];

/** What a public cell may say. Never "ship". */
export type BoardCell = (typeof BOARD_CELL)[keyof typeof BOARD_CELL];

/** Match-absolute result, or null while the match is still running. */
export type MatchOutcome = (typeof MATCH_OUTCOME)[keyof typeof MATCH_OUTCOME];

/** Seat-relative result: win / loss / draw / continue. */
export type SeatResult = (typeof SEAT_RESULTS)[keyof typeof SEAT_RESULTS];

/** A machine-readable rejection code. */
export type RejectionCode = (typeof REJECTION)[keyof typeof REJECTION];

/** An integer cell inside the board. */
export interface Coordinate {
  readonly x: number;
  readonly y: number;
}

/** What a caller may submit: a cell, or the printed form ("B7"). */
export type CoordinateInput = Coordinate | string;

/**
 * One ship on a board: which ship, which way it lies, and its FIRST cell
 * (leftmost when horizontal, topmost when vertical).
 */
export interface ShipPlacement {
  readonly ship: ShipKey;
  readonly orientation: Orientation;
  readonly x: number;
  readonly y: number;
}

/** A complete fleet: exactly one placement per ship, five in total. */
export interface Fleet {
  readonly ships: readonly ShipPlacement[];
}

/** Every ship's cells, keyed by ship. Derived — never supplied by a client. */
export type FleetCells = Readonly<Record<ShipKey, Coordinate[]>>;

// ── Validation verdicts ───────────────────────────────────────────────────

export type PlacementVerdict =
  | { readonly ok: true; readonly ship: ShipKey; readonly cells: Coordinate[] }
  | { readonly ok: false; readonly code: RejectionCode; readonly message: string };

export type FleetVerdict =
  | { readonly ok: true; readonly cells: FleetCells }
  | { readonly ok: false; readonly code: RejectionCode; readonly message: string };

// ── Attacks ───────────────────────────────────────────────────────────────

/** One player's locked attack for a round, as a route would receive it. */
export interface AttackSubmission {
  readonly seat: Seat;
  readonly coordinate: CoordinateInput;
}

/** Both seats' attacks for one round — exactly the two values the engine takes. */
export type RoundSubmissions = Readonly<Record<Seat, CoordinateInput>>;

/** One resolved attack, as recorded in the authoritative log. */
export interface AttackRecord {
  readonly round: number;
  readonly seat: Seat;
  /** Canonical printed form ("B7") — one coordinate format everywhere. */
  readonly coordinate: string;
  readonly result: ShotResult;
  /** The ship this shot DESTROYED; null unless `result` is `sunk`. */
  readonly ship: ShipKey | null;
}

/** The outcome of evaluating one shot against an immutable pre-shot fleet. */
export interface AttackResolution {
  readonly coordinate: string;
  readonly result: ShotResult;
  readonly ship: ShipKey | null;
}

/** Everything one round produced, for the route/UI to read. */
export interface RoundResult {
  readonly round: number;
  readonly attacks: Readonly<Record<Seat, AttackResolution>>;
  /** Did this seat destroy the OPPONENT's fleet with its shot this round? */
  readonly destroyed: Readonly<Record<Seat, boolean>>;
  /** Match-level outcome, or null when the match continues. */
  readonly outcome: MatchOutcome | null;
  readonly status: MatchStatus;
  /** True when the next round is open (the match did not end). */
  readonly roundAdvanced: boolean;
}

export type RoundResolution =
  | {
      readonly ok: true;
      readonly state: PrivateMatchState;
      readonly round: RoundResult;
    }
  | {
      readonly ok: false;
      readonly code: RejectionCode;
      readonly message: string;
      /** Which seats' submissions were rejected, when it is per-seat. */
      readonly invalid: Partial<Record<Seat, RejectionCode>>;
    };

// ── Private (server-only) state ───────────────────────────────────────────

/** One seat's fleet plus the shots THAT seat has fired at the opponent. */
export interface PrivatePlayerState {
  readonly seat: Seat;
  readonly fleet: Fleet;
  readonly attacks: readonly AttackRecord[];
}

/**
 * The whole match, as pure data. SERVER-ONLY: `players.*.fleet` is every
 * enemy ship position and must never leave this process.
 */
export interface PrivateMatchState {
  readonly status: MatchStatus;
  /** The round now open. Stays at the deciding round once the match finishes. */
  readonly round: number;
  readonly players: Readonly<Record<Seat, PrivatePlayerState>>;
  readonly outcome: MatchOutcome | null;
  readonly winner: Seat | null;
}

// ── Public (client-safe) projections ──────────────────────────────────────

/** A public attack, as it appears in the shared history. */
export interface PublicAttackEvent {
  readonly round: number;
  readonly coordinate: string;
  readonly result: ShotResult;
  /** Named only when the ship was destroyed by this shot. */
  readonly ship: ShipKey | null;
}

/** One player's view of the ENEMY waters plus what they have learned. */
export interface PublicPlayerBoardState {
  /** 10×10, `board[y][x]` — never anything but unknown/miss/hit/sunk. */
  readonly board: readonly (readonly BoardCell[])[];
  readonly attacks: readonly PublicAttackEvent[];
  /** Enemy ships this player has destroyed (identities, never positions). */
  readonly sunkShips: readonly ShipKey[];
  /** Enemy ships still afloat. */
  readonly enemyShipsRemaining: number;
}

/** The whole match as any client may see it — no fleet positions. */
export interface PublicMatchState {
  readonly status: MatchStatus;
  readonly round: number;
  readonly outcome: MatchOutcome | null;
  readonly winner: Seat | null;
  readonly boards: Readonly<Record<Seat, PublicPlayerBoardState>>;
}

/** What one player is shown, and what an opponent must never be shown. */
export interface MatchView {
  readonly status: MatchStatus;
  readonly round: number;
  readonly outcome: MatchOutcome | null;
  readonly winner: Seat | null;
  readonly you: PublicPlayerBoardState & {
    readonly seat: Seat;
    /** The viewer's OWN fleet — the only fleet positions a client may hold. */
    readonly fleet: Fleet;
  };
  readonly opponent: PublicPlayerBoardState & { readonly seat: Seat };
}

/** The final, immutable result once a match has ended. */
export interface MatchResult {
  readonly outcome: MatchOutcome;
  readonly winner: Seat | null;
  readonly rounds: number;
}

// ── State validation ──────────────────────────────────────────────────────

export type StateValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: RejectionCode; readonly message: string };
