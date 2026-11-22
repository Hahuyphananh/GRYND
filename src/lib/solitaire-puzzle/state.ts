// src/lib/solitaire-puzzle/state.ts
//
// PURE puzzle-session transitions. This module owns the authoritative board
// transitions but performs no I/O and never chooses a puzzle set. The store
// supplies the frozen manifest and persists the returned seat snapshot.
//
// The only client-authored input is the move. Objective completion, solved
// counts, puzzle advancement, the move cursor and the completion instant are
// derived here and stamped from the server clock.

import {
  applyPuzzleMove,
  createPuzzleSession,
  puzzleSessionProgress,
  puzzleViewFor,
  type PuzzleProgress,
  type PuzzleSession,
} from "../solitaire-duel/puzzleSession";
import type {
  PuzzleManifestEntry,
  PuzzleSeatSnapshot,
  PuzzleSessionSnapshot,
} from "./types";
import {
  PUZZLE_SESSION_LIVES,
  PUZZLE_SESSION_PUZZLE_MS,
  PUZZLE_SESSION_REASON,
  PUZZLE_SESSION_RESULT,
  PUZZLE_SESSION_SEAT,
  PUZZLE_SESSION_STATUS,
  PUZZLE_SESSION_TERMINAL_STATUSES,
  type PuzzleSessionSeat,
} from "./constants";
import type { Card, SolitaireMove } from "../solitaire-duel/types";

export function emptyPuzzleStats(): PuzzleSeatSnapshot["stats"] {
  return {
    moves: 0,
    revealed: 0,
    draws: 0,
    stockPasses: 0,
    stockRecycles: 0,
    foundationGain: 0,
    columnsOpened: 0,
    path: [],
  };
}

/**
 * The starting snapshot for one puzzle in a frozen manifest.
 *
 * `lives` and `deadlineAtMs` are match state, not puzzle state: a new puzzle
 * keeps the seat's lives and gets a fresh 60-second clock.
 */
export function createSeatSnapshot(
  entry: PuzzleManifestEntry,
  options: { lives?: number; deadlineAtMs?: number | null } = {},
): PuzzleSeatSnapshot {
  const session = createPuzzleSession(entry.spec);
  return {
    puzzleIndex: entry.slot,
    solved: 0,
    ply: 0,
    state: session.state,
    stats: session.stats,
    lastSolveAtMs: null,
    finishedAtMs: null,
    lastActionAtMs: null,
    lives: options.lives ?? PUZZLE_SESSION_LIVES,
    puzzleDeadlineAtMs: options.deadlineAtMs ?? null,
  };
}

/**
 * An independent copy of a seat snapshot.
 *
 * Both seats start from the SAME frozen manifest entry, so the second seat's
 * starting snapshot must be cloned: sharing one state object would let one
 * seat's transition mutate the other's board in a single process.
 */
export function cloneSeatSnapshot(seat: PuzzleSeatSnapshot): PuzzleSeatSnapshot {
  return structuredClone(seat);
}

/** Rehydrate the pure session for one seat from its stored state/stats. */
export function seatSession(
  entry: PuzzleManifestEntry,
  seat: PuzzleSeatSnapshot,
): PuzzleSession {
  return {
    spec: entry.spec,
    state: seat.state,
    view: puzzleViewFor(seat.state),
    stats: seat.stats,
  };
}

export function currentManifestEntry(
  manifest: readonly PuzzleManifestEntry[],
  seat: PuzzleSeatSnapshot,
): PuzzleManifestEntry | null {
  return manifest[seat.puzzleIndex] ?? null;
}

export type PuzzleSeatMoveResult = {
  status: "illegal" | "no-progress" | "progress" | "complete";
  seat: PuzzleSeatSnapshot;
  revealed: readonly Card[];
  progress: PuzzleProgress;
  /** True when the objective completed and the session advanced to the next puzzle. */
  advancedPuzzle: boolean;
  /** True when this move completed the final puzzle in the manifest. */
  completedSession: boolean;
  /** True when a legal move failed to advance the objective and cost a life. */
  lifeLost: boolean;
};

/**
 * Apply one move for one seat.
 *
 * An illegal move returns the SAME seat object and no reveal. A legal move may
 * complete the current objective; the seat then advances to the next frozen
 * puzzle with fresh per-puzzle stats, while its global ply keeps increasing.
 */
