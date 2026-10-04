// src/lib/tic-tac-toe/ui.ts
//
// Pure client-side helpers for the Tic-Tac-Toe Duel views.
//
// Everything here is a deterministic function of its arguments — no DOM, no
// React, no fetch — so the board affordances, the turn copy and the
// result mapping can be unit-tested directly and shared between the board
// component and the match controls.
//
// IMPORTANT: nothing in this module is authoritative. It only decides what the
// player SEES and what they are OFFERED. The board, whose turn it is, the
// winner and the draw always come from the server snapshot — this file never
// computes a move, a winner or a result of its own.

import {
  CELL_COUNT,
  BOARD_SIZE,
  MATCH_STATUS,
  MAX_BOARDS,
  MEGA_SIZE,
  RESULT,
  STAGE_BOARD_SLOTS,
  SUDDEN_DEATH_BOARD_INDEX,
} from "./constants";
import type { BoardControl, Cell, Mark, Seat, TiebreakSummary } from "./types";

// ── Seat colours (the duotone every GRYND 1v1 match view uses) ────────────

export const SEAT_COLORS = {
  player1: "#f59e0b",
  player2: "#22d3ee",
} as const;

/** Colour for a seat, or the neutral fallback for an unknown viewer. */
export function seatColor(seat: string | null | undefined): string {
  if (seat === "player1") return SEAT_COLORS.player1;
  if (seat === "player2") return SEAT_COLORS.player2;
  return "#94a3b8";
}

/**
 * The mark a seat plays.
 *
 * X is player1 because X moves first and the first seat is player1 — one colour
 * per player across the entire screen (seat card, pips, board marks and the
 * winning line all use `seatColor`), so "the amber player" and "the X player"
 * are always the same person.
 */
export function markForSeat(seat: Seat | null | undefined): Mark | null {
  if (seat === "player1") return "X";
  if (seat === "player2") return "O";
  return null;
}

/** The seat that plays `mark`. */
export function seatForMark(mark: Mark | null | undefined): Seat | null {
  if (mark === "X") return "player1";
  if (mark === "O") return "player2";
  return null;
}

/** "You" / "Opponent" — never invents a name the server did not send. */
export function seatLabel(seat: Seat | null | undefined, viewerSeat: Seat | null): string {
  if (!seat) return "—";
  if (!viewerSeat) return seat === "player1" ? "Player 1" : "Player 2";
  return seat === viewerSeat ? "You" : "Opponent";
}

// ── Board helpers ─────────────────────────────────────────────────────────

/** True when `value` is a playable board index (0..8). */
export function isBoardIndex(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < CELL_COUNT
  );
}

/** The nine cells of a snapshot, normalised to null/Cell. */
export function normaliseBoard(board: unknown): Cell[] {
  if (!Array.isArray(board) || board.length !== CELL_COUNT) {
    return Array.from({ length: CELL_COUNT }, () => null);
  }
  return board.map((cell) => (cell === "X" || cell === "O" ? cell : null));
}

/**
 * Whether a cell should be OFFERED to the viewer.
 *
 * Mirrors the conditions the server enforces (`validateMove`): the match must
 * be live, it must be the viewer's turn, and the cell must be empty. The board
 * is the server's, so this can never disagree with what the server will accept
 * — and a click on a cell this returns false for is still rejected server-side.
 */
export function isCellPlayable({
  board,
  cellIndex,
  viewerCanMove,
}: {
  board: unknown;
  cellIndex: number;
  viewerCanMove: boolean;
}): boolean {
  if (!viewerCanMove) return false;
  if (!isBoardIndex(cellIndex)) return false;
  const cells = normaliseBoard(board);
  return cells[cellIndex] === null;
}

/** The winning cells as a lookup, for the highlight. */
export function winningCellSet(winningLine: unknown): Set<number> {
  if (!Array.isArray(winningLine)) return new Set();
  return new Set(winningLine.filter(isBoardIndex));
}

/** The 0-based index of the last accepted move, or -1. */
export function lastMoveCellIndex(lastMove: unknown): number {
  const index = (lastMove as { cellIndex?: unknown } | null)?.cellIndex;
  return isBoardIndex(index) ? (index as number) : -1;
}

