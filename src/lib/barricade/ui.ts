// src/lib/barricade/ui.ts
//
// Pure view-model helpers for the ONLINE Barricade surface (the lobby and the
// match view). Same role as `src/lib/tic-tac-toe/ui.ts`: it turns the
// authoritative snapshot the server sends into the strings and verdicts the UI
// renders, and it owns no rule of the game.
//
// ── WHY THIS IS NOT THE RULES ENGINE ────────────────────────────────────
//
// Movement, jumps, barricade legality and victory all live in `./rules` and are
// executed by the server store. Nothing here may re-derive any of them: every
// function below is a formatter or a small guard over values the server already
// decided (the seat, the turn, the winner, the result reason, the version). That
// is what keeps a stale tab from being able to argue with the server about whose
// turn it is.
//
// Like the engine, this module imports nothing — no React, no HTTP, no DB — so
// the client bundle can share it with a Node test.

import { MATCH_STATUS, ORIENTATIONS } from "./constants";
import type { Seat } from "./types";

/** Match states that can never change again. */
const TERMINAL_MATCH_STATUSES = new Set<string>([
  MATCH_STATUS.FINISHED,
  MATCH_STATUS.CANCELLED,
]);

/** The seats a live (two-player) match has. */
export const LIVE_STATUSES = new Set<string>([MATCH_STATUS.PLAYING]);

export function isTerminalStatus(status: unknown): boolean {
  return TERMINAL_MATCH_STATUSES.has(String(status ?? ""));
}

/** The seat's accent colour — the board draws player1 blue and player2 purple. */
export function seatColor(seat: Seat | null | undefined): string {
  return seat === "player2" ? "#c084fc" : "#38bdf8";
}

/** A seat's colour name, matching the copy the board and the practice page use. */
export function seatName(seat: Seat | null | undefined): string {
  return seat === "player2" ? "Purple" : "Blue";
}

/**
 * How to refer to a seat from the viewer's point of view: "You" for the seat the
 * caller holds, "Opponent" otherwise, falling back to the colour when the caller
 * has no seat at all (a spectator is not possible online, but the match page
 * renders once before the snapshot lands).
 */
export function seatLabel(seat: Seat | null | undefined, viewerSeat: Seat | null | undefined): string {
  if (!seat) return "—";
  if (viewerSeat) return seat === viewerSeat ? "You" : "Opponent";
  return seatName(seat);
}

/** Human copy for the lifecycle chip. */
export function statusLabel(status: unknown): string {
  switch (String(status ?? "")) {
    case MATCH_STATUS.WAITING:
      return "Waiting for an opponent";
    case MATCH_STATUS.PLAYING:
      return "In progress";
    case MATCH_STATUS.FINISHED:
      return "Finished";
    case MATCH_STATUS.CANCELLED:
      return "Cancelled";
    default:
      return "Loading";
  }
}

/**
 * The turn banner. Every branch is driven by the server's own `isViewerTurn` and
 * `status` — never by the viewer's own move submission.
 */
export function turnLabel({
  status,
  isViewerTurn,
  viewerSeat,
  opponentName,
}: {
  status?: unknown;
  isViewerTurn?: boolean;
  viewerSeat?: Seat | null;
  opponentName?: string | null;
}): string {
  const state = String(status ?? "");
  if (state === MATCH_STATUS.WAITING) return "Waiting for an opponent to join…";
  if (state === MATCH_STATUS.CANCELLED) return "This match was cancelled.";
  if (state === MATCH_STATUS.FINISHED) return "Match complete.";
  if (!viewerSeat) return "Loading the match…";
  if (isViewerTurn) return "Your turn — move your pawn or place a barricade.";
  return `${opponentName || "Your opponent"} is deciding…`;
}

/** The viewer's outcome, from the settled `result`/`winnerId`. Never a draw. */
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
}): "win" | "loss" | null {
  if (result === "player1" || result === "player2") {
    if (!viewerSeat) return null;
    return result === viewerSeat ? "win" : "loss";
  }
  if (winnerId && userId) return winnerId === userId ? "win" : "loss";
  return null;
}

/**
 * Monotonic-snapshot guard, copied from the other match views: several refreshes
 * (poll, socket push, post-move resync) can be in flight at once, so an older
 * response must never roll the view back — and a same-version terminal snapshot
 * (a resignation racing a poll) must never be overwritten by a live one.
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
  const currentTerminal = isTerminalStatus(current?.status);
  const incomingTerminal = isTerminalStatus(incoming?.status);
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

/**
 * Why the match ended, as a sentence. The server records the reason; the client
 * only names it (the engine itself can only ever produce `reached-baseline`).
 */
export function resultReasonLabel(reason: unknown, outcome: "win" | "loss" | null): string {
  switch (String(reason ?? "")) {
    case "resigned":
      return outcome === "win"
        ? "Your opponent resigned the match."
        : "You resigned the match.";
    case "abandoned":
      return outcome === "win"
        ? "Your opponent left and did not return — the match was awarded to you."
        : "You left the match and did not return — it was awarded to your opponent.";
    case "timed-out":
      return "The match ran out of time.";
    case "reached-baseline":
      return outcome === "win"
        ? "You walked your pawn to the far baseline."
        : "Your opponent reached the far baseline first.";
    default:
      return outcome === "win" ? "You won the match." : "Your opponent won the match.";
  }
}

/** One logged action (`barricade_moves` row) as human copy. */
export function loggedActionLabel(entry: {
  actionType?: unknown;
  col?: unknown;
  row?: unknown;
  orientation?: unknown;
}): string {
  const col = Number(entry?.col);
  const row = Number(entry?.row);
  if (String(entry?.actionType) === "wall") {
    const orientation =
      String(entry?.orientation) === ORIENTATIONS[1] ? "vertical" : "horizontal";
    // A barricade spans two squares, so its address is the slot it occupies.
    return orientation === "horizontal"
      ? `Barricade — between rows ${row + 1} and ${row + 2}, columns ${col + 1}–${col + 2}`
      : `Barricade — between columns ${col + 1} and ${col + 2}, rows ${row + 1}–${row + 2}`;
  }
  return `Pawn to row ${row + 1}, column ${col + 1}`;
}

/** "6 of 10 barricades" for the seat cards. */
export function wallInventoryLabel(remaining: unknown): string {
  const count = Number(remaining);
  const safe = Number.isFinite(count) ? count : 0;
  return `${safe} ${safe === 1 ? "barricade" : "barricades"} left`;
}

/** The viewer's/opponent's remaining barricades out of the server's inventory. */
export function wallsFor(
  wallsRemaining: Record<string, unknown> | null | undefined,
  seat: Seat | null | undefined,
): number {
  if (!seat || !wallsRemaining) return 0;
  const value = Number(wallsRemaining[seat]);
  return Number.isFinite(value) ? value : 0;
}
