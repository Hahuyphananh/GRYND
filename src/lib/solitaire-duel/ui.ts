// src/lib/solitaire-duel/ui.ts
//
// Presentation helpers for Solitaire Duel. Pure and dependency-free, so the
// lobby, the match view and the result screen all derive their labels from one
// place instead of each re-implementing "did I win".
//
// Nothing here decides anything: the outcome it renders is the server's
// `result`, and the progress it prints is the server's `progress`. A viewer
// outcome is derived, never submitted.

import { MATCH_STATUS, RESOLUTION, SEAT } from "./constants";
import { outcomeFor } from "./rules";
import type { Seat } from "./types";

export type ViewerOutcome = "win" | "loss" | "draw";

/** How a seat's own result reads to that seat. */
export function viewerOutcome(seat: Seat | null | undefined, result: unknown): ViewerOutcome | null {
  const normalized = seat === SEAT.PLAYER1 || seat === SEAT.PLAYER2 ? seat : null;
  return outcomeFor(normalized, result);
}

export function outcomeLabel(outcome: ViewerOutcome | null): string {
  if (outcome === "win") return "VICTORY";
  if (outcome === "loss") return "DEFEAT";
  if (outcome === "draw") return "DRAW";
  return "";
}

/** Why the match ended, in the result panel's voice. */
export function resolutionLabel(reason: unknown): string | null {
  switch (reason) {
    case RESOLUTION.FINISH:
      return "Puzzle solved";
    case RESOLUTION.FORFEIT:
      return "Won by forfeit";
    case RESOLUTION.DRAW:
      return "Level at the final whistle";
    default:
      return null;
  }
}

export function statusLabel(status: unknown): string {
  switch (status) {
    case MATCH_STATUS.WAITING:
      return "Waiting for an opponent";
    case MATCH_STATUS.READY:
      return "Getting ready";
    case MATCH_STATUS.PLAYING:
      return "Racing";
    case MATCH_STATUS.FINISHED:
      return "Finished";
    case MATCH_STATUS.CANCELLED:
      return "Cancelled";
    default:
      return "";
  }
}

/**
 * The progress readout.
 *
 * The primary number is printed FIRST and on its own, because it is the number
 * the settlement compares: a player must never be able to say "the bar said I
 * was ahead" about anything else.
 */
export function progressLabel(progress: { foundationCards?: number; revealedTableau?: number } | null | undefined): string {
  const foundation = Math.max(0, Math.trunc(Number(progress?.foundationCards) || 0));
  const revealed = Math.max(0, Math.trunc(Number(progress?.revealedTableau) || 0));
  return `${foundation}/52 on foundations · ${revealed} revealed`;
}

/** Remaining time as m:ss, clamped at zero. */
export function clockLabel(remainingMs: unknown): string {
  const total = Math.max(0, Math.ceil((Number(remainingMs) || 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

/** Match duration in whole seconds, when both instants are known. */
export function durationSeconds(startedAt: unknown, endedAt: unknown): number | null {
  const start = startedAt ? Date.parse(String(startedAt)) : NaN;
  const end = endedAt ? Date.parse(String(endedAt)) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 1000);
}
