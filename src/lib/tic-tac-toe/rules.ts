// src/lib/tic-tac-toe/rules.ts
//
// The pure Ultimate Tic-Tac-Toe rules engine: NO database, NO I/O, NO randomness.
// Every function here is a deterministic transformation of the authoritative
// state, which makes the turn/move/match lifecycle unit-testable in isolation
// and keeps the API routes and the store thin.
//
// TRUST BOUNDARY: the ONLY player-authored values that reach this module are
// `boardIndex` and `cellIndex` — and even `boardIndex` is only ever ACCEPTED
// when it is the destination the rules derived from the opponent's previous
// move. The mark, the boards, each board's control, whose turn it is, the
// required destination, the lattice line, the winner and the match result are
// all derived here. Nothing reads a client-supplied winner, result, board
// owner, turn, destination or completion flag — no such value is ever passed in.
//
// ── THE RULES, EXACTLY ────────────────────────────────────────────────────
//
//   • Nine mini-boards, always arranged in a fixed 3x3 lattice (slots 0..8).
//   • X (player1) moves first. Each turn places exactly one mark.
//   • Three in a row/column/diagonal INSIDE a mini-board claims that board.
//   • A mini-board that fills with no line is a DRAW and stays locked.
//   • The CELL index of a move is the mini-board the opponent must play next.
//     If that destination is already resolved (claimed or drawn), the opponent
//     may choose ANY unfinished mini-board.
//   • Three collinear claimed mini-boards win the match IMMEDIATELY, in the
//     same transition that completed the line.
//   • All nine mini-boards resolved with no lattice line is a DRAW.
//   • Once the match is finished no further move is accepted.
//
// The opening position is a constant — there is no seed, no dealt state and no
// randomness — so `applyMove` is a pure function of
// (state, seat, boardIndex, cellIndex) and `replayMoves` can rebuild a match
// from its move log with no second implementation to drift.

import {
  BOARD_SIZE,
  CELL_COUNT,
  FIRST_SEAT,
  LATTICE_LINES,
  LATTICE_SIZE,
  LATTICE_SLOTS,
  MARKS,
  MATCH_STATUS,
  MAX_BOARDS,
  RESULT,
  WINNING_LINES,
} from "./constants";
import type {
  BoardControl,
  Cell,
  Mark,
  MatchResult,
  MoveRecord,
  Seat,
  Seats,
  SmallBoard,
  TicTacToeState,
} from "./types";

// ── Seats and marks ───────────────────────────────────────────────────────

/** Seat→mark. player1 is X and therefore moves first. */
export function markForSeat(seat: Seat): Mark {
  return seat === "player2" ? "O" : "X";
}

/** Inverse of `markForSeat`. */
export function seatForMark(mark: Mark): Seat {
  return mark === "O" ? "player2" : "player1";
}

/** Which seat owns user id `userId`, or null when they hold no seat. */
export function seatForUser(seats: Seats, userId: string | null): Seat | null {
  if (!userId) return null;
  if (userId === seats.player1Id) return "player1";
  if (seats.player2Id && userId === seats.player2Id) return "player2";
  return null;
}

export function otherSeat(seat: Seat): Seat {
  return seat === "player1" ? "player2" : "player1";
}

export function userIdForSeat(seats: Seats, seat: Seat): string | null {
  return seat === "player1" ? seats.player1Id : seats.player2Id;
}

/** True when BOTH seats are known (i.e. the match is a real 1v1). */
export function hasBothSeats(seats: Seats): boolean {
  return Boolean(seats.player1Id && seats.player2Id);
}

/**
 * Whose turn a given ply belongs to. X opens, so an even ply is player1.
 *
 * The state's `currentTurn` is maintained by hand-off in `applyMove`; this is
 * the closed form of the same rule, exported so callers (and tests) can assert
 * the two agree.
 */
export function seatForPly(ply: number): Seat {
  return ply % 2 === 0 ? "player1" : "player2";
}

