// src/lib/tic-tac-toe/types.ts
//
// The shared type vocabulary for Tic-Tac-Toe Duel. Deliberately free of
// imports from `./constants` so there is no runtime cycle — `constants.ts`
// imports the `Seat` union from here, exactly as Mini Golf does.

/** A player's mark. */
export type Mark = "X" | "O";

/** Seat names. Also the suffix of every per-seat field in the match row. */
export type Seat = "player1" | "player2";

/** One cell of the board: empty, or claimed by a mark. */
export type Cell = Mark | null;

/** The outcome of a match, in the same vocabulary persisted by the schema. */
export type MatchResult = Seat | "tie";

/** Persisted match phase. `playing` accepts a move; `finished` is terminal. */
export type MatchPhase = "playing" | "finished";

/** The most recent accepted move, for the client's highlight + history panel. */
export type LastMove = {
  seat: Seat;
  cellIndex: number;
  mark: Mark;
  /** Turn number this move was played on (0-based: ply 0 is X's first move). */
  ply: number;
};

/**
 * The authoritative match state, stored as `tic_tac_toe_matches.game_state`.
 *
 * Deliberately free of player ids: the seat is the identity the engine reasons
 * about, and the seat→Clerk-id mapping lives in the row's `player1_id` /
 * `player2_id` columns. That keeps this object non-redundant and makes every
 * transition here pure.
 *
 * There is no `seed`: tic-tac-toe contains no randomness, so the board is a
 * pure function of the move order and needs nothing to reproduce it.
 */
export type TicTacToeState = {
  /** Monotonic optimistic-concurrency counter. Incremented on every write. */
  version: number;
  phase: MatchPhase;
  /** Row-major, length 9. Index 0 is the top-left cell. */
  board: Cell[];
  /** Whose turn it is. Always `seatForPly(ply)`; stored for cheap reads. */
  currentTurn: Seat;
  /** Accepted moves so far (0..9). */
  ply: number;
  /** Set only when a seat has completed a line. */
  winner: Seat | null;
  /** The three indices that won, or null. Drives the UI's win highlight. */
  winningLine: number[] | null;
  lastMove: LastMove | null;
};

/** Seat→user id mapping, sourced from the match row. */
export type Seats = { player1Id: string; player2Id: string | null };

/** One accepted move, as persisted in `tic_tac_toe_moves`. */
export type MoveRecord = {
  ply: number;
  playerId: string;
  cellIndex: number;
};