/** How many marks are on the board — the server's ply, clamped. */
export function filledCount(board: unknown): number {
  return normaliseBoard(board).filter((cell) => cell !== null).length;
}

/** "3 of 9 cells played". */
export function progressLabel(board: unknown): string {
  return `${filledCount(board)} of ${CELL_COUNT} cells played`;
}

/** Board geometry, re-exported so the component and tests agree. */
export const GRID_SIZE = BOARD_SIZE;

// ── The Mega lattice ──────────────────────────────────────────────────────
//
// Mega Tic-Tac-Toe is a lattice of up to nine 3x3 boards. EVERYTHING below is
// a pure projection of the server snapshot: the lattice, each board's control,
// the round (stage), which slots are in play and which boards the Mega line
// highlights all arrive in the DTO. Nothing here recomputes a line, a winner
// or a turn — it only normalises the server's values into render-friendly
// shapes and gives the view geometry for the fixed 3x3 lattice.

/** A server board, normalised for rendering. */
export type NormalisedBoard = {
  /** Nine cells of "X" | "O" | null. */
  cells: Cell[];
  /** The SERVER's control for this board ("active" | "draw" | "X" | "O"). */
  control: BoardControl;
  /** The SERVER's winning cell line for this board, or null. */
  winningLine: number[] | null;
};

const BOARD_CONTROLS = new Set<string>(["X", "O", "draw", "active"]);

/** Normalise the server's one small board into a render shape. */
function normaliseServerBoard(raw: unknown): NormalisedBoard | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as { cells?: unknown; control?: unknown; winningLine?: unknown };
  const control = BOARD_CONTROLS.has(String(source.control))
    ? (source.control as BoardControl)
    : "active";
  return {
    cells: normaliseBoard(source.cells),
    control,
    winningLine: Array.isArray(source.winningLine)
      ? source.winningLine.map(Number).filter(isBoardIndex)
      : null,
  };
}

/**
 * The whole lattice, always length nine. A `null` slot is one the server has
 * not materialised yet (a later round owns it), exactly as the DTO reports it.
 */
export function normaliseLattice(lattice: unknown): (NormalisedBoard | null)[] {
  const source = Array.isArray(lattice) ? lattice : [];
  return Array.from({ length: MAX_BOARDS }, (_, slot) => normaliseServerBoard(source[slot]));
}

/** A list of slot indices, filtered to real slots, de-duplicated and sorted. */
export function normaliseSlotList(list: unknown): number[] {
  if (!Array.isArray(list)) return [];
  const out: number[] = [];
  for (const value of list) {
    const slot = Number(value);
    if (Number.isInteger(slot) && slot >= 0 && slot < MAX_BOARDS && !out.includes(slot)) {
      out.push(slot);
    }
  }
  return out.sort((a, b) => a - b);
}

/** The round (stage), clamped to 1..3. */
export function normaliseStage(stage: unknown): 1 | 2 | 3 {
  const raw = Math.trunc(Number(stage));
  if (!Number.isFinite(raw) || raw < 1) return 1;
  if (raw > 3) return 3;
  return raw as 1 | 2 | 3;
}

/** The slots in play at `stage`, from the shared constant (never guessed). */
export function stageSlots(stage: unknown): number[] {
  return [...STAGE_BOARD_SLOTS[normaliseStage(stage)]];
}

/** How many columns the lattice lays out at `stage`: 1, 2 then 3. */
export function stageColumns(stage: unknown): number {
  return normaliseStage(stage);
}

/** How many boards are in play at `stage`: 1, 4 then 9. */
export function stageBoardCount(stage: unknown): number {
  return stageSlots(stage).length;
}

/** The total cell budget of every board in play at `stage`. */
export function roundCellBudget(stage: unknown): number {
  return stageBoardCount(stage) * CELL_COUNT;
}

/** "Round 1" / "Round 2" / "Round 3". */
export function roundLabel(stage: unknown): string {
  return `Round ${normaliseStage(stage)}`;
}

/** A short name for the round's shape. */
export function roundName(stage: unknown): string {
  const n = normaliseStage(stage);
  if (n === 1) return "Single board";
  if (n === 2) return "2×2 expansion";
  return "3×3 Mega";
}