/** Seat→user-id mapping from a persisted match row. */
export function seatsFromMatch(match: { player1Id: string; player2Id?: string | null }): Seats {
  return { player1Id: match.player1Id, player2Id: match.player2Id ?? null };
}

// ── Construction ──────────────────────────────────────────────────────────

function emptyCells(): Cell[] {
  return Array.from({ length: CELL_COUNT }, () => null);
}

/** A fresh, empty, playable mini-board. */
export function createEmptyBoard(): SmallBoard {
  return { cells: emptyCells(), plies: 0, control: "active", winningLine: null };
}

/**
 * A fresh match: NINE empty mini-boards and no required destination.
 *
 * Takes no arguments at all — Ultimate Tic-Tac-Toe has no seed, no dealt state
 * and no randomness, so the opening position is a constant.
 */
export function createInitialState(): TicTacToeState {
  return {
    version: 1,
    phase: "playing",
    boards: LATTICE_SLOTS.map(() => createEmptyBoard()),
    currentTurn: FIRST_SEAT,
    ply: 0,
    winner: null,
    winningBoards: null,
    nextBoard: null,
    lastMove: null,
  };
}

/**
 * The nine boards of a state, normalised: every slot is a real board, and each
 * board's `control` / `winningLine` / `plies` are RE-DERIVED from its cells.
 *
 * Two deliberate consequences:
 *
 *   1. The denormalised fields are never trusted. Even a tampered or stale
 *      `game_state` blob cannot declare a board owned, so no caller can smuggle
 *      a board owner or a winner past the rules engine.
 *   2. A `null` slot — which only a legacy expansion-era row can hold, since
 *      the engine now always writes nine boards — reads as an empty, active
 *      mini-board instead of crashing or deadlocking the match.
 *
 * Always returns fresh objects, so a caller can mutate the result freely.
 */
export function latticeOf(state: TicTacToeState): SmallBoard[] {
  const raw = Array.isArray(state?.boards) ? state.boards : [];
  return LATTICE_SLOTS.map((slot) => {
    const board = raw[slot];
    const cells = isWellFormedBoard(board?.cells) ? [...board!.cells] : emptyCells();
    const { control, winningLine } = resolveBoardControl(cells);
    return {
      cells,
      plies: cells.reduce((count, cell) => (cell === null ? count : count + 1), 0),
      control,
      winningLine,
    };
  });
}

// ── Board queries ─────────────────────────────────────────────────────────

/** True when `board` is a well-formed 9-cell array. */
export function isWellFormedBoard(board: unknown): board is Cell[] {
  return (
    Array.isArray(board) &&
    board.length === CELL_COUNT &&
    board.every((cell) => cell === null || cell === "X" || cell === "O")
  );
}

/** True when `value` is a playable board index (0..8), strictly typed. */
export function isValidCellIndex(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < CELL_COUNT;
}

/**
 * True when `value` is a lattice slot (0..8), strictly typed.
 *
 * There is no special sentinel in Ultimate: every legal move addresses one of
 * the nine real mini-boards.
 */
export function isValidBoardIndex(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < MAX_BOARDS;
}

/** How many cells a mark occupies on a board. */
export function countCells(board: Cell[], mark: Mark): number {
  if (!isWellFormedBoard(board)) return 0;
  let count = 0;
  for (const cell of board) if (cell === mark) count += 1;
  return count;
}

/**
 * The first completed line, or null.
 *
 * Enumerates all eight lines rather than scanning incrementally, so a win is
 * detected identically no matter which move completed it.
 */
export function findWinningLine(board: Cell[]): { mark: Mark; line: number[] } | null {
  if (!isWellFormedBoard(board)) return null;
  for (const line of WINNING_LINES) {
    const [a, b, c] = line;
    const mark = board[a];
    if (mark !== null && mark === board[b] && mark === board[c]) {
      return { mark, line: [...line] };
    }
  }
  return null;
}

