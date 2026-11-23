// src/lib/solitaire-puzzle/projection.ts
//
// THE CLIENT BOUNDARY. This module is safe to import from a client component:
// it never imports the puzzle library, the manifest, the store, the database or
// any seed material.
//
// The projection is deliberately built field-by-field. It does not spread a
// stored row or a `PuzzleSpec`, because either would carry `startState`, hidden
// identities, stock order, solution paths or verification metadata.

import {
  puzzleSessionProgress,
  puzzleViewFor,
} from "../solitaire-duel/puzzleSession";
import { publicObjective } from "../solitaire-duel/puzzleValidation";
import type {
  PuzzleReward,
  PuzzleSessionSnapshot,
  PuzzleSessionView,
  PuzzleSessionViewResult,
} from "./types";
import {
  PUZZLE_SESSION_SEAT,
  PUZZLE_SESSION_STATUS,
  type PuzzleSessionSeat,
} from "./constants";
import {
  currentManifestEntry,
  seatSession,
  seatSnapshot,
} from "./state";

function resultFor(
  snapshot: PuzzleSessionSnapshot,
  seat: PuzzleSessionSeat,
  reward: PuzzleReward | null,
  opponentName: string | null = null,
): PuzzleSessionViewResult | null {
  if (snapshot.status !== PUZZLE_SESSION_STATUS.FINISHED || !snapshot.result) {
    return null;
  }
  const winnerSeat =
    snapshot.result === "player1"
      ? PUZZLE_SESSION_SEAT.PLAYER1
      : snapshot.result === "player2"
        ? PUZZLE_SESSION_SEAT.PLAYER2
        : null;
  const opponentId =
    seat === PUZZLE_SESSION_SEAT.PLAYER1 ? snapshot.player2Id : snapshot.player1Id;
  return {
    winnerSeat,
    result: snapshot.result,
    resolutionReason: snapshot.resolutionReason,
    // Counts and server-stamped instants only: enough to explain the result,
    // never a board, a stock order or a solution.
    opponentId: opponentId ?? null,
    opponentName: opponentName ?? null,
    player1: { solved: snapshot.p1.solved, lastSolveAtMs: snapshot.p1.lastSolveAtMs },
    player2: { solved: snapshot.p2.solved, lastSolveAtMs: snapshot.p2.lastSolveAtMs },
    reward: reward ?? null,
  };
}

/**
 * The only shape a route may return for a puzzle session.
 *
 * `board` is `puzzleViewFor`: face-down slots carry `card: null`, the stock is a
 * count, and `nextStockCard` is always null. The objective is the public
 * projection, never the accepted-move form used by the validator.
 */
export function puzzleSessionView(
  snapshot: PuzzleSessionSnapshot,
  seat: PuzzleSessionSeat,
  nowMs: number,
  options: {
    duplicate?: boolean;
    reward?: PuzzleReward | null;
    opponentName?: string | null;
  } = {},
): PuzzleSessionView {
  const mine = seatSnapshot(snapshot, seat);
  const entry = currentManifestEntry(snapshot.manifest, mine);
  if (!entry) {
    throw new Error("The puzzle session manifest is missing the current puzzle");
  }
  const session = seatSession(entry, mine);
  const opponent = seatSnapshot(
    snapshot,
    seat === PUZZLE_SESSION_SEAT.PLAYER1
      ? PUZZLE_SESSION_SEAT.PLAYER2
      : PUZZLE_SESSION_SEAT.PLAYER1,
  );

  return {
    sessionId: snapshot.id,
    mode: snapshot.mode,
    status: snapshot.status,
    seat,
    puzzleNumber: mine.puzzleIndex + 1,
    puzzleCount: Math.max(snapshot.puzzleCount, mine.puzzleIndex + 1),
    puzzle: {
      slot: entry.slot,
      level: entry.level,
      category: entry.category,
      objectiveText: entry.objectiveText,
      concept: entry.concept,
      objective: publicObjective(entry.spec.objective),
      constraints: { ...(entry.spec.constraints ?? {}) },
      par: entry.spec.constraints?.maxMoves ?? 0,
    },
    // Hidden while the session waits: the puzzle set is already frozen, but
    // neither seat receives its board before the shared clock starts.
    board:
      snapshot.status === PUZZLE_SESSION_STATUS.WAITING ? null : puzzleViewFor(mine.state),
    ply: mine.ply,
    progress: puzzleSessionProgress(session),
    solvedCount: mine.solved,
    opponentSolvedCount: opponent.solved,
    lives: mine.lives ?? 3,
    opponentLives: opponent.lives ?? 3,
    puzzleDeadlineAtMs: mine.puzzleDeadlineAtMs ?? null,
    startedAtMs: snapshot.goAtMs,
    deadlineAtMs: snapshot.deadlineAtMs,
    serverNowMs: nowMs,
    result: resultFor(
      snapshot,
      seat,
      options.reward ?? null,
      options.opponentName ?? null,
    ),
    ...(options.duplicate ? { duplicate: true } : {}),
  };
}
