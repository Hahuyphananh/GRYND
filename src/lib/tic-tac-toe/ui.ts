// src/lib/tic-tac-toe/ui.ts
//
// Pure client-side helpers for the Tic-Tac-Toe Duel views.
//
// Everything here is a deterministic function of its arguments — no DOM, no
// React, no fetch — so the board affordances, the turn copy and the
// destination copy can be unit-tested directly and shared between the lattice
// component and the match page.
//
// IMPORTANT: nothing in this module is authoritative. It only decides what the
// player SEES and what they are OFFERED. The lattice, whose turn it is, the
// required destination, the winner and the draw always come from the server
// snapshot — this file never computes a move, a winner or a result of its own,
// and it never re-implements a winning line. Every "which board / which cell"
// answer below is read from the DTO's own derived fields (`boards`,
// `playableBoards`, `nextBoard`, `viewerCanMove`); the store still validates
// every submission.

import { CELL_COUNT, LATTICE_SIZE, MATCH_STATUS, MAX_BOARDS } from "./constants";
import type { BoardControl, Cell, Mark, Seat } from "./types";
import { viewerOutcome } from "../results/viewerOutcome";

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

// ── Cell helpers ──────────────────────────────────────────────────────────

/** True when `value` is a playable cell index (0..8). */
export function isBoardIndex(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < CELL_COUNT
  );
}

/** The nine cells of a snapshot board, normalised to null/Cell. */
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
 * be live and it must be the viewer's turn (`viewerCanMove`), the target board
 * must be playable, and the cell must be empty. The board is the server's, so
 * this can never disagree with what the server will accept — and a click on a
 * cell this returns false for is still rejected server-side.
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

/**
 * The winning cells as an ORDERED line, or [] when it cannot be drawn.
 *
 * `winningCellSet` answers "which cells are highlighted"; this answers "draw a
 * line through them". A line needs exactly three distinct valid cells (the
 * server always sends three for a claimed board), and the endpoints must be the
 * two ends of the run — sorting the indices gives that for every line shape
 * (row, column and both diagonals), so a payload that arrives in a different
 * order still draws the same line. Anything else is treated as no line at all
 * rather than guessing: the renderer must never invent a winning line the
 * server did not send.
 */
export function winningCellLine(winningLine: unknown): number[] {
  if (!Array.isArray(winningLine)) return [];
  const cells = winningLine.map(Number).filter(isBoardIndex);
  const unique = Array.from(new Set(cells)).sort((a, b) => a - b);
  return unique.length === 3 ? unique : [];
}

/** The 0-based index of the last accepted move's cell, or -1. */
export function lastMoveCellIndex(lastMove: unknown): number {
  const index = (lastMove as { cellIndex?: unknown } | null)?.cellIndex;
  return isBoardIndex(index) ? (index as number) : -1;
}

/** How many marks are on one board — the cells, not the server's ply. */
export function filledCount(board: unknown): number {
  return normaliseBoard(board).filter((cell) => cell !== null).length;
}

// ── The nine-board lattice ────────────────────────────────────────────────
//
// Ultimate Tic-Tac-Toe is a FIXED 3x3 lattice of nine mini-boards: every slot
// is in play from move one, so there is no stage, no expansion and no
// sudden-death board. EVERYTHING below is a pure projection of the server
// snapshot. The server derives each board's control, the required destination,
// the playable set and the winning lattice line; this module only normalises
// those values into render-friendly shapes and gives the view geometry.

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

/** Normalise the server's one mini-board into a render shape. */
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

/** An empty, open mini-board — what a missing slot reads as. */
function emptyBoard(): NormalisedBoard {
  return {
    cells: Array.from({ length: CELL_COUNT }, () => null),
    control: "active",
    winningLine: null,
  };
}

/**
 * The whole lattice, ALWAYS length nine.
 *
 * The server writes all nine mini-boards, so a missing/corrupt slot is a
 * transport problem rather than a game state. It is normalised to an empty,
 * open board instead of `null` so the view stays a stable 3x3 — and because a
 * click on it is still validated (and refused) by the server, that can never
 * offer an illegal move.
 */