/** True when every cell is occupied. */
export function isBoardFull(board: Cell[]): boolean {
  return (
    Array.isArray(board) && board.length === CELL_COUNT && board.every((cell) => cell !== null)
  );
}

/**
 * The control a set of cells implies: a completed line's mark, "draw" when the
 * board is full with no line, else "active". Pure and total.
 */
export function resolveBoardControl(cells: Cell[]): {
  control: BoardControl;
  winningLine: number[] | null;
} {
  const win = findWinningLine(cells);
  if (win) return { control: win.mark, winningLine: [...win.line] };
  if (isBoardFull(cells)) return { control: "draw", winningLine: null };
  return { control: "active", winningLine: null };
}

/** True when a mini-board can no longer accept a move (claimed or drawn). */
export function isBoardResolved(board: SmallBoard | null | undefined): boolean {
  return Boolean(board) && board!.control !== "active";
}

// ── Lattice queries ───────────────────────────────────────────────────────

/**
 * The first lattice line of three boards CLAIMED by one mark, or null.
 *
 * Reads only each board's (derived) `control`, so an active or drawn slot can
 * never form a line. Enumerates all eight lines, so a win is detected the
 * instant the final board of any line is claimed.
 */
export function findLatticeWin(
  boards: (SmallBoard | null)[] | TicTacToeState
): { mark: Mark; line: number[] } | null {
  const lattice = toLattice(boards);
  for (const line of LATTICE_LINES) {
    const control = lattice[line[0]].control;
    if (control !== "X" && control !== "O") continue;
    if (line.every((slot) => lattice[slot].control === control)) {
      return { mark: control, line: [...line] };
    }
  }
  return null;
}

/** True once every one of the nine mini-boards has resolved (won or drawn). */
export function allBoardsResolved(boards: (SmallBoard | null)[] | TicTacToeState): boolean {
  return toLattice(boards).every((board) => board.control !== "active");
}

/** Accept either a raw board array or a whole state. */
function toLattice(boards: (SmallBoard | null)[] | TicTacToeState): SmallBoard[] {
  if (Array.isArray(boards)) return latticeOf({ boards } as TicTacToeState);
  return latticeOf(boards);
}

/**
 * The mini-boards that can STILL accept a move: all nine slots whose control is
 * still "active".
 *
 * Derived, never stored — which is what makes "a resolved board cannot receive
 * more moves" a property of the derived board set rather than a rule a caller
 * has to remember.
 */
export function activeBoardIndexes(state: TicTacToeState): number[] {
  const lattice = latticeOf(state);
  return LATTICE_SLOTS.filter((slot) => lattice[slot].control === "active");
}

/** The mini-boards that are LOCKED (claimed or drawn). */
export function completedBoardIndexes(state: TicTacToeState): number[] {
  const lattice = latticeOf(state);
  return LATTICE_SLOTS.filter((slot) => lattice[slot].control !== "active");
}

/**
 * One board's control: a mark when it is claimed, "draw" when it is full with no
 * line, "active" while still playable.
 */
export function boardControlAt(state: TicTacToeState, boardIndex: number): BoardControl | null {
  if (!isValidBoardIndex(boardIndex)) return null;
  return latticeOf(state)[boardIndex].control;
}

/**
 * The mini-board the seat to move MUST play, or null when it may choose freely.
 *
 * The stored `nextBoard` is only honoured while that destination is still
 * unfinished: a destination that has since resolved (or a legacy row with no
 * `nextBoard` at all) yields a free choice. That single normalisation is what
 * implements "if the destination is already resolved, play anywhere".
 */
export function requiredBoardIndex(state: TicTacToeState): number | null {
  const raw = state?.nextBoard;
  if (!isValidBoardIndex(raw)) return null;
  return boardControlAt(state, raw as number) === "active" ? (raw as number) : null;
}

/**
 * Every board the seat to move is ALLOWED to address: the single required
 * destination, or all unfinished boards when the choice is free.
 */