export function applySeatMove({
  manifest,
  seat,
  move,
  nowMs,
  perPuzzleMs = PUZZLE_SESSION_PUZZLE_MS,
}: {
  manifest: readonly PuzzleManifestEntry[];
  seat: PuzzleSeatSnapshot;
  move: SolitaireMove;
  nowMs: number;
  perPuzzleMs?: number;
}): PuzzleSeatMoveResult {
  const entry = currentManifestEntry(manifest, seat);
  if (!entry) {
    return {
      status: "illegal",
      seat,
      revealed: [],
      progress: { current: 0, target: 1, measurable: false },
      advancedPuzzle: false,
      completedSession: false,
      lifeLost: false,
    };
  }

  const outcome = applyPuzzleMove(seatSession(entry, seat), move);
  if (outcome.status === "illegal") {
    return {
      status: "illegal",
      seat,
      revealed: [],
      progress: outcome.progress,
      advancedPuzzle: false,
      completedSession: false,
      lifeLost: false,
    };
  }

  const livesBefore = seat.lives ?? PUZZLE_SESSION_LIVES;
  const lifeLost = outcome.status === "no-progress" && livesBefore > 0;
  const base: PuzzleSeatSnapshot = {
    ...seat,
    ply: seat.ply + 1,
    state: outcome.session.state,
    stats: outcome.session.stats,
    lastActionAtMs: nowMs,
    lives: lifeLost ? livesBefore - 1 : livesBefore,
    puzzleDeadlineAtMs: seat.puzzleDeadlineAtMs ?? null,
  };

  if (outcome.status !== "complete") {
    return {
      status: outcome.status,
      seat: base,
      revealed: outcome.revealed,
      progress: outcome.progress,
      advancedPuzzle: false,
      completedSession: false,
      lifeLost,
    };
  }

  const solved = seat.solved + 1;
  const solvedAll = solved >= manifest.length;
  if (solvedAll) {
    return {
      status: "complete",
      seat: {
        ...base,
        solved,
        lastSolveAtMs: nowMs,
        finishedAtMs: nowMs,
        puzzleDeadlineAtMs: null,
      },
      revealed: outcome.revealed,
      progress: outcome.progress,
      advancedPuzzle: false,
      completedSession: true,
      lifeLost,
    };
  }

  const nextEntry = manifest[seat.puzzleIndex + 1];
  if (!nextEntry) {
    // The manifest and puzzleCount disagree. Treat it as terminal rather than
    // leaving a seat stuck on a puzzle it has already solved.
    return {
      status: "complete",
      seat: {
        ...base,
        solved,
        lastSolveAtMs: nowMs,
        finishedAtMs: nowMs,
        puzzleDeadlineAtMs: null,
      },
      revealed: outcome.revealed,
      progress: outcome.progress,
      advancedPuzzle: false,
      completedSession: true,
      lifeLost,
    };
  }

  const next = createSeatSnapshot(nextEntry, {
    lives: base.lives,
    deadlineAtMs: nowMs + perPuzzleMs,
  });
  return {
    status: "complete",
    seat: {
      ...base,
      puzzleIndex: nextEntry.slot,
      solved,
      state: next.state,
      stats: next.stats,
      lastSolveAtMs: nowMs,
      finishedAtMs: null,
      puzzleDeadlineAtMs: nowMs + perPuzzleMs,
    },
    revealed: outcome.revealed,
    progress: outcome.progress,
    advancedPuzzle: true,
    completedSession: false,
    lifeLost,
  };
}

/**
 * Expire one seat's puzzle clock.
 *
 * A timeout costs a life and starts the next puzzle with a fresh 60 seconds.
 * Losing the third life sets `finishedAtMs`, which `resolvePuzzleOutcome` turns
 * into the opponent's win. The seat is never left with a passed deadline.
 */