export function normaliseLattice(lattice: unknown): NormalisedBoard[] {
  const source = Array.isArray(lattice) ? lattice : [];
  return Array.from(
    { length: MAX_BOARDS },
    (_, slot) => normaliseServerBoard(source[slot]) ?? emptyBoard(),
  );
}

/** Every lattice slot, row-major: 0..8. */
export function latticeSlots(): number[] {
  return Array.from({ length: MAX_BOARDS }, (_, slot) => slot);
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

/** The winning lattice line, as a slot list of exactly three (or empty). */
export function normaliseWinningBoards(winningBoards: unknown): number[] {
  const slots = normaliseSlotList(winningBoards);
  return slots.length === 3 ? slots : [];
}

/** The three winning lattice slots, as a lookup for the highlight. */
export function winningBoardSet(winningBoards: unknown): Set<number> {
  return new Set(normaliseWinningBoards(winningBoards));
}

/**
 * The seven things a mini-board can look like, in the order the eye should read
 * them. Exactly ONE board is ever `required` — the destination the rules
 * forced — and `open` is what the other selectable boards look like during a
 * free choice, so the view can never imply that several boards are mandatory.
 */
export type BoardVisualState =
  | "required"
  | "open"
  | "waiting"
  | "won-x"
  | "won-o"
  | "drawn";

/**
 * Which of those states a board is in, from the SERVER's own values only:
 * its `control`, whether it is the required destination, and whether the server
 * lists it as playable.
 */
export function boardState({
  control,
  required = false,
  offered = false,
}: {
  control: unknown;
  required?: boolean;
  offered?: boolean;
}): BoardVisualState {
  if (control === "X") return "won-x";
  if (control === "O") return "won-o";
  if (control === "draw") return "drawn";
  if (required) return "required";
  return offered ? "open" : "waiting";
}

/** The chip on a mini-board: one short word per state. */
export function boardStateBadge(state: BoardVisualState): string {
  switch (state) {
    case "required":
      return "Play here";
    case "open":
      return "Open";
    case "waiting":
      return "Waiting";
    case "won-x":
      return "X";
    case "won-o":
      return "O";
    case "drawn":
      return "Draw";
    default:
      return "—";
  }
}

/** The same state as a sentence fragment for a screen reader. */
export function boardStateDescription(state: BoardVisualState): string {
  switch (state) {
    case "required":
      return "required — play here";
    case "open":
      return "open, available to play";
    case "waiting":
      return "open, not available right now";
    case "won-x":
      return "won by X";
    case "won-o":
      return "won by O";
    case "drawn":
      return "a draw";
    default:
      return "";
  }
}

/** The mark a claimed board is owned by, or null. */
export function boardStateMark(state: BoardVisualState): "X" | "O" | null {
  if (state === "won-x") return "X";
  if (state === "won-o") return "O";
  return null;
}

/** True when a board can no longer accept moves (won or drawn). */
export function boardIsResolved(control: unknown): boolean {
  return control === "X" || control === "O" || control === "draw";
}

/**
 * Where a slot sits in the fixed 3x3 render grid.
 *
 * Purely presentational geometry: the lattice is always three columns, so a
 * slot's index IS its row-major position.
 */
export function slotGridPosition(slot: number): {
  row: number;
  col: number;
  rows: number;
  cols: number;
} {
  const index = isBoardIndex(slot) ? slot : 0;
  return {
    row: Math.floor(index / LATTICE_SIZE),
    col: index % LATTICE_SIZE,
    rows: LATTICE_SIZE,
    cols: LATTICE_SIZE,
  };
}

/** How far the whole match has gone: cells played out of the 81 available. */
export function latticeProgress(boards: unknown): { played: number; total: number; label: string } {
  const lattice = normaliseLattice(boards);
  const played = lattice.reduce((sum, board) => sum + filledCount(board.cells), 0);
  const total = MAX_BOARDS * CELL_COUNT;
  return { played, total, label: `${played} of ${total} cells played` };
}

// ── Destination / playability, read from the SERVER's own flags ───────────
//
// `nextBoard` and `playableBoards` are derived server-side by the same
// function `validateMove` uses. These helpers never re-derive the rule (they
// do not look at the last move's cell); they only interpret the DTO so the
// view can highlight the right board and offer the right cells.

/** The required destination as a slot, or null when the choice is free. */
export function requiredBoard(snapshot: any): number | null {
  const value = snapshot?.nextBoard;
  return isBoardIndex(value) ? (value as number) : null;
}

/**
 * The boards the server says may be addressed right now.
 *
 * Read from `playableBoards`; when an older snapshot omits it, the fallback is
 * still server-derived: every board whose SERVER control is `active`. It never
 * invents a board or rescans a winning line.
 */
export function playableLatticeBoards(snapshot: any): number[] {
  const declared = normaliseSlotList(snapshot?.playableBoards);
  if (declared.length) return declared;
  if (!snapshot || !Array.isArray(snapshot.boards)) return [];
  // Only the slots the snapshot actually carries: a slot the payload omits is
  // NOT read as "open and playable", it is simply not offered.
  const out: number[] = [];
  for (let slot = 0; slot < MAX_BOARDS; slot += 1) {
    const raw = snapshot.boards[slot];
    if (!raw) continue;
    if ((normaliseServerBoard(raw)?.control ?? "active") === "active") out.push(slot);
  }
  return out;
}

/** True when the required board is not the only option: any open board is legal. */
export function isFreeChoice(snapshot: any): boolean {
  if (!snapshot) return false;
  if (isTerminalStatus(snapshot.status)) return false;
  if (requiredBoard(snapshot) !== null) return false;
  return playableLatticeBoards(snapshot).length > 1;
}

/** True when the server's snapshot says `slot` is a board that may be played. */
export function isBoardPlayable(snapshot: any, slot: number): boolean {
  if (!isBoardIndex(slot)) return false;
  return playableLatticeBoards(snapshot).includes(slot);
}

/**
 * Whether the VIEWER may place a mark on `slot` right now.
 *
 * `viewerCanMove` already folds together status, phase, seat and turn, so this
 * adds only the per-board half of the same server derivation.
 */
export function canPlayInBoard(snapshot: any, slot: number): boolean {
  if (!snapshot?.viewerCanMove) return false;
  if (!isBoardPlayable(snapshot, slot)) return false;
  const board = normaliseLattice(snapshot.boards)[slot];
  return Boolean(board) && board.control === "active";
}

/**
 * The server board a move addresses, or null when the address is not a slot.
 *
 * `boardIndex` has exactly ONE addressing mode in Ultimate — a lattice slot
 * (0..8) — so anything else resolves to null and the click is dropped before a
 * request is ever sent.
 */
export function serverBoardAt(match: any, boardIndex: number): NormalisedBoard | null {
  if (!match || !isBoardIndex(boardIndex)) return null;
  return normaliseLattice(match.boards)[boardIndex] ?? null;
}

/**
 * Where a slot sits on the large board, in words: "top-left", "centre",
 * "bottom-right".
 *
 * The slot index IS the row-major position on the fixed 3x3 lattice, so this is
 * a lookup, not a derivation — and it is what lets the turn guidance say "play
 * in the top-right board" instead of pointing at a number.
 */
const BOARD_POSITIONS = [
  "top-left",
  "top-middle",
  "top-right",
  "middle-left",
  "centre",
  "middle-right",
  "bottom-left",
  "bottom-middle",
  "bottom-right",
] as const;

/** "top-right" — a slot's position on the large board, or "—". */
export function boardPositionName(slot: number | null | undefined): string {
  return isBoardIndex(slot) ? BOARD_POSITIONS[slot as number] : "—";
}

/** "Board 5" — a slot's human name. */
export function boardName(slot: number | null | undefined): string {
  return isBoardIndex(slot) ? `Board ${(slot as number) + 1}` : "—";
}

// ── Copy ──────────────────────────────────────────────────────────────────

export type ViewerOutcome = "win" | "loss" | "draw";

/**
 * The viewer's outcome, read from the SETTLED row — never derived from the
 * board client-side. `result` is the server's `player1 | player2 | tie`, so
 * a conceded match (no winning line on the board) reports correctly.
 *
 * DELEGATED to src/lib/results/viewerOutcome.ts — the platform's one verdict
 * rule. A row that names no winner stays a DRAW here (tic-tac-toe has no other
 * terminal state), which is why the shared rule's `null` collapses to "draw"
 * rather than to a loss.
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
  return (
    viewerOutcome({
      result,
      winnerId,
      viewerSeat,
      viewerId: userId,
    }) ?? "draw"
  );
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

/** True when the row's status can no longer accept a move. */
export function isTerminalStatus(status: unknown): boolean {
  const s = String(status ?? "");
  return s === MATCH_STATUS.FINISHED || s === MATCH_STATUS.CANCELLED;
}

/**
 * What the current player has to do about the DESTINATION, in one sentence,
 * generated entirely from the snapshot: the required board's POSITION NAME, or
 * the free-choice state, or the terminal state.
 *
 * Written from the viewer's seat, so the two players never read the same
 * instruction: the seat to move is told to play, the waiting seat is told where
 * its opponent must play. A free choice is spelled out rather than implied.
 */
export function moveInstruction({
  snapshot,
  submitting = false,
}: {
  snapshot: any;
  submitting?: boolean;
}): string {
  if (!snapshot) return "Loading…";
  if (submitting) return "Sending your move…";
  const status = String(snapshot.status ?? "");
  if (isTerminalStatus(status)) {
    return snapshot.result === "tie" ? "Match drawn." : "Match over.";
  }
  if (status === MATCH_STATUS.WAITING || status === MATCH_STATUS.READY) {
    return "Waiting for an opponent…";
  }

  const required = requiredBoard(snapshot);
  const freeChoice = isFreeChoice(snapshot);
  if (snapshot.viewerCanMove) {
    if (required !== null) return `Play in the ${boardPositionName(required)} board.`;
    if (freeChoice) return "Free choice — play in any open board.";
    return "Your move is being checked…";
  }

  // Not the viewer's turn: say what the OPPONENT must do, so both seats always
  // know where the next mark goes.
  if (required !== null) {
    return `Your opponent must play in the ${boardPositionName(required)} board.`;
  }
  if (freeChoice) return "Your opponent can choose any open board.";
  if (snapshot.isAi) return "The bot is thinking…";
  return "Waiting for your opponent's move…";
}

/**
 * A short chip for the lattice header: the destination WITHOUT the viewer's
 * perspective, because it labels the board rather than instructing a player.
 */
export function destinationChip(snapshot: any): string {
  if (!snapshot) return "Loading…";
  if (isTerminalStatus(snapshot.status)) return "Match over";
  const status = String(snapshot.status ?? "");
  if (status === MATCH_STATUS.WAITING || status === MATCH_STATUS.READY) return "Not started";
  const required = requiredBoard(snapshot);
  if (required !== null) return `Required: ${boardPositionName(required)} board`;
  if (isFreeChoice(snapshot)) return "Free choice — any open board";
  return "No board available";
}

/**
 * The three things a player has to understand about Ultimate Tic-Tac-Toe, in
 * the order they matter. Rendered as a strip under the board.
 */
export const HOW_TO_PLAY: readonly string[] = Object.freeze([
  "Three in a row claims a mini-board.",
  "The cell you play sends your opponent to that same board.",
  "Claim three mini-boards in a line to win the match.",
]);

/** The one-line rules headline. */
export function rulesHint(): string {
  return "Win three mini-boards in a row.";
}


/** "You are X" / "You are O" / "Spectating". */
export function viewerMarkLabel(viewerSeat: Seat | null): string {
  const mark = markForSeat(viewerSeat);
  if (!mark) return "Spectating";
  return `You are ${mark}`;
}

/** A one-line description of how a finished match was decided. */
export function resultReason({
  winningBoards,
  result,
  ply,
}: {
  winningBoards?: unknown;
  result?: unknown;
  ply?: unknown;
}): string {
  const line = normaliseWinningBoards(winningBoards);
  if (line.length === 3) {
    return `Lattice line — ${line.map((slot) => `Board ${slot + 1}`).join(" · ")}`;
  }
  if (result === "tie") {
    return `Draw — every mini-board resolved in ${Number(ply) || 0} moves`;
  }
  if (result === "player1" || result === "player2") {
    return `Conceded before the lattice line was completed (${Number(ply) || 0} moves)`;
  }
  return "Conceded before the lattice was decided";
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