export function playableBoardIndexes(state: TicTacToeState): number[] {
  const required = requiredBoardIndex(state);
  if (required !== null) return [required];
  return activeBoardIndexes(state);
}

/** True when a move on `boardIndex` is addressable in the current state. */
export function isPlayableBoard(state: TicTacToeState, boardIndex: unknown): boolean {
  return playableBoardIndexes(state).includes(boardIndex as number);
}

/**
 * The destination a move on `cellIndex` hands the opponent: the board with that
 * same index — or null (free choice) when that board is already resolved.
 */
export function nextBoardForCell(
  boards: (SmallBoard | null)[] | TicTacToeState,
  cellIndex: number
): number | null {
  if (!isValidCellIndex(cellIndex)) return null;
  const lattice = toLattice(boards);
  return lattice[cellIndex].control === "active" ? cellIndex : null;
}

/**
 * True when `state` is a structurally sound authoritative state.
 *
 * Deliberately shallow: it checks the SHAPE the engine indexes into (nine slots,
 * well-formed cells, a legal phase/seat, integer counters), NOT the denormalised
 * control/winningLine fields — those are always re-derived by `latticeOf`, so a
 * stale value there can never change a result. A `null` slot is allowed (see
 * `latticeOf`); anything else malformed is refused rather than guessed at.
 */
export function isWellFormedState(state: unknown): state is TicTacToeState {
  if (!state || typeof state !== "object") return false;
  const candidate = state as TicTacToeState;
  if (candidate.phase !== "playing" && candidate.phase !== "finished") return false;
  if (candidate.currentTurn !== "player1" && candidate.currentTurn !== "player2") return false;
  if (!Number.isInteger(candidate.version) || candidate.version < 0) return false;
  if (!Number.isInteger(candidate.ply) || candidate.ply < 0) return false;
  if (!Array.isArray(candidate.boards) || candidate.boards.length !== MAX_BOARDS) return false;
  for (const board of candidate.boards) {
    if (board === null || board === undefined) continue;
    if (typeof board !== "object" || !isWellFormedBoard(board.cells)) return false;
  }
  if (
    candidate.nextBoard !== null &&
    candidate.nextBoard !== undefined &&
    !isValidBoardIndex(candidate.nextBoard)
  ) {
    return false;
  }
  return true;
}

// ── Legacy (expansion-era) states ──────────────────────────────────────────

/**
 * True when a persisted `game_state` blob was written by the OLD, expansion-era
 * engine ("Mega Tic-Tac-Toe": one board that grew to four, then nine).
 *
 * This is the compatibility boundary for in-flight matches across the rules
 * change, and it is deliberately detect-only: the rules engine never plays such
 * a state, because half of its meaning (stage, board materialisation, the
 * tiebreak, sudden death) no longer exists. A legacy match with NO moves is
 * re-seeded to the current opening position (nothing is lost); one with moves
 * already played is VOIDED with both stakes refunded, never reinterpreted as a
 * nine-board Ultimate position.
 *
 * The markers are exhaustive and cheap:
 *
 *   • `stage` / `tiebreak` / `suddenDeath` — keys the old engine always wrote
 *     and the current one never does;
 *   • a missing `nextBoard` — every state this engine writes has that key;
 *   • a `null`/absent slot or a wrong-length lattice — the current engine always
 *     materialises all nine mini-boards.
 *
 * A structurally malformed blob (e.g. a non-array `boards`) is NOT reported
 * here; `isWellFormedState` rejects it, and the store treats both cases the same
 * way (void + refund) so neither can lock a match forever.
 */
