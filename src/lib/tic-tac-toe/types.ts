// src/lib/tic-tac-toe/types.ts
//
// The shared type vocabulary for Ultimate Tic-Tac-Toe. Deliberately free of
// imports from `./constants` so there is no runtime cycle — `constants.ts`
// imports the `Seat` union from here, exactly as Mini Golf does.
//
// ── THE GAME ──────────────────────────────────────────────────────────────
//
// Ultimate Tic-Tac-Toe is nine ordinary 3x3 mini-boards in one fixed 3x3
// lattice. There are no rounds, no expansions and no tiebreak:
//
//   • X (player1) moves first.
//   • A move is a (boardIndex, cellIndex) PAIR — but `boardIndex` is only ever
//     the board the rules let you play, never a free choice the client makes.
//   • Three in a line inside a mini-board CLAIMS that board. A mini-board that
//     fills with no line is a DRAW and is locked for the rest of the match.
//   • The CELL you play determines the mini-board your opponent must play next:
//     cell 4 sends them to board 4. If that destination is already resolved,
//     they may choose any unfinished mini-board (`nextBoard: null`).
//   • Three collinear claimed mini-boards win the match immediately.
//   • All nine mini-boards resolved with no lattice line is a DRAW.
//
// All of this is derived by the pure engine in `./rules.ts`; none of it is ever
// accepted from a client.

/** A player's mark. */
export type Mark = "X" | "O";

/** Seat names. Also the suffix of every per-seat field in the match row. */
export type Seat = "player1" | "player2";

/** One cell of a mini-board: empty, or claimed by a mark. */
export type Cell = Mark | null;

/** The outcome of a match, in the same vocabulary persisted by the schema. */
export type MatchResult = Seat | "tie";

/** Persisted match phase. `playing` accepts a move; `finished` is terminal. */
export type MatchPhase = "playing" | "finished";

/**
 * Who owns a mini-board.
 *
 *   "active"   — still playable; cells may be claimed
 *   "X" / "O"  — locked: that mark completed a line
 *   "draw"     — locked: the board filled with no line
 *
 * A claimed board (`"X"` / `"O"`) is the unit the lattice lines are made of.
 */
export type BoardControl = "active" | "draw" | Mark;

/**
 * One small 3x3 board.
 *
 * `cells` is row-major, length 9. `control` and `winningLine` are DERIVED from
 * `cells` by the engine and stored denormalised so a reader (and the lattice
 * check) never has to rescan every cell.
 */
export type SmallBoard = {
  /** Row-major, length 9. Index 0 is the top-left cell. */
  cells: Cell[];
  /** Accepted moves on THIS board (0..9). */
  plies: number;
  /** Who owns this board, or "active" while it can still be played. */
  control: BoardControl;
  /** The three winning cell indices when `control` is X/O, else null. */
  winningLine: number[] | null;
};

/**
 * The most recent accepted move, for the client's highlight + history panel.
 *
 * `boardIndex` is always a lattice slot (0..8) — there is no other addressing
 * mode in Ultimate. `ply` is the match-wide turn number (0-based).
 */
export type LastMove = {
  seat: Seat;
  boardIndex: number;
  cellIndex: number;
  mark: Mark;
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
 * There is no `seed`: Ultimate Tic-Tac-Toe contains no randomness, so the
 * boards are a pure function of the move order and need nothing to reproduce
 * them.
 */
export type TicTacToeState = {
  /** Monotonic optimistic-concurrency counter. Incremented on every write. */
  version: number;
  phase: MatchPhase;
  /**
   * The lattice, length 9, row-major. Always all nine boards: Ultimate has no
   * expansion, so every mini-board exists from the opening position.
   *
   * A `null` slot is tolerated on READ for legacy expansion-era rows (which
   * only materialised the boards their stage needed) and normalises to an
   * empty, active mini-board; the engine only ever WRITES nine real boards.
   */
  boards: (SmallBoard | null)[];
  /** Whose turn it is. */
  currentTurn: Seat;
  /** Total accepted moves across every board (0..81). */
  ply: number;
  /** Set only when the match has been decided for a seat. */
  winner: Seat | null;
  /** The three lattice slots that won the match, or null. Drives the highlight. */
  winningBoards: number[] | null;
  /**
   * The ONLY mini-board the seat to move may play, or null when it has a free
   * choice of every unfinished board.
   *
   * Derived from the previous move's CELL index (and normalised away when that
   * destination is already resolved), never accepted from a client.
   */
  nextBoard: number | null;
  lastMove: LastMove | null;
};

/** Seat→user id mapping, sourced from the match row. */
export type Seats = { player1Id: string; player2Id: string | null };

/** One accepted move, as persisted in `tic_tac_toe_moves`. */
export type MoveRecord = {
  ply: number;
  playerId: string;
  /** Lattice slot 0..8. */
  boardIndex: number;
  /** Cell 0..8 within that board. */
  cellIndex: number;
};
