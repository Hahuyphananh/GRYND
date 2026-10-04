// src/lib/tic-tac-toe/rules.ts
//
// The pure Mega Tic-Tac-Toe rules engine. NO database, NO I/O, NO randomness —
// every function here is a deterministic transformation of the authoritative
// state, which makes the turn/move/match lifecycle unit-testable in isolation
// and keeps the API routes and the store thin.
//
// TRUST BOUNDARY: the ONLY player-authored values that reach this module are
// `boardIndex` and `cellIndex`. The mark, the boards, whose turn it is, every
// board's control, the stage, the Mega line, the tiebreak and the match result
// are all derived here. Nothing reads a client-supplied winner, result, board,
// control, stage or completion flag — no such value is ever passed in.
//
// ── THE RULES, EXACTLY ────────────────────────────────────────────────────
//
//   • Stage 1 is one ordinary 3x3 board. A normal line WINS THE MATCH; a
//     full-board draw EXPANDS to stage 2.
//   • Stages 2 and 3 play every board independently. A line decides CONTROL of
//     that one board; it never ends the match on its own.
//   • Controlling three collinear boards (a row, a column or a diagonal of the
//     lattice) all with the SAME mark wins the match immediately.
//   • A Mega line needs three boards, so a 2x2 stage 2 can never complete one:
//     once all four of its boards resolve the match expands to stage 3.
//   • When all nine stage-3 boards resolve with no Mega line, the TIEBREAK
//     decides the match; if the tiebreak is itself tied, a sudden-death 3x3
//     board is played (repeatedly, until one is won).
//
// There is no randomness anywhere: the state needs no seed, and `applyMove` is
// a pure function of (state, seat, boardIndex, cellIndex).