export function isExpansionEraState(state: unknown): boolean {
  if (!state || typeof state !== "object") return false;
  const raw = state as Record<string, unknown>;
  // The unmistakable markers: keys only the old engine wrote.
  for (const key of ["stage", "tiebreak", "suddenDeath"]) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) return true;
  }
  const boards = raw.boards;
  // Not a nine-slot lattice at all — that is "unreadable", not "old".
  // `isWellFormedState` is the authority for that distinction; this predicate
  // only speaks about blobs that ARE lattice-shaped.
  if (!Array.isArray(boards) || boards.length !== MAX_BOARDS) return false;
  // Every state this engine writes carries `nextBoard`, and materialises all
  // nine boards. A shape-compatible blob missing either is pre-Ultimate.
  if (!Object.prototype.hasOwnProperty.call(raw, "nextBoard")) return true;
  return boards.some((board) => board === null || board === undefined);
}

// ── Validation ────────────────────────────────────────────────────────────

// NOTE: a single object with optional fields rather than a boolean-discriminant
// union. This repo compiles with `strict: false`, where narrowing on a boolean
// literal does not behave as expected (the same reason
// src/lib/auth/requireAgeVerified.ts returns plain objects).
export type MoveValidation = {
  ok: boolean;
  seat?: Seat;
  /** The mini-board the move targets, once resolved. */
  board?: SmallBoard;
  error?: string;
  status?: number;
};

/**
 * Validate a move request against the authoritative state. Everything the
 * client is NOT allowed to influence is checked here, in this order:
 *
 *   1. the state is well formed                    (500)
 *   2. the match is not already finished            (409)
 *   3. the caller holds a seat                       (403)
 *   4. it is the caller's turn                       (409)
 *   5. the board index is a real slot                (400)
 *   6. it is the REQUIRED destination, when there is one (409)
 *   7. that mini-board is still unfinished           (409)
 *   8. the cell index is a valid index               (400)
 *   9. the cell is empty                             (409)
 *  10. the client is not acting on stale state       (409)
 *
 * The participant and match-status checks live in the store (they need the
 * row), so this function only sees a caller who already holds a seat.
 */
export function validateMove({
  state,
  seat,
  boardIndex,
  cellIndex,
  expectedVersion,
}: {
  state: TicTacToeState;
  seat: Seat | null;
  boardIndex: unknown;
  cellIndex: unknown;
  expectedVersion?: unknown;
}): MoveValidation {
  if (!isWellFormedState(state)) {
    return { ok: false, error: "Match state is unavailable", status: 500 };
  }
  if (state.phase === "finished") {
    return { ok: false, error: "Match is already finished", status: 409 };
  }
  if (!seat) {
    return { ok: false, error: "Not a participant of this match", status: 403 };
  }
  if (state.currentTurn !== seat) {
    return { ok: false, error: "It is not your turn", status: 409 };
  }

  // ── Is this the board the rules allow? ─────────────────────────────────
  //
  // Strict type check, not a Number() coercion: `Number("")`, `Number(true)`
  // and `Number([])` are all 0, which would let a malformed body through as a
  // silent "board 0".
  if (!isValidBoardIndex(boardIndex)) {
    return {
      ok: false,
      error: `Board index must be an integer in [0, ${MAX_BOARDS - 1}]`,
      status: 400,
    };
  }
  const index = boardIndex as number;

  // The FORCED DESTINATION is the rule a client most often gets wrong, so it is
  // reported before anything about the board's own state: the destination comes
  // from the opponent's previous move and is never negotiable.
  const required = requiredBoardIndex(state);
  if (required !== null && index !== required) {
    return {
      ok: false,
      error: `Your move must be played in board ${required}`,
      status: 409,
    };
  }

  const target = latticeOf(state)[index];
  if (target.control !== "active") {
    return { ok: false, error: "That mini-board is already decided", status: 409 };
  }

  if (!isValidCellIndex(cellIndex)) {
    return {
      ok: false,
      error: `Cell index must be an integer in [0, ${CELL_COUNT - 1}]`,
      status: 400,
    };
  }
  const cell = cellIndex as number;

  if (target.cells[cell] !== null) {
    return { ok: false, error: "Cell is already occupied", status: 409 };
  }

  // Optimistic concurrency: the client must prove it is acting on the state it
  // was shown, so a double-submit or a stale tab cannot apply a second move.
  //
  // The token is checked STRICTLY, mirroring the index checks above: a boolean,
  // a numeric string or a non-integer (all of which `Number()` would coerce, so
  // `true`/"1"/[1]/1.9 would otherwise read as version 1) is refused rather
  // than silently accepted as the client's version.
  if (expectedVersion !== undefined && expectedVersion !== null) {
    if (
      typeof expectedVersion !== "number" ||
      !Number.isInteger(expectedVersion) ||
      expectedVersion !== state.version
    ) {
      return { ok: false, error: "Stale match state", status: 409 };
    }
  }

  return { ok: true, seat, board: target };
}

