// src/lib/solitaire-puzzle/boardView.ts
//
// CLIENT-SAFE BOARD LOGIC for the shared puzzle gameplay surface.
//
// These are pure functions: no database, no store, no puzzle library, no seed
// material, no solution data. They decide only how an authoritative session
// view is displayed and which of two server snapshots is newer — never whether
// a move is legal, what a hidden card is, or who won.
//
// `reconcilePuzzleView` is the reason this module exists. The board polls while
// the player is also submitting moves, so a poll that started BEFORE a move can
// resolve AFTER it. Keeping the newer snapshot by (puzzle number, seat ply)
// stops a stale read from visibly undoing an accepted move, and a terminal
// result can never be walked back to a live board.

import type { PuzzleSessionView } from "./types";

/** How often the board re-reads its authoritative session. */
export const PUZZLE_BOARD_POLL_MS = 2_000;

/** The verdict a move endpoint may return, plus the client-only illegal case. */
export type PuzzleMoveVerdict =
  | "illegal"
  | "no-progress"
  | "progress"
  | "complete"
  | null;

/** Translation suffixes for the settled outcome. */
export type PuzzleOutcomeKey =
  | "win"
  | "loss"
  | "draw"
  | "forfeitWin"
  | "forfeitLoss";

/** `315000` → `"5:15"`; a passed deadline clamps to `"0:00"`. */
export function formatPuzzleClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Remaining time from a server deadline.
 *
 * `offsetMs` is the server clock minus the local clock at the last read, so a
 * skewed device still sees the shared deadline, not its own clock.
 */
export function puzzleRemainingMs(
  deadlineAtMs: number | null,
  offsetMs: number,
  clientNowMs: number,
): number | null {
  if (deadlineAtMs == null) return null;
  return deadlineAtMs - (clientNowMs + offsetMs);
}

/** Objective progress as a clamped 0–100 percentage. */
export function puzzleProgressPercent(
  progress: { current: number; target: number } | null | undefined,
): number {
  if (!progress || !Number.isFinite(progress.target) || progress.target <= 0) {
    return 0;
  }
  const value = (progress.current / progress.target) * 100;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** Map an engine verdict onto its translation key. */
export function puzzleVerdictKey(
  status: PuzzleMoveVerdict,
): "illegal" | "noProgress" | "madeProgress" | "complete" | null {
  switch (status) {
    case "illegal":
      return "illegal";
    case "no-progress":
      return "noProgress";
    case "progress":
      return "madeProgress";
    case "complete":
      return "complete";
    default:
      return null;
  }
}

/**
 * The viewer's result, derived ONLY from the server's projected result and the
 * seat the server assigned. A forfeit is reported as such.
 */
export function puzzleOutcomeKey(
  view: Pick<PuzzleSessionView, "result" | "seat"> | null,
): PuzzleOutcomeKey | null {
  if (!view?.result) return null;
  const { result, seat } = view;
  if (result.winnerSeat === null) return "draw";
  const won = result.winnerSeat === seat;
  if (result.resolutionReason === "forfeit") {
    return won ? "forfeitWin" : "forfeitLoss";
  }
  return won ? "win" : "loss";
}

function isTerminal(status: PuzzleSessionView["status"]): boolean {
  return status === "finished" || status === "cancelled";
}

/**
 * Keep the newest authoritative view.
 *
 * Ordering is `puzzleNumber` first (a solve advances it immediately) and the
 * VIEWER'S monotonic session `ply` second — not the board's puzzle-state ply,
 * which starts at the fixture's dealt position. Lifecycle is never reversed: a
 * waiting view cannot replace a live one, and a live view cannot replace a
 * settled one. Two terminal views resolve by server instant so a late reward
 * read can refresh the panel without resurrecting the match.
 */
export function reconcilePuzzleView(
  current: PuzzleSessionView | null,
  incoming: PuzzleSessionView | null,
): PuzzleSessionView | null {
  if (!incoming) return current;
  if (!current) return incoming;

  if (isTerminal(current.status)) {
    if (!isTerminal(incoming.status)) return current;
    return incoming.serverNowMs >= current.serverNowMs ? incoming : current;
  }
  if (isTerminal(incoming.status)) return incoming;

  if (current.status !== "waiting" && incoming.status === "waiting") {
    return current;
  }

  if (incoming.puzzleNumber < current.puzzleNumber) return current;
  if (
    incoming.puzzleNumber === current.puzzleNumber &&
    cursorOf(incoming) < cursorOf(current)
  ) {
    return current;
  }

  return incoming;
}

/**
 * The seat's own accepted-move count. Older fixtures/payloads without the
 * explicit field fall back to the projected board's ply, never the opponent's.
 */
function cursorOf(view: PuzzleSessionView): number {
  if (Number.isFinite(view.ply)) return view.ply;
  return view.board?.ply ?? -1;
}
