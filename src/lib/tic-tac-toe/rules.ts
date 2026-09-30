// src/lib/tic-tac-toe/rules.ts
//
// The pure Tic-Tac-Toe Duel rules engine. NO database, NO I/O, NO randomness —
// every function here is a deterministic transformation of the authoritative
// state, which makes the turn/move/match lifecycle unit-testable in isolation
// and keeps the API routes and the store thin.
//
// TRUST BOUNDARY: the ONLY player-authored value that reaches this module is
// `cellIndex`. The mark, the board, whose turn it is, the winner, the draw and
// the match result are all derived here. Nothing in this file reads a
// client-supplied winner, result, score, turn, board or completion flag,
// because no such value is ever passed in.
//
// There is no randomness anywhere: the state needs no seed, and `applyMove` is
// a pure function of (state, seat, cellIndex).

import {
  BOARD_SIZE,
  CELL_COUNT,
  FIRST_SEAT,
  MARKS,
  MATCH_STATUS,
  RESULT,
  WINNING_LINES,
} from "./constants";
import type {
  Cell,
  Mark,
  MatchResult,
  Seat,
  Seats,
  TicTacToeState,
  MoveRecord,
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
export function seatsFromMatch(match: {
  player1Id: string;
  player2Id?: string | null;
}): Seats {
  return { player1Id: match.player1Id, player2Id: match.player2Id ?? null };
}

// ── Construction ──────────────────────────────────────────────────────────

function emptyBoard(): Cell[] {
  return Array.from({ length: CELL_COUNT }, () => null);
}

/**
 * A fresh match. Takes no arguments at all — tic-tac-toe has no seed, no
 * course and no dealt state, so the opening position is a constant.
 */
export function createInitialState(): TicTacToeState {
  return {
    version: 1,
    phase: "playing",
    board: emptyBoard(),
    currentTurn: FIRST_SEAT,
    ply: 0,
    winner: null,
    winningLine: null,
    lastMove: null,
  };
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
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < CELL_COUNT
  );
}

/**
 * The first completed line, or null.
 *
 * Enumerates all eight lines rather than scanning incrementally, so a win is
 * detected identically no matter which move completed it.
 */
export function findWinningLine(
  board: Cell[],
): { mark: Mark; line: number[] } | null {
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
  return Array.isArray(board) && board.length === CELL_COUNT && board.every((cell) => cell !== null);
}

// ── Validation ────────────────────────────────────────────────────────────

// NOTE: a single object with optional fields rather than a boolean-discriminant
// union. This repo compiles with `strict: false`, where narrowing on a boolean
// literal does not behave as expected (the same reason
// src/lib/auth/requireAgeVerified.ts returns plain objects).
export type MoveValidation = {
  ok: boolean;
  seat?: Seat;
  error?: string;
  status?: number;
};

/**
 * Validate a move request against the authoritative state. Everything the
 * client is NOT allowed to influence is checked here, in this order:
 *
 *   1. the match is not already finished
 *   2. the caller holds a seat          (403)
 *   3. it is the caller's turn          (409)
 *   4. the cell index is a valid index  (400)
 *   5. the cell is empty                (409)
 *   6. the client is not acting on stale state (409)
 *
 * The participant and match-status checks live in the store (they need the
 * row), so this function only sees a caller who already holds a seat.
 */