// ── Progression ───────────────────────────────────────────────────────────

export type AppliedMove = {
  state: TicTacToeState;
  /** True when this move resolved (claimed or drew) the mini-board it hit. */
  boardResolved: boolean;
  /** The mark that claimed that mini-board, or null for a draw / still active. */
  boardClaimed: Mark | null;
  /** True when this move ended the match — by a lattice line OR a full draw. */
  matchCompleted: boolean;
  /** The winning seat, or null for a draw. */
  winnerSeat: Seat | null;
  /** The mini-board's winning line, when this move completed one. */
  winningLine: number[] | null;
  /** The three lattice slots that won, when the win was a lattice line. */
  winningBoards: number[] | null;
};

/**
 * Apply one validated move and run every downstream transition: place the mark,
 * resolve the mini-board, detect a lattice line, hand the turn over and derive
 * the opponent's required destination.
 *
 * Assumes the move already passed `validateMove` — it does not re-check
 * legality beyond the structural invariants it needs to index safely. It
 * derives the mark from the SEAT (never from the caller), so a client cannot
 * place the wrong mark. It never mutates `state`: the returned state owns fresh
 * boards, fresh cells arrays and a fresh lastMove.
 */
export function applyMove({
  state,
  seat,
  boardIndex,
  cellIndex,
}: {
  state: TicTacToeState;
  seat: Seat;
  boardIndex: number;
  cellIndex: number;
}): AppliedMove {
  if (!isWellFormedState(state)) {
    throw new RangeError("ultimate tic-tac-toe rules: malformed match state");
  }
  if (state.phase === "finished") {
    throw new RangeError("ultimate tic-tac-toe rules: the match is already finished");
  }
  if (!isValidCellIndex(cellIndex)) {
    throw new RangeError(`ultimate tic-tac-toe rules: cell ${cellIndex} is out of range`);
  }
  if (!isValidBoardIndex(boardIndex)) {
    throw new RangeError(`ultimate tic-tac-toe rules: board ${boardIndex} is out of range`);
  }

  const boards = latticeOf(state);
  const target = boards[boardIndex];
  if (target.cells[cellIndex] !== null) {
    throw new RangeError(
      `ultimate tic-tac-toe rules: cell ${cellIndex} of board ${boardIndex} is occupied`
    );
  }

  const mark = markForSeat(seat);
  target.cells[cellIndex] = mark;
  target.plies += 1;
  // `latticeOf` re-derived the control before the mark landed, so recompute it
  // now that this board changed.
  const resolved = resolveBoardControl(target.cells);
  target.control = resolved.control;
  target.winningLine = resolved.winningLine;

  const next: TicTacToeState = {
    version: state.version + 1,
    phase: "playing",
    boards,
    // The turn always hands over; a decided match simply stops reading it.
    currentTurn: otherSeat(seat),
    ply: state.ply + 1,
    winner: null,
    winningBoards: null,
    // Only a continuing match has a destination; a finished one requires none.
    nextBoard: null,
    lastMove: { seat, boardIndex, cellIndex, mark, ply: state.ply },
  };

  const boardResolved = resolved.control !== "active";
  const boardClaimed: Mark | null =
    resolved.control === "X" || resolved.control === "O" ? resolved.control : null;

  let matchCompleted = false;
  let winnerSeat: Seat | null = null;
  let winningBoards: number[] | null = null;

  // Order matters: a lattice line is checked BEFORE the full-lattice draw. The
  // move that completes a line on the very last unclaimed board is a WIN, not a
  // draw.
  const lattice = findLatticeWin(boards);
  if (lattice) {
    next.phase = "finished";
    next.winner = seatForMark(lattice.mark);
    next.winningBoards = [...lattice.line];
    matchCompleted = true;
    winnerSeat = next.winner;
    winningBoards = next.winningBoards;
  } else if (allBoardsResolved(boards)) {
    // Every mini-board resolved with no lattice line: the match is a draw, and
    // `winner` stays null.
    next.phase = "finished";
    matchCompleted = true;
  } else {
    next.nextBoard = nextBoardForCell(boards, cellIndex);
  }

  return {
    state: next,
    boardResolved,
    boardClaimed,
    matchCompleted,
    winnerSeat,
    // The line drawn on the mini-board this move was played on (null unless the
    // move completed one). For a lattice win this is the line of the FINAL
    // board; `winningBoards` is the one that highlights the lattice.
    winningLine: resolved.winningLine,
    winningBoards,
  };
}