/** One sentence describing what the round adds. */
export function roundBlurb(stage: unknown): string {
  const n = normaliseStage(stage);
  if (n === 1) return "Win the board, or draw it to expand the match.";
  if (n === 2) return "Four boards. A draw on all four expands to the full lattice.";
  return "Nine boards. Control three in a line to win the match.";
}

/** A per-board label for the status chip under a board's name. */
export function boardControlLabel(control: unknown): string {
  if (control === "X" || control === "O") return `${control} controls`;
  if (control === "draw") return "Draw — locked";
  if (control === "active") return "Open";
  return "—";
}

/** A concise control tag for a badge: "X" | "O" | "Draw" | "Open". */
export function boardControlShort(control: unknown): string {
  if (control === "X" || control === "O") return String(control);
  if (control === "draw") return "Draw";
  if (control === "active") return "Open";
  return "—";
}

/** True when a board can no longer accept moves (won or drawn). */
export function boardIsResolved(control: unknown): boolean {
  return control === "X" || control === "O" || control === "draw";
}

/** The seat that owns a controlled board, or null for an open / drawn board. */
export function boardOwnerSeat(control: unknown): Seat | null {
  return seatForMark(control as Mark | null | undefined);
}

/**
 * Where a lattice slot sits in the RENDERED grid at `stage`.
 *
 * The lattice is fixed 3x3, but Round 2 only shows the top-left 2x2, so the
 * display grid re-flows: the slots in play are laid out row-major against the
 * stage's column count. Purely presentational geometry — it never changes a
 * slot's index.
 */
export function slotGridPosition(
  slot: number,
  stage: unknown,
): { row: number; col: number; rows: number; cols: number } {
  const slots = stageSlots(stage);
  const cols = stageColumns(stage);
  const index = Math.max(0, slots.indexOf(slot));
  const rows = Math.max(1, Math.ceil(slots.length / cols));
  return { row: Math.floor(index / cols), col: index % cols, rows, cols };
}

/** The three Mega slots the win highlighted, as a lookup. */
export function megaWinningSlotSet(winningBoards: unknown): Set<number> {
  return new Set(normaliseSlotList(winningBoards).slice(0, 3));
}

/** Control counts across the boards in play — a legend, never a decision. */
export function megaControlCounts(
  lattice: (NormalisedBoard | null)[],
  slots: number[],
): { x: number; o: number; draw: number; active: number; resolved: number } {
  let x = 0;
  let o = 0;
  let draw = 0;
  let active = 0;
  for (const slot of slots) {
    const board = lattice[slot];
    if (!board) continue;
    if (board.control === "X") x += 1;
    else if (board.control === "O") o += 1;
    else if (board.control === "draw") draw += 1;
    else active += 1;
  }
  return { x, o, draw, active, resolved: x + o + draw };
}

/** Every sudden-death board, in play order, normalised for rendering. */
export function normaliseSuddenDeath(value: unknown): NormalisedBoard[] {
  const boards = (value as { boards?: unknown } | null)?.boards;
  if (!Array.isArray(boards)) return [];
  return boards
    .map((raw) => normaliseServerBoard(raw))
    .filter((board): board is NormalisedBoard => board !== null);
}

/**
 * The server board a move targets, or null when the address is not in play.
 *
 * Sudden death is its own addressing mode: `SUDDEN_DEATH_BOARD_INDEX` (-1)
 * resolves to the LAST sudden-death board, exactly as the store's engine does.
 */
export function serverBoardAt(match: any, boardIndex: number): NormalisedBoard | null {
  if (!match) return null;
  if (boardIndex === SUDDEN_DEATH_BOARD_INDEX) {
    const boards = normaliseSuddenDeath(match.suddenDeath);
    return boards.length ? boards[boards.length - 1] : null;
  }
  return normaliseLattice(match.boards)[boardIndex] ?? null;
}

/** Mega lattice geometry, re-exported so the component and tests agree. */
export const MEGA_GRID_SIZE = MEGA_SIZE;

// ── Tiebreak / result presentation ────────────────────────────────────────
//
// The tiebreak summary is DERIVED server-side and arrives in the DTO. These
// helpers only turn it into the copy the view shows — they never recompute the
// outcome. The wording mirrors the shared vocabulary of the engine: board
// control, then cell control, then sudden death.