export function validateMove({
  state,
  seat,
  cellIndex,
  expectedVersion,
}: {
  state: TicTacToeState;
  seat: Seat | null;
  cellIndex: unknown;
  expectedVersion?: unknown;
}): MoveValidation {
  if (!state || typeof state !== "object") {
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

  // Strict type check, not a Number() coercion: `Number("")`, `Number(true)`
  // and `Number([])` are all 0, which would let a malformed body through as a
  // silent "place at cell 0".
  if (!isValidCellIndex(cellIndex)) {
    return {
      ok: false,
      error: `Cell index must be an integer in [0, ${CELL_COUNT - 1}]`,
      status: 400,
    };
  }
  const index = cellIndex as number;

  if (!isWellFormedBoard(state.board)) {
    return { ok: false, error: "Match state is unavailable", status: 500 };
  }
  if (state.board[index] !== null) {
    return { ok: false, error: "Cell is already occupied", status: 409 };
  }

  // Optimistic concurrency: the client must prove it is acting on the state it
  // was shown, so a double-submit or a stale tab cannot apply a second move.
  //
  // The token is checked STRICTLY, mirroring the cell-index check above: a
  // boolean, a numeric string or a non-integer (all of which `Number()` would
  // coerce, so `true`/"1"/[1]/1.9 would otherwise read as version 1) is
  // refused rather than silently accepted as the client's version.
  if (expectedVersion !== undefined && expectedVersion !== null) {
    if (
      typeof expectedVersion !== "number" ||
      !Number.isInteger(expectedVersion) ||
      expectedVersion !== state.version
    ) {
      return { ok: false, error: "Stale match state", status: 409 };
    }
  }

  return { ok: true, seat };
}

// ── Progression ───────────────────────────────────────────────────────────

export type AppliedMove = {
  state: TicTacToeState;
  matchCompleted: boolean;
  winnerSeat: Seat | null;
  winningLine: number[] | null;
  draw: boolean;
};

/**
 * Apply one validated move and run every downstream transition: place the mark,
 * advance the ply, detect a win, detect a draw, and hand the turn on if the
 * match continues.
 *
 * Assumes the move already passed `validateMove` — it does not re-check
 * legality. It derives the mark from the SEAT (never from the caller), so a
 * client cannot place the wrong mark.
 */
export function applyMove({
  state,
  seat,
  cellIndex,
}: {
  state: TicTacToeState;
  seat: Seat;
  cellIndex: number;
}): AppliedMove {
  if (!isValidCellIndex(cellIndex)) {
    throw new RangeError(`tic-tac-toe rules: cell ${cellIndex} is out of range`);
  }

  const next: TicTacToeState = {
    ...state,
    board: [...state.board],
  };

  const movePly = state.ply;
  const mark = markForSeat(seat);

  next.board[cellIndex] = mark;
  next.version = state.version + 1;
  next.ply = movePly + 1;
  next.lastMove = { seat, cellIndex, mark, ply: movePly };

  const win = findWinningLine(next.board);

  if (win) {
    next.winner = seatForMark(win.mark);
    next.winningLine = win.line;
    next.phase = "finished";
    // `currentTurn` is deliberately left on the mover: once the match is
    // finished there is no next turn, and leaving it on the seat that just
    // acted keeps the field pointing at something real rather than at an
    // arbitrary seat derived from a completed ply count.
  } else if (isBoardFull(next.board)) {
    next.winner = null;
    next.winningLine = null;
    next.phase = "finished";
  } else {
    next.currentTurn = otherSeat(seat);
  }

  const matchCompleted = next.phase === "finished";
  return {
    state: next,
    matchCompleted,
    winnerSeat: next.winner,
    winningLine: next.winningLine,
    draw: matchCompleted && next.winner === null,
  };
}

/** The authoritative match outcome. Derived — never accepted from a client. */
export function computeMatchResult(state: TicTacToeState): {
  result: MatchResult;
  winnerSeat: Seat | null;
} {
  if (state.winner) return { result: state.winner, winnerSeat: state.winner };
  return { result: RESULT.TIE, winnerSeat: null };
}

/** Status a match should hold given its state (finished states are terminal). */
export function statusForState(state: TicTacToeState): string {
  return state.phase === "finished" ? MATCH_STATUS.FINISHED : MATCH_STATUS.PLAYING;
}

// ── Replay (the move log is the source of truth) ──────────────────────────

/**
 * Rebuild the board from an append-only move log.
 *
 * The board is stored denormalised on the match row for cheap reads, but it is
 * ALSO a pure function of the accepted moves — this function proves it. It is
 * used by the test suite to assert that `game_state` can never disagree with
 * `tic_tac_toe_moves`, and could be used as a runtime consistency check without
 * changing the storage model.
 *
 * Marks are assigned by ply parity (X on even plies), so replaying does not
 * depend on trusting the logged player ids.
 */
export function replayMoves(moves: MoveRecord[]): {
  board: Cell[];
  ply: number;
  winner: Seat | null;
  winningLine: number[] | null;
  draw: boolean;
} {
  const ordered = [...(moves ?? [])].sort((a, b) => a.ply - b.ply);
  const board = emptyBoard();
  let ply = 0;

  for (const move of ordered) {
    if (ply >= CELL_COUNT) break;
    if (!isValidCellIndex(move?.cellIndex)) continue;
    if (board[move.cellIndex] !== null) continue;
    board[move.cellIndex] = markForSeat(seatForPly(ply));
    ply += 1;
  }

  const win = findWinningLine(board);
  if (win) {
    return {
      board,
      ply,
      winner: seatForMark(win.mark),
      winningLine: [...win.line],
      draw: false,
    };
  }
  return {
    board,
    ply,
    winner: null,
    winningLine: null,
    draw: ply === CELL_COUNT,
  };
}

// ── View projection ───────────────────────────────────────────────────────

/**
 * Client-facing DTO. Adds the per-viewer flags the match page needs without
 * leaking anything the viewer is not entitled to — there is nothing hidden in
 * tic-tac-toe beyond the opponent's *future* move, which does not exist yet.
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
  const viewerSeat = seatForUser(seats, viewerId);
  const isViewerTurn = Boolean(viewerSeat) && state.currentTurn === viewerSeat;
  // The row's status outranks the state blob: a conceded match finalises the
  // state too, but a row that is terminal must never offer a move even if a
  // legacy/partial write left the blob mid-game. This mirrors the store, which
  // checks the row's status BEFORE the state's phase.
  const effectiveStatus = status ?? statusForState(state);

  return {
    version: state.version,
    phase: state.phase,
    status: effectiveStatus,
    // Settled outcome. Derived from the board for a played-out match, and taken
    // from the row for a forfeit / cancellation — the client never has to infer
    // who won a conceded match. Never accepted FROM a client.
    result: result ?? null,
    winnerId: winnerId ?? null,
    board: state.board,
    ply: state.ply,
    currentTurn: state.currentTurn,
    currentTurnUserId: userIdForSeat(seats, state.currentTurn),
    winner: state.winner,
    winningLine: state.winningLine,
    lastMove: state.lastMove,
    boardSize: BOARD_SIZE,
    player1Id: seats.player1Id,
    player2Id: seats.player2Id,
    viewerSeat,
    viewerMark: viewerSeat ? markForSeat(viewerSeat) : null,
    isViewerTurn,
    // Gated on exactly the conditions `validateMove` enforces, so the UI never
    // offers a move the server would reject. Cell emptiness is per-cell, so the
    // client checks the target cell against `board` — which it already has.
    viewerCanMove:
      effectiveStatus === MATCH_STATUS.PLAYING &&
      state.phase === "playing" &&
      Boolean(viewerSeat) &&
      isViewerTurn,
  };
}