/** The authoritative match outcome. Derived — never accepted from a client. */
export function computeMatchResult(state: TicTacToeState): {
  result: MatchResult;
  winnerSeat: Seat | null;
} {
  if (state?.winner) return { result: state.winner, winnerSeat: state.winner };
  return { result: RESULT.TIE, winnerSeat: null };
}

/** Status a match should hold given its state (finished states are terminal). */
export function statusForState(state: TicTacToeState): string {
  return state?.phase === "finished" ? MATCH_STATUS.FINISHED : MATCH_STATUS.PLAYING;
}

// ── Replay (the move log is the source of truth) ──────────────────────────

export type ReplayResult = {
  state: TicTacToeState;
  boards: (SmallBoard | null)[];
  ply: number;
  nextBoard: number | null;
  winner: Seat | null;
  winningBoards: number[] | null;
};

/**
 * Rebuild the match from an append-only move log.
 *
 * The boards are stored denormalised on the match row for cheap reads, but they
 * are ALSO a pure function of the accepted moves — this function proves it. It
 * re-runs the SAME `applyMove` the store ran, so board claims, lattice lines and
 * destinations all reconstruct exactly, with no second implementation to drift.
 *
 * The mover is the RECONSTRUCTED state's own `currentTurn` — never the logged
 * player id, so replaying does not trust the log's authorship. Moves that no
 * longer address a playable board (out of range, not the required destination,
 * a resolved board, an occupied cell) are skipped rather than throwing, so a
 * partial or duplicated log degrades instead of corrupting.
 */
export function replayMoves(moves: MoveRecord[]): ReplayResult {
  const ordered = [...(moves ?? [])].sort((a, b) => a.ply - b.ply);
  let state = createInitialState();

  for (const move of ordered) {
    if (state.phase === "finished") break;

    const boardIndex = move?.boardIndex;
    const cellIndex = move?.cellIndex;
    if (!isValidCellIndex(cellIndex) || !isValidBoardIndex(boardIndex)) continue;
    if (!isPlayableBoard(state, boardIndex)) continue;
    if (latticeOf(state)[boardIndex].cells[cellIndex] !== null) continue;

    state = applyMove({
      state,
      seat: state.currentTurn,
      boardIndex: boardIndex as number,
      cellIndex: cellIndex as number,
    }).state;
  }

  return {
    state,
    boards: state.boards,
    ply: state.ply,
    nextBoard: state.nextBoard,
    winner: state.winner,
    winningBoards: state.winningBoards,
  };
}

// ── View projection ───────────────────────────────────────────────────────