/** One display row of the tiebreak summary. */
export type ResultRow = { label: string; value: string };

/** The headline for a tiebreak: BOARD CONTROL · CELL CONTROL · SUDDEN DEATH. */
export function tiebreakHeading(tiebreak: unknown): string {
  const decidedBy = (tiebreak as { decidedBy?: unknown } | null)?.decidedBy;
  if (decidedBy === "cells") return "CELL CONTROL";
  if (decidedBy === "sudden-death") return "SUDDEN DEATH";
  return "BOARD CONTROL";
}

/** The mark that won the tiebreak, or null (a complete tie → sudden death). */
export function tiebreakWinnerMark(tiebreak: unknown): Mark | null {
  const winner = (tiebreak as { winner?: unknown } | null)?.winner;
  if (winner === "player1") return "X";
  if (winner === "player2") return "O";
  return null;
}

/**
 * The tiebreak's body rows, in the exact vocabulary of the result summary:
 *
 *   BOARD CONTROL   Player X: 5 boards · Player O: 4 boards · Winner: X
 *   CELL CONTROL    Player X: 31 cells · Player O: 29 cells · Winner: X
 *   SUDDEN DEATH    a complete tie — the match goes to sudden death
 */
export function tiebreakRows(tiebreak: unknown): ResultRow[] {
  const summary = tiebreak as TiebreakSummary | null | undefined;
  if (!summary) return [];
  if (summary.decidedBy === "sudden-death") {
    return [
      { label: "Result", value: "Board control and cell control are level" },
      { label: "Next", value: "Sudden death" },
    ];
  }
  const byCells = summary.decidedBy === "cells";
  const unit = byCells ? "cells" : "boards";
  const x = byCells ? summary.xCells : summary.xBoards;
  const o = byCells ? summary.oCells : summary.oBoards;
  const mark = tiebreakWinnerMark(summary);
  return [
    { label: "Player X", value: `${x} ${unit}` },
    { label: "Player O", value: `${o} ${unit}` },
    { label: "Winner", value: mark ?? "—" },
  ];
}

/** A one-line description of how a finished match was decided. */
export function resultReason({
  winningBoards,
  tiebreak,
  ply,
}: {
  winningBoards?: unknown;
  tiebreak?: unknown;
  ply?: unknown;
}): string {
  if (Array.isArray(winningBoards) && winningBoards.length === 3) {
    return `Mega line — Boards ${winningBoards.map((slot) => Number(slot) + 1).join(" · ")}`;
  }
  const summary = tiebreak as TiebreakSummary | null | undefined;
  if (summary && summary.decidedBy !== "sudden-death") {
    return `${tiebreakHeading(summary)} — decided on ${
      summary.decidedBy === "cells" ? "cells" : "boards"
    } in ${Number(ply) || 0} moves`;
  }
  if (summary?.decidedBy === "sudden-death") {
    return `Sudden death — decided in ${Number(ply) || 0} moves`;
  }
  return "Conceded before the lattice was decided";
}

// ── Copy ──────────────────────────────────────────────────────────────────

export type ViewerOutcome = "win" | "loss" | "draw";

/**
 * The viewer's outcome, read from the SETTLED row — never derived from the
 * board client-side. `result` is the server's `player1 | player2 | tie`, so
 * a conceded match (no winning line on the board) reports correctly.
 */
export function outcomeFor({
  result,
  winnerId,
  viewerSeat,
  userId,
}: {
  result?: string | null;
  winnerId?: string | null;
  viewerSeat: Seat | null;
  userId?: string | null;
}): ViewerOutcome {
  if (result === RESULT.TIE) return "draw";
  if (viewerSeat && (result === "player1" || result === "player2")) {
    return result === viewerSeat ? "win" : "loss";
  }
  if (winnerId && userId) return winnerId === userId ? "win" : "loss";
  return "draw";
}

/** A short label for the settled outcome, from the viewer's perspective. */
export function outcomeLabel(outcome: ViewerOutcome): string {
  if (outcome === "win") return "You won";
  if (outcome === "loss") return "You lost";
  return "Draw";
}

