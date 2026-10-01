// src/lib/sudoku-duel/ui.ts
//
// Presentation helpers for Sudoku Duel. Pure and dependency-free, so the lobby,
// the match view and the result screen all derive their labels from one place
// instead of each re-implementing "did I win" or "what does 4:03 mean".
//
// Nothing here decides anything. The outcome it renders is the server's
// `result`; the progress it prints is the server's `progress`; the clock it
// formats is a duration derived from the SERVER's absolute instants. A viewer
// outcome is derived for display, never submitted.
//
// Mirrors `src/lib/solitaire-duel/ui.ts` deliberately: the two duels share the
// same vocabulary (status labels, resolution lines, a clock, a duration) so the
// platform reads as one product.

import { MATCH_STATUS, RESOLUTION, SEAT, SIZE } from "./constants";
import { outcomeFor } from "./rules";
import type { SudokuDifficulty } from "./types";

export type ViewerOutcome = "win" | "loss" | "draw";

/** How a seat's own result reads to that seat. Derived — never submitted. */
export function viewerOutcome(
  seat: unknown,
  result: unknown,
): ViewerOutcome | null {
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
    case RESOLUTION.DEADLINE:
      return "Time up — most progress wins";
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
      return "Solving";
    case MATCH_STATUS.FINISHED:
      return "Finished";
    case MATCH_STATUS.CANCELLED:
      return "Cancelled";
    default:
      return "";
  }
}

export function difficultyLabel(difficulty: unknown): string {
  const value = String(difficulty || "").toLowerCase();
  if (value === "easy") return "Easy";
  if (value === "hard") return "Hard";
  if (value === "normal") return "Normal";
  return "";
}

/** Clues a seat begins with, out of 81. */
export function givensLabel(givens: unknown): string {
  const value = Math.max(0, Math.trunc(Number(givens) || 0));
  return value > 0 ? `${value}/81 clues` : "";
}

/**
 * Verified progress, phrased as cells.
 *
 * The primary number is the competitive metric the settlement compares — the
 * count of non-given cells correctly filled — printed FIRST and on its own, so
 * nobody can say "the bar said I was ahead" about a different figure.
 */
export function progressLabel(
  progress: { correctCells?: number } | null | undefined,
  totalEntries = 0,
): string {
  const correct = Math.max(0, Math.trunc(Number(progress?.correctCells) || 0));
  const total = Math.max(0, Math.trunc(Number(totalEntries) || 0));
  return total > 0 ? `${correct}/${total} cells` : `${correct} cells`;
}

/** A quiet mistake readout — never a scold, never the answer. */
export function mistakeLabel(count: unknown): string {
  const value = Math.max(0, Math.trunc(Number(count) || 0));
  if (value === 0) return "No mistakes";
  return value === 1 ? "1 mistake" : `${value} mistakes`;
}

/** The accumulated competitive penalty, e.g. "+3s". */
export function penaltyLabel(penaltyMs: unknown): string {
  const ms = Math.max(0, Number(penaltyMs) || 0);
  if (ms <= 0) return "no penalty";
  return `+${Math.round(ms / 1000)}s penalty`;
}

/**
 * Remaining time as MM:SS, clamped at zero.
 *
 * The match limit is ten minutes, so the zero-padded minutes read as a clock
 * ("09:58") rather than a stopwatch. Anchored to the server's deadline instant
 * by the caller — this only formats.
 */
export function clockLabel(remainingMs: unknown): string {
  const total = Math.max(0, Math.ceil((Number(remainingMs) || 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${String(minutes).padStart(2, "0")}:${seconds}`;
}

/** Match duration in whole seconds, when both server instants are known. */
export function durationSeconds(startedAtMs: unknown, endedAtMs: unknown): number | null {
  const start = Number(startedAtMs);
  const end = Number(endedAtMs);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start <= 0 || end < start) return null;
  return Math.round((end - start) / 1000);
}

/**
 * The plain solve time: completion instant minus GO.
 *
 * Both instants are the server's (GO is written when the second seat joins,
 * the completion instant when `judgeAction` writes the final correct cell), so
 * this is a formatting subtraction and nothing more — exactly like
 * `durationSeconds`. Returns null when the seat never completed.
 */
export function solveMs(goAtMs: unknown, completedAtMs: unknown): number | null {
  const go = Number(goAtMs);
  const at = Number(completedAtMs);
  if (!Number.isFinite(go) || !Number.isFinite(at)) return null;
  if (go <= 0 || at < go) return null;
  return at - go;
}

/**
 * The ADJUSTED competitive finish time the settlement compares: solve time plus
 * the accumulated per-mistake penalty. Null until the seat completes.
 */
export function adjustedFinishMs(
  goAtMs: unknown,
  completedAtMs: unknown,
  penaltyMs: unknown,
): number | null {
  const plain = solveMs(goAtMs, completedAtMs);
  if (plain == null) return null;
  const penalty = Math.max(0, Number(penaltyMs) || 0);
  return plain + penalty;
}

/**
 * Why the match went the way it did, in the result panel's voice.
 *
 * A match-level statement, never a per-seat verdict: it names the rule that
 * decided it, so a timeout screen reads as "most cells at the final whistle"
 * rather than leaving the player to guess.
 */
export function tiebreakLabel(reason: unknown): string {
  switch (reason) {
    case RESOLUTION.FINISH:
      return "Fastest adjusted completion";
    case RESOLUTION.DEADLINE:
      return "Most cells at the final whistle";
    case RESOLUTION.FORFEIT:
      return "Opponent left the match";
    case RESOLUTION.DRAW:
      return "Level on every tiebreak";
    default:
      return "";
  }
}

/** "Row 4 · Col 2" — how a board cell is named in logs and details. */
export function cellLabel(index: unknown, size = SIZE): string {
  const value = Number(index);
  if (!Number.isInteger(value) || value < 0 || value >= size * size) return "—";
  return `Row ${Math.floor(value / size) + 1} · Col ${(value % size) + 1}`;
}

/** The 3x3 box number (1..9, row-major) containing a cell. */
export function boxLabel(index: unknown, size = SIZE): string {
  const value = Number(index);
  if (!Number.isInteger(value) || value < 0 || value >= size * size) return "—";
  const box = 3;
  const row = Math.floor(value / size);
  const col = value % size;
  const boxIndex = Math.floor(row / box) * box + Math.floor(col / box);
  return `Box ${boxIndex + 1}`;
}

export function isDifficulty(value: unknown): value is SudokuDifficulty {
  return value === "easy" || value === "normal" || value === "hard";
}
