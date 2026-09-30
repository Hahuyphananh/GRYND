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

import { CELL_COUNT, BOARD_SIZE, MATCH_STATUS, RESULT } from "./constants";
import type { Cell, Mark, Seat } from "./types";

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