/**
 * Client-facing DTO. Adds the per-viewer flags the match page needs without
 * leaking anything the viewer is not entitled to — there is nothing hidden in
 * Ultimate Tic-Tac-Toe beyond the opponent's *future* move, which does not
 * exist yet.
 */
export function normalizeForViewer({
  state,
  seats,
  viewerId,
  status,
  result,
  winnerId,
}: {
  state: TicTacToeState;
  seats: Seats;
  viewerId: string | null;
  /**
   * The row's authoritative status. Optional so pure callers can rely on the
   * phase-derived value; the store always passes the row's status so a
   * `cancelled` lobby is never reported as `playing`.
   */
  status?: string;
  /** The row's persisted outcome (`player1` | `player2` | `tie`), if settled. */
  result?: string | null;
  /** The settled winner's user id, if any. */
  winnerId?: string | null;
}) {
  const boards = latticeOf(state);
  // A legacy blob is reported as such and NEVER offers a move: the server will
  // not accept one (the match is voided on the first attempt), so the view must
  // not pretend otherwise. The UI phase renders the notice.
  const legacyState = isExpansionEraState(state);
  const viewerSeat = seatForUser(seats, viewerId);
  const isViewerTurn =
    !legacyState && Boolean(viewerSeat) && state?.currentTurn === viewerSeat;
  // The row's status outranks the state blob: a conceded match finalises the
  // state too, but a row that is terminal must never offer a move even if a
  // legacy/partial write left the blob mid-game. This mirrors the store, which
  // checks the row's status BEFORE the state's phase.
  const effectiveStatus = status ?? statusForState(state);

  return {
    version: state?.version ?? 0,
    phase: state?.phase ?? "playing",
    status: effectiveStatus,
    // Settled outcome. Derived from the boards for a played-out match, and
    // taken from the row for a forfeit / cancellation — the client never has
    // to infer who won a conceded match. Never accepted FROM a client.
    result: result ?? null,
    winnerId: winnerId ?? null,
    // The lattice: always nine real boards now.
    boards,
    // Derived board groupings, so neither the client nor a route has to
    // re-derive "where must I play" / "which boards are done" from the lattice.
    activeBoards: activeBoardIndexes(state),
    completedBoards: completedBoardIndexes(state),
    // null means "free choice": the opponent may play any unfinished board.
    nextBoard: requiredBoardIndex(state),
    playableBoards: playableBoardIndexes(state),
    ply: state?.ply ?? 0,
    currentTurn: state?.currentTurn ?? FIRST_SEAT,
    currentTurnUserId: userIdForSeat(seats, state?.currentTurn ?? FIRST_SEAT),
    winner: state?.winner ?? null,
    winningBoards: state?.winningBoards ?? null,
    lastMove: state?.lastMove ?? null,
    // Mini-board geometry + the lattice side, so the client never hard-codes
    // either.
    boardSize: BOARD_SIZE,
    cellCount: CELL_COUNT,
    latticeSize: LATTICE_SIZE,
    maxBoards: MAX_BOARDS,
    marks: MARKS,
    player1Id: seats.player1Id,
    player2Id: seats.player2Id,
    viewerSeat,
    viewerMark: viewerSeat ? markForSeat(viewerSeat) : null,
    isViewerTurn,
    // Gated on exactly the conditions `validateMove` enforces for TURN and
    // STATUS, so the UI never offers a move the server would reject. Board and
    // cell emptiness are per-target, so the client checks them against `boards`
    // and `playableBoards` — which it already has.
    viewerCanMove:
      !legacyState &&
      effectiveStatus === MATCH_STATUS.PLAYING &&
      state?.phase === "playing" &&
      Boolean(viewerSeat) &&
      isViewerTurn,
    /**
     * True when the persisted state predates the Ultimate rules. Terminal
     * history is kept intact; a live row is voided (with its stakes refunded)
     * the first time it is touched, so a client that sees this flag should
     * treat the match as closed.
     */
    legacyState,
  };
}