export function applySeatPuzzleTimeout({
  manifest,
  seat,
  nowMs,
  perPuzzleMs = PUZZLE_SESSION_PUZZLE_MS,
}: {
  manifest: readonly PuzzleManifestEntry[];
  seat: PuzzleSeatSnapshot;
  nowMs: number;
  perPuzzleMs?: number;
}): {
  seat: PuzzleSeatSnapshot;
  expired: boolean;
  advancedPuzzle: boolean;
} {
  const deadline = seat.puzzleDeadlineAtMs;
  if (deadline == null || nowMs < deadline) {
    return { seat, expired: false, advancedPuzzle: false };
  }

  const lives = Math.max(0, (seat.lives ?? PUZZLE_SESSION_LIVES) - 1);
  if (lives <= 0) {
    return {
      seat: {
        ...seat,
        lives: 0,
        finishedAtMs: nowMs,
        puzzleDeadlineAtMs: null,
      },
      expired: true,
      advancedPuzzle: false,
    };
  }

  const nextEntry = manifest[seat.puzzleIndex + 1];
  if (!nextEntry) {
    return {
      seat: {
        ...seat,
        lives: 0,
        finishedAtMs: nowMs,
        puzzleDeadlineAtMs: null,
      },
      expired: true,
      advancedPuzzle: false,
    };
  }

  const fresh = createSeatSnapshot(nextEntry, {
    lives,
    deadlineAtMs: nowMs + perPuzzleMs,
  });
  return {
    seat: {
      ...fresh,
      solved: seat.solved,
      ply: seat.ply,
      lastSolveAtMs: seat.lastSolveAtMs,
      lastActionAtMs: nowMs,
    },
    expired: true,
    advancedPuzzle: true,
  };
}

export function seatForUser(
  snapshot: PuzzleSessionSnapshot,
  userId: string,
): PuzzleSessionSeat | null {
  if (snapshot.player1Id === userId) return PUZZLE_SESSION_SEAT.PLAYER1;
  if (snapshot.player2Id === userId) return PUZZLE_SESSION_SEAT.PLAYER2;
  return null;
}

export function otherSeat(seat: PuzzleSessionSeat): PuzzleSessionSeat {
  return seat === PUZZLE_SESSION_SEAT.PLAYER1
    ? PUZZLE_SESSION_SEAT.PLAYER2
    : PUZZLE_SESSION_SEAT.PLAYER1;
}

export function seatSnapshot(
  snapshot: PuzzleSessionSnapshot,
  seat: PuzzleSessionSeat,
): PuzzleSeatSnapshot {
  return seat === PUZZLE_SESSION_SEAT.PLAYER1 ? snapshot.p1 : snapshot.p2;
}

export function isPuzzleSessionTerminal(snapshot: PuzzleSessionSnapshot): boolean {
  return PUZZLE_SESSION_TERMINAL_STATUSES.includes(snapshot.status);
}

export function hasSolvedAll(snapshot: PuzzleSessionSnapshot, seat: PuzzleSeatSnapshot): boolean {
  return seat.solved >= snapshot.puzzleCount;
}

/**
 * Decide the authoritative outcome. `null` means the session is still live.
 *
 * At the deadline: more solved puzzles wins; an equal count is broken by the
 * earlier server-stamped solve at that count; an exact tie is a draw. Two empty
 * runs are a draw, not a fabricated winner.
 */