/** Human copy for the match lifecycle, for the status chip. */
export function statusLabel(status: unknown): string {
  switch (String(status ?? "")) {
    case MATCH_STATUS.WAITING:
      return "Waiting for an opponent";
    case MATCH_STATUS.READY:
      return "Opponent found";
    case MATCH_STATUS.PLAYING:
      return "In progress";
    case MATCH_STATUS.FINISHED:
      return "Match over";
    case MATCH_STATUS.CANCELLED:
      return "Match cancelled";
    default:
      return "Loading…";
  }
}

/**
 * The primary turn line.
 *
 * Deliberately takes the snapshot's flags rather than recomputing whose turn it
 * is: the server already gated `viewerCanMove` on exactly the conditions it
 * will enforce, so the UI can never offer a move the server rejects.
 */
export function turnLabel({
  status,
  moved,
  isViewerTurn,
  isAi,
}: {
  status: unknown;
  /** True once the snapshot has loaded. */
  moved: boolean;
  /** True when the snapshot's turn is the viewer's. */
  isViewerTurn: boolean;
  isAi?: boolean;
}): string {
  if (!moved) return "Loading…";
  const s = String(status ?? "");
  if (s === MATCH_STATUS.FINISHED || s === MATCH_STATUS.CANCELLED) return "Match over";
  if (s === MATCH_STATUS.WAITING || s === MATCH_STATUS.READY) {
    return "Waiting for an opponent…";
  }
  if (isViewerTurn) return "Your turn — pick a cell";
  if (isAi) return "The bot is thinking…";
  return "Waiting for your opponent…";
}

/** Short mark name for chips and legends. */
export function markLabel(mark: Mark | null): string {
  if (mark === "X") return "X";
  if (mark === "O") return "O";
  return "—";
}

/** "You are X" / "You are O" / "Spectating". */
export function viewerMarkLabel(viewerSeat: Seat | null): string {
  const mark = markForSeat(viewerSeat);
  if (!mark) return "Spectating";
  return `You are ${mark}`;
}

// ── Snapshot ordering (stale-state guard) ─────────────────────────────────
//
// The match view fetches the authoritative snapshot on a poll AND from several
// event-driven refreshes (socket push, post-move resync, reconnect). Those
// requests can resolve out of order: a poll started BEFORE a move can land
// AFTER the move's response and would otherwise overwrite newer state with
// older state. `version` is the server's monotonic optimistic-concurrency
// counter (bumped by every accepted move), so it is the natural ordering key.
//
// Forfeit and cancel are the exception to "the version moves": both finalise
// the match by setting the phase to finished WITHOUT bumping `version`, so they
// are ordered by terminality instead — a terminal snapshot can never be
// replaced by a non-terminal one at the same version.

const TERMINAL_MATCH_STATUSES = new Set<string>([
  MATCH_STATUS.FINISHED,
  MATCH_STATUS.CANCELLED,
]);

/**
 * True when `incoming` must NOT replace `current` in the view state.
 *
 * Pure, so the rule is unit-tested rather than a condition buried in the fetch
 * callback. A null `current` is never stale (first load). A malformed
 * `incoming` (no numeric version) is always rejected — it cannot be trusted to
 * advance the board.
 */
export function isIncomingSnapshotStale(
  current: { version?: unknown; status?: unknown } | null | undefined,
  incoming: { version?: unknown; status?: unknown } | null | undefined,
): boolean {
  if (!current) return false;
  const incomingVersion = Number(incoming?.version);
  if (!Number.isFinite(incomingVersion)) return true;
  const currentVersion = Number(current?.version);
  if (!Number.isFinite(currentVersion)) return false;
  if (incomingVersion < currentVersion) return true;
  if (incomingVersion > currentVersion) return false;
  const currentTerminal = TERMINAL_MATCH_STATUSES.has(String(current?.status));
  const incomingTerminal = TERMINAL_MATCH_STATUSES.has(String(incoming?.status));
  return currentTerminal && !incomingTerminal;
}

/** Seconds between two instants, or null when either is unusable. */
export function durationSeconds(startedAt: unknown, endedAt: unknown): number | null {
  if (!startedAt || !endedAt) return null;
  const start = new Date(startedAt as string).getTime();
  const end = new Date(endedAt as string).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 1000);
}