import {
  BOARD_SIZE,
  CELL_COUNT,
  FIRST_SEAT,
  MARKS,
  MATCH_STATUS,
  MAX_BOARDS,
  MAX_MEGA_STAGE,
  MEGA_SIZE,
  MEGA_WINNING_LINES,
  RESULT,
  STAGE_BOARD_SLOTS,
  SUDDEN_DEATH_BOARD_INDEX,
  WINNING_LINES,
} from "./constants";
import type {
  BoardControl,
  Cell,
  Mark,
  MatchResult,
  MegaStage,
  MoveRecord,
  Seat,
  Seats,
  SmallBoard,
  TicTacToeState,
  TiebreakSummary,
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

/** A fresh, empty, playable 3x3 board. */
export function createEmptyBoard(): SmallBoard {
  return { cells: emptyCells(), plies: 0, control: "active", winningLine: null };
}

/**
 * The lattice slot indices in play at `stage`, normalised to a real stage.
 * Always a NEW array, so a caller can never mutate the frozen constant.
 */
export function stageBoardSlots(stage: unknown): number[] {
  const raw = Math.trunc(Number(stage) || 1);
  const key = (raw < 1 ? 1 : raw > MAX_MEGA_STAGE ? MAX_MEGA_STAGE : raw) as 1 | 2 | 3;
  return [...STAGE_BOARD_SLOTS[key]];
}

/**
 * A fresh match. Takes no arguments at all — Mega Tic-Tac-Toe has no seed, no
 * dealt state and no randomness, so the opening position is a constant.
 *
 * Only slot 0 exists at stage 1; the other eight slots are `null` placeholders
 * that an expansion materialises in place.
 */
export function createInitialState(): TicTacToeState {
  const boards: (SmallBoard | null)[] = Array.from({ length: MAX_BOARDS }, () => null);
  boards[0] = createEmptyBoard();
  return {
    version: 1,
    phase: "playing",
    stage: 1,
    boards,
    currentTurn: FIRST_SEAT,
    ply: 0,
    winner: null,
    winningBoards: null,
    tiebreak: null,
    suddenDeath: null,
    lastMove: null,
  };
}

/**
 * Grow the match to `stage`, MATERIALISING any slot that stage adds.
 *
 * Existing boards are never touched, moved or re-indexed — this is what
 * guarantees "all existing board states are preserved" across an expansion.
 */
function advanceStage(state: TicTacToeState, stage: MegaStage): void {
  state.stage = stage;
  for (const slot of stageBoardSlots(stage)) {
    if (!state.boards[slot]) state.boards[slot] = createEmptyBoard();
  }
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
 * True when `value` is a lattice slot (0..MAX_BOARDS-1), strictly typed.
 * The sudden-death sentinel (-1) is deliberately NOT a valid slot; it is
 * addressed explicitly by `SUDDEN_DEATH_BOARD_INDEX`.
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

// ── Stage / Mega queries ──────────────────────────────────────────────────

/**
 * The Mega lines that are LIVE at `stage`: a line only counts once every one of
 * its three slots exists. At stage 2 the live set is EMPTY, which is the formal
 * reason a 2x2 can never produce a Mega winner.
 */
export function megaLinesForStage(stage: unknown): number[][] {
  const present = new Set(stageBoardSlots(stage));
  return MEGA_WINNING_LINES.filter((line) => line.every((slot) => present.has(slot))).map(
    (line) => [...line]
  );
}

/**
 * The first Mega line of three boards controlled by one mark, or null.
 *
 * Reads only each board's `control`, so a still-active or drawn slot can never
 * form a line.
 */
export function findMegaWin(
  boards: (SmallBoard | null)[],
  stage: unknown
): { mark: Mark; line: number[] } | null {
  if (!Array.isArray(boards)) return null;
  for (const line of megaLinesForStage(stage)) {
    const control = boards[line[0]]?.control;
    if (control !== "X" && control !== "O") continue;
    if (line.every((slot) => boards[slot]?.control === control)) {
      return { mark: control, line: [...line] };
    }
  }
  return null;
}

/** True once every board in play at `stage` has resolved (won or drawn). */
export function allStageBoardsResolved(boards: (SmallBoard | null)[], stage: unknown): boolean {
  return stageBoardSlots(stage).every((slot) => {
    const board = boards[slot];
    return Boolean(board) && board!.control !== "active";
  });
}

/**
 * The slots in play at the state's current stage that can STILL accept a move.
 *
 * Derived, never stored: a board is active while it exists and its `control` is
 * still "active". A locked (won or drawn) board drops out — which is exactly
 * what makes "a completed board cannot receive more moves" a property of the
 * derived board set rather than a rule the caller has to remember.
 */
export function activeBoardIndexes(state: TicTacToeState): number[] {
  return stageBoardSlots(state?.stage).filter((slot) => state.boards?.[slot]?.control === "active");
}

/** The slots in play at the state's current stage that are LOCKED (won or drawn). */
export function completedBoardIndexes(state: TicTacToeState): number[] {
  return stageBoardSlots(state?.stage).filter((slot) => {
    const board = state.boards?.[slot];
    return Boolean(board) && board!.control !== "active";
  });
}

/**
 * One board's control: a mark when it is won, "draw" when it is full with no
 * line, "active" while still playable — or null when the slot is not in play.
 */
export function boardControlAt(state: TicTacToeState, boardIndex: number): BoardControl | null {
  const board = state.boards?.[boardIndex];
  return board ? board.control : null;
}

/**
 * The final tiebreaker, evaluated only when stage 3 resolves with no Mega line.
 *
 * For EVERY resolved board it counts X's cells and O's cells; the greater count
 * controls that board, an equal count leaves it NEUTRAL. Then:
 *
 *   1. the player controlling the most boards wins;
 *   2. otherwise the player with the most cells across all nine boards wins;
 *   3. otherwise the match needs a sudden-death board (`winner: null`).
 *
 * NOTE: control here is by CELL COUNT, not by who completed a line. Because the
 * global turn order alternates while players choose WHICH board to play, a
 * single board's cells are not filled in strict X/O alternation — either mark
 * can end up with more cells on a board, so either mark can win rule 1. A board
 * with an equal count (possible for both a late X win and an O win) is neutral.
 */
export function evaluateTiebreak(boards: (SmallBoard | null)[]): TiebreakSummary {
  let xBoards = 0;
  let oBoards = 0;
  let neutralBoards = 0;
  let xCells = 0;
  let oCells = 0;

  for (const board of boards) {
    if (!board || board.control === "active") continue;
    const x = countCells(board.cells, "X");
    const o = countCells(board.cells, "O");
    xCells += x;
    oCells += o;
    if (x > o) xBoards += 1;
    else if (o > x) oBoards += 1;
    else neutralBoards += 1;
  }

  const base = { xBoards, oBoards, neutralBoards, xCells, oCells };
  if (xBoards > oBoards) {
    return { ...base, decidedBy: "boards", winner: "player1" };
  }
  if (oBoards > xBoards) {
    return { ...base, decidedBy: "boards", winner: "player2" };
  }
  if (xCells > oCells) {
    return { ...base, decidedBy: "cells", winner: "player1" };
  }
  if (oCells > xCells) {
    return { ...base, decidedBy: "cells", winner: "player2" };
  }
  return { ...base, decidedBy: "sudden-death", winner: null };
}

/** The sudden-death board currently in play, or null when there is none. */
export function currentSuddenDeathBoard(state: TicTacToeState): SmallBoard | null {
  const list = state.suddenDeath?.boards;
  if (!Array.isArray(list) || list.length === 0) return null;
  return list[list.length - 1];
}

// ── Validation ────────────────────────────────────────────────────────────

// NOTE: a single object with optional fields rather than a boolean-discriminant
// union. This repo compiles with `strict: false`, where narrowing on a boolean
// literal does not behave as expected (the same reason
// src/lib/auth/requireAgeVerified.ts returns plain objects).
export type MoveValidation = {
  ok: boolean;
  seat?: Seat;
  /** The small board the move targets, once resolved. */
  board?: SmallBoard;
  error?: string;
  status?: number;
};

/**
 * Validate a move request against the authoritative state. Everything the
 * client is NOT allowed to influence is checked here, in this order:
 *
 *   1. the match is not already finished            (409)
 *   2. the caller holds a seat                       (403)
 *   3. it is the caller's turn                       (409)
 *   4. the board index addresses a PLAYABLE board    (400 / 409)
 *   5. the cell index is a valid index               (400)
 *   6. the cell is empty                             (409)
 *   7. the client is not acting on stale state       (409)
 *
 * The participant and match-status checks live in the store (they need the
 * row), so this function only sees a caller who already holds a seat.
 *
 * Sudden death is its own addressing mode: while it is active the ONLY valid
 * `boardIndex` is `SUDDEN_DEATH_BOARD_INDEX`.
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

  // ── Which board does this move target? ─────────────────────────────────
  let target: SmallBoard | null = null;
  if (state.suddenDeath) {
    if (boardIndex !== SUDDEN_DEATH_BOARD_INDEX) {
      return {
        ok: false,
        error: "The match is in sudden death — play the sudden-death board",
        status: 409,
      };
    }
    target = currentSuddenDeathBoard(state);
    if (!target) {
      return { ok: false, error: "Match state is unavailable", status: 500 };
    }
  } else {
    if (!isValidBoardIndex(boardIndex)) {
      return {
        ok: false,
        error: `Board index must be an integer in [0, ${MAX_BOARDS - 1}]`,
        status: 400,
      };
    }
    const slot = state.boards?.[boardIndex as number] ?? null;
    if (!slot) {
      return {
        ok: false,
        error: "That board is not in play yet",
        status: 409,
      };
    }
    if (slot.control !== "active") {
      return { ok: false, error: "That board is already locked", status: 409 };
    }
    target = slot;
  }

  if (!isWellFormedBoard(target.cells)) {
    return { ok: false, error: "Match state is unavailable", status: 500 };
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

  if (target.cells[index] !== null) {
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

  return { ok: true, seat, board: target };
}

// ── Progression ───────────────────────────────────────────────────────────

export type AppliedMove = {
  state: TicTacToeState;
  /** True when this move resolved the small board it was played on. */
  boardResolved: boolean;
  /** True when this move expanded the match to the next stage. */
  stageAdvanced: boolean;
  /** The stage the match expanded INTO (only when `stageAdvanced`). */
  stage: MegaStage;
  matchCompleted: boolean;
  winnerSeat: Seat | null;
  /** The small board's winning line, when this move resolved that board. */
  winningLine: number[] | null;
  /** The three Mega slots that won, when the win was a Mega line. */
  winningBoards: number[] | null;
  /** The tiebreak, when it was the thing that decided the match. */
  tiebreak: TiebreakSummary | null;
  /** True when this move began or advanced sudden death. */
  suddenDeath: boolean;
};

function cloneBoard(board: SmallBoard): SmallBoard {
  return {
    cells: [...board.cells],
    plies: board.plies,
    control: board.control,
    winningLine: board.winningLine ? [...board.winningLine] : null,
  };
}

function cloneState(state: TicTacToeState): TicTacToeState {
  return {
    version: state.version,
    phase: state.phase,
    stage: state.stage,
    boards: state.boards.map((board) => (board ? cloneBoard(board) : null)),
    currentTurn: state.currentTurn,
    ply: state.ply,
    winner: state.winner,
    winningBoards: state.winningBoards ? [...state.winningBoards] : null,
    tiebreak: state.tiebreak ? { ...state.tiebreak } : null,
    suddenDeath: state.suddenDeath ? { boards: state.suddenDeath.boards.map(cloneBoard) } : null,
    lastMove: state.lastMove ? { ...state.lastMove } : null,
  };
}

/**
 * Apply one validated move and run every downstream transition: place the mark,
 * resolve the small board, advance the stage, detect a Mega line, evaluate the
 * tiebreak, and hand the turn on if the match continues.
 *
 * Assumes the move already passed `validateMove` — it does not re-check
 * legality. It derives the mark from the SEAT (never from the caller), so a
 * client cannot place the wrong mark.
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
  if (!isValidCellIndex(cellIndex)) {
    throw new RangeError(`mega tic-tac-toe rules: cell ${cellIndex} is out of range`);
  }
  if (boardIndex !== SUDDEN_DEATH_BOARD_INDEX && !isValidBoardIndex(boardIndex)) {
    throw new RangeError(`mega tic-tac-toe rules: board ${boardIndex} is out of range`);
  }

  const next = cloneState(state);
  const onSuddenDeath = boardIndex === SUDDEN_DEATH_BOARD_INDEX;

  let target: SmallBoard;
  if (onSuddenDeath) {
    const current = currentSuddenDeathBoard(next);
    if (!current) {
      throw new RangeError("mega tic-tac-toe rules: no sudden-death board");
    }
    target = current;
  } else {
    const slot = next.boards[boardIndex];
    if (!slot) {
      throw new RangeError(`mega tic-tac-toe rules: board ${boardIndex} is not in play`);
    }
    target = slot;
  }

  const mark = markForSeat(seat);
  target.cells[cellIndex] = mark;
  target.plies += 1;
  const resolved = resolveBoardControl(target.cells);
  target.control = resolved.control;
  target.winningLine = resolved.winningLine;

  next.version = state.version + 1;
  next.ply = state.ply + 1;
  // The turn always hands over; a decided match simply stops reading it.
  next.currentTurn = otherSeat(seat);
  next.lastMove = { seat, boardIndex, cellIndex, mark, ply: state.ply };

  const boardResolved = resolved.control !== "active";
  let stageAdvanced = false;
  let matchCompleted = false;
  let winnerSeat: Seat | null = null;
  let winningBoards: number[] | null = null;
  let tiebreak: TiebreakSummary | null = null;
  let suddenDeath = false;

  const finishWith = (winner: Seat, line: number[] | null) => {
    next.phase = "finished";
    next.winner = winner;
    next.winningBoards = line;
    matchCompleted = true;
    winnerSeat = winner;
    winningBoards = line;
  };

  if (onSuddenDeath) {
    // A sudden-death board is an ordinary 3x3 board: a line wins the match, and
    // a draw simply starts the next one.
    if (resolved.control === "X" || resolved.control === "O") {
      finishWith(seatForMark(resolved.control), null);
    } else if (resolved.control === "draw") {
      next.suddenDeath!.boards.push(createEmptyBoard());
      next.currentTurn = FIRST_SEAT;
      suddenDeath = true;
    }
  } else if (state.stage === 1) {
    // Stage 1 IS the match: a line wins it outright, a draw expands it.
    if (resolved.control === "X" || resolved.control === "O") {
      finishWith(seatForMark(resolved.control), [0]);
    } else if (resolved.control === "draw") {
      advanceStage(next, 2);
      stageAdvanced = true;
    }
  } else {
    const mega = findMegaWin(next.boards, next.stage);
    if (mega) {
      finishWith(seatForMark(mega.mark), mega.line);
    } else if (allStageBoardsResolved(next.boards, next.stage)) {
      if (next.stage === 2) {
        // A 2x2 can never complete a Mega line, so a resolved stage 2 always
        // expands to the full lattice.
        advanceStage(next, 3);
        stageAdvanced = true;
      } else {
        const summary = evaluateTiebreak(next.boards);
        next.tiebreak = summary;
        tiebreak = summary;
        if (summary.winner) {
          finishWith(summary.winner, null);
        } else {
          next.suddenDeath = { boards: [createEmptyBoard()] };
          next.currentTurn = FIRST_SEAT;
          suddenDeath = true;
        }
      }
    }
  }

  return {
    state: next,
    boardResolved,
    stageAdvanced,
    stage: next.stage,
    matchCompleted,
    winnerSeat,
    // The line drawn on the small board this move was played on (null unless
    // the move completed one). For a Mega win this is the line of the FINAL
    // board; `winningBoards` is the one that highlights the lattice.
    winningLine: resolved.winningLine,
    winningBoards,
    tiebreak,
    suddenDeath,
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
  stage: MegaStage;
  ply: number;
  winner: Seat | null;
  winningBoards: number[] | null;
  tiebreak: TiebreakSummary | null;
};

/**
 * Rebuild the match from an append-only move log.
 *
 * The boards are stored denormalised on the match row for cheap reads, but they
 * are ALSO a pure function of the accepted moves — this function proves it. It
 * re-runs the SAME `applyMove` the store ran, so stage expansions, Mega lines
 * and the tiebreak all reconstruct exactly, with no second implementation to
 * drift.
 *
 * The mover is the RECONSTRUCTED state's own `currentTurn` — never the logged
 * player id, so replaying does not trust the log's authorship. That matters
 * beyond tidiness: a sudden death RESETS the turn to X, which global ply parity
 * cannot express, so deriving it from the running state is the only way replay
 * reproduces a sudden-death sequence exactly. Moves that no longer address a
 * playable board (or that replay into an occupied cell) are skipped rather than
 * throwing, so a partial or duplicated log degrades instead of corrupting.
 */
export function replayMoves(moves: MoveRecord[]): ReplayResult {
  const ordered = [...(moves ?? [])].sort((a, b) => a.ply - b.ply);
  let state = createInitialState();

  for (const move of ordered) {
    if (state.phase === "finished") break;

    const boardIndex = Number(move?.boardIndex);
    const cellIndex = Number(move?.cellIndex);
    if (!isValidCellIndex(cellIndex)) continue;

    let target: SmallBoard | null;
    if (boardIndex === SUDDEN_DEATH_BOARD_INDEX) {
      target = currentSuddenDeathBoard(state);
    } else if (isValidBoardIndex(boardIndex)) {
      const slot = state.boards[boardIndex] ?? null;
      target = slot && slot.control === "active" ? slot : null;
    } else {
      target = null;
    }
    if (!target || target.cells[cellIndex] !== null) continue;

    state = applyMove({
      state,
      seat: state.currentTurn,
      boardIndex,
      cellIndex,
    }).state;
  }

  return {
    state,
    boards: state.boards,
    stage: state.stage,
    ply: state.ply,
    winner: state.winner,
    winningBoards: state.winningBoards,
    tiebreak: state.tiebreak,
  };
}

// ── View projection ───────────────────────────────────────────────────────

/**
 * Client-facing DTO. Adds the per-viewer flags the match page needs without
 * leaking anything the viewer is not entitled to — there is nothing hidden in
 * Mega Tic-Tac-Toe beyond the opponent's *future* move, which does not exist
 * yet.
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
  // ── Transitional single-board projection ─────────────────────────────
  // A Mega match is a lattice of boards; the single-board UI is being
  // redesigned separately. Until it is, project ONE board as `board` /
  // `winningLine` so the existing view keeps rendering the opening position
  // correctly and never crashes. This is NOT authoritative state — it is a
  // convenience view of `boards[boardIndex]`, and the authoritative source is
  // always the full `boards` lattice below.
  const focusBoardIndex = activeBoardIndexes(state)[0] ?? stageBoardSlots(state.stage)[0] ?? 0;
  const focusBoard = state.boards?.[focusBoardIndex] ?? null;
  // The row's status outranks the state blob: a conceded match finalises the
  // state too, but a row that is terminal must never offer a move even if a
  // legacy/partial write left the blob mid-game. This mirrors the store, which
  // checks the row's status BEFORE the state's phase.
  const effectiveStatus = status ?? statusForState(state);

  return {
    version: state.version,
    phase: state.phase,
    status: effectiveStatus,
    // Settled outcome. Derived from the boards for a played-out match, and
    // taken from the row for a forfeit / cancellation — the client never has
    // to infer who won a conceded match. Never accepted FROM a client.
    result: result ?? null,
    winnerId: winnerId ?? null,
    // The lattice (length 9; `null` slots are not yet in play).
    boards: state.boards,
    stage: state.stage,
    // ── Transitional single-board projection (see above) ────────────────
    // `boardIndex` is the slot the legacy view should offer, `board` its
    // nine cells and `winningLine` its completed line. A redesigned UI reads
    // `boards` / `winningBoards` instead; these carry no authority.
    boardIndex: focusBoardIndex,
    board: focusBoard ? focusBoard.cells : Array.from({ length: CELL_COUNT }, () => null),
    winningLine: focusBoard ? focusBoard.winningLine : null,
    // The slots in play at this stage, so the view never renders a slot that
    // does not exist yet.
    stageBoardSlots: stageBoardSlots(state.stage),
    // Derived board groupings, so neither the client nor a route has to re-derive
    // "which boards can I still play" / "which are done" from the raw lattice.
    activeBoards: activeBoardIndexes(state),
    completedBoards: completedBoardIndexes(state),
    ply: state.ply,
    currentTurn: state.currentTurn,
    currentTurnUserId: userIdForSeat(seats, state.currentTurn),
    winner: state.winner,
    winningBoards: state.winningBoards,
    tiebreak: state.tiebreak,
    suddenDeath: state.suddenDeath ? { boards: state.suddenDeath.boards } : null,
    lastMove: state.lastMove,
    // Small-board geometry + the lattice side, so the client never hard-codes
    // either.
    boardSize: BOARD_SIZE,
    cellCount: CELL_COUNT,
    megaSize: MEGA_SIZE,
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
    // — which it already has.
    viewerCanMove:
      effectiveStatus === MATCH_STATUS.PLAYING &&
      state.phase === "playing" &&
      Boolean(viewerSeat) &&
      isViewerTurn,
  };
}