export function resolvePuzzleOutcome(
  snapshot: PuzzleSessionSnapshot,
  nowMs: number,
): {
  result: (typeof PUZZLE_SESSION_RESULT)[keyof typeof PUZZLE_SESSION_RESULT];
  winnerId: string | null;
  reason: (typeof PUZZLE_SESSION_REASON)[keyof typeof PUZZLE_SESSION_REASON];
} | null {
  if (snapshot.status === PUZZLE_SESSION_STATUS.CANCELLED) {
    return {
      result: PUZZLE_SESSION_RESULT.DRAW,
      winnerId: null,
      reason: PUZZLE_SESSION_REASON.DRAW,
    };
  }
  if (snapshot.status === PUZZLE_SESSION_STATUS.FINISHED) return null;

  const p1Out = (snapshot.p1.lives ?? PUZZLE_SESSION_LIVES) <= 0;
  const p2Out = (snapshot.p2.lives ?? PUZZLE_SESSION_LIVES) <= 0;
  if (p1Out || p2Out) {
    if (p1Out && p2Out) {
      return {
        result: PUZZLE_SESSION_RESULT.DRAW,
        winnerId: null,
        reason: PUZZLE_SESSION_REASON.LIVES,
      };
    }
    return p1Out
      ? {
          result: PUZZLE_SESSION_RESULT.PLAYER2,
          winnerId: snapshot.player2Id,
          reason: PUZZLE_SESSION_REASON.LIVES,
        }
      : {
          result: PUZZLE_SESSION_RESULT.PLAYER1,
          winnerId: snapshot.player1Id,
          reason: PUZZLE_SESSION_REASON.LIVES,
        };
  }

  const p1Done = hasSolvedAll(snapshot, snapshot.p1);
  const p2Done = hasSolvedAll(snapshot, snapshot.p2);
  if (p1Done || p2Done) {
    if (p1Done && p2Done) {
      const p1At = snapshot.p1.finishedAtMs ?? Number.POSITIVE_INFINITY;
      const p2At = snapshot.p2.finishedAtMs ?? Number.POSITIVE_INFINITY;
      if (p1At === p2At) {
        return {
          result: PUZZLE_SESSION_RESULT.DRAW,
          winnerId: null,
          reason: PUZZLE_SESSION_REASON.FINISH,
        };
      }
      return p1At < p2At
        ? {
            result: PUZZLE_SESSION_RESULT.PLAYER1,
            winnerId: snapshot.player1Id,
            reason: PUZZLE_SESSION_REASON.FINISH,
          }
        : {
            result: PUZZLE_SESSION_RESULT.PLAYER2,
            winnerId: snapshot.player2Id,
            reason: PUZZLE_SESSION_REASON.FINISH,
          };
    }
    return p1Done
      ? {
          result: PUZZLE_SESSION_RESULT.PLAYER1,
          winnerId: snapshot.player1Id,
          reason: PUZZLE_SESSION_REASON.FINISH,
        }
      : {
          result: PUZZLE_SESSION_RESULT.PLAYER2,
          winnerId: snapshot.player2Id,
          reason: PUZZLE_SESSION_REASON.FINISH,
        };
  }

  if (snapshot.deadlineAtMs != null && nowMs >= snapshot.deadlineAtMs) {
    if (snapshot.p1.solved !== snapshot.p2.solved) {
      return snapshot.p1.solved > snapshot.p2.solved
        ? {
            result: PUZZLE_SESSION_RESULT.PLAYER1,
            winnerId: snapshot.player1Id,
            reason: PUZZLE_SESSION_REASON.DEADLINE,
          }
        : {
            result: PUZZLE_SESSION_RESULT.PLAYER2,
            winnerId: snapshot.player2Id,
            reason: PUZZLE_SESSION_REASON.DEADLINE,
          };
    }
    const p1At = snapshot.p1.lastSolveAtMs;
    const p2At = snapshot.p2.lastSolveAtMs;
    if (p1At == null && p2At == null) {
      return {
        result: PUZZLE_SESSION_RESULT.DRAW,
        winnerId: null,
        reason: PUZZLE_SESSION_REASON.DEADLINE,
      };
    }
    if (p1At != null && p2At != null && p1At === p2At) {
      return {
        result: PUZZLE_SESSION_RESULT.DRAW,
        winnerId: null,
        reason: PUZZLE_SESSION_REASON.DEADLINE,
      };
    }
    if (p1At == null) {
      return {
        result: PUZZLE_SESSION_RESULT.PLAYER2,
        winnerId: snapshot.player2Id,
        reason: PUZZLE_SESSION_REASON.DEADLINE,
      };
    }
    if (p2At == null) {
      return {
        result: PUZZLE_SESSION_RESULT.PLAYER1,
        winnerId: snapshot.player1Id,
        reason: PUZZLE_SESSION_REASON.DEADLINE,
      };
    }
    return p1At < p2At
      ? {
          result: PUZZLE_SESSION_RESULT.PLAYER1,
          winnerId: snapshot.player1Id,
          reason: PUZZLE_SESSION_REASON.DEADLINE,
        }
      : {
          result: PUZZLE_SESSION_RESULT.PLAYER2,
          winnerId: snapshot.player2Id,
          reason: PUZZLE_SESSION_REASON.DEADLINE,
        };
  }

  return null;
}

export function isPuzzleSessionDue(
  snapshot: PuzzleSessionSnapshot,
  nowMs: number,
): boolean {
  return (
    snapshot.status === PUZZLE_SESSION_STATUS.PLAYING &&
    snapshot.deadlineAtMs != null &&
    nowMs >= snapshot.deadlineAtMs
  );
}

export function progressForSeat(
  manifest: readonly PuzzleManifestEntry[],
  seat: PuzzleSeatSnapshot,
): PuzzleProgress {
  const entry = currentManifestEntry(manifest, seat);
  if (!entry) return { current: 0, target: 1, measurable: false };
  return puzzleSessionProgress(seatSession(entry, seat));
}
