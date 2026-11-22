// src/lib/solitaire-puzzle/ranked.ts
//
// THE PUZZLE RANKED FORMAT — one frozen, configurable definition.
//
// The values a match is played under live here and NOWHERE else: the puzzle
// count, the shared time allowance, the queue lifetime, the score metric and
// the tie-break rule. A component or route reads `PUZZLE_RANKED_FORMAT` rather
// than repeating a number, so tuning the mode is a one-line change.
//
// Both seats race the SAME frozen manifest (Phase 3 selection: one puzzle per
// difficulty band), under ONE absolute GO/deadline pair. The primary score is
// the number of puzzles the SERVER verified as complete. The tie-break is the
// platform's existing competitive timing convention: at an equal solved count
// the earlier server-stamped final solve wins, and an exact tie is a draw.
//
// PURE: no I/O, no clock, no randomness. Safe on either side of the boundary.

import {
  PUZZLE_RANKED_DISPLAY_NAME,
  PUZZLE_RANKED_GAME_KEY,
  PUZZLE_RANKED_QUEUE_TTL_MS,
  PUZZLE_SESSION_DEADLINE_MS,
  PUZZLE_SESSION_PUZZLE_COUNT,
} from "./constants";
import type { PuzzleSeatSnapshot, PuzzleSessionSnapshot } from "./types";

export const PUZZLE_RANKED_FORMAT = Object.freeze({
  gameKey: PUZZLE_RANKED_GAME_KEY,
  displayName: PUZZLE_RANKED_DISPLAY_NAME,
  /** Five puzzles: one from each library difficulty band. */
  puzzleCount: PUZZLE_SESSION_PUZZLE_COUNT,
  /** Both seats receive this same absolute allowance from the shared GO. */
  deadlineMs: PUZZLE_SESSION_DEADLINE_MS,
  /** A waiting search older than this is no longer joinable. */
  queueTtlMs: PUZZLE_RANKED_QUEUE_TTL_MS,
  /** The number a result screen leads with. */
  primaryScore: "puzzles-solved" as const,
  /** Equal solved counts are broken by the earlier server-stamped solve. */
  tieBreak: "earlier-final-solve" as const,
});

/**
 * Compare two seats by the competitive rule: more solved wins; at an equal
 * count the earlier final solve wins. Returns negative when `a` is ahead.
 *
 * This mirrors `resolvePuzzleOutcome` (the authority) and exists so a result
 * surface and a test can reason about the order without re-implementing it.
 */
export function comparePuzzleSeats(
  a: Pick<PuzzleSeatSnapshot, "solved" | "lastSolveAtMs">,
  b: Pick<PuzzleSeatSnapshot, "solved" | "lastSolveAtMs">,
): number {
  if (a.solved !== b.solved) return b.solved - a.solved;
  const aAt = a.lastSolveAtMs ?? Number.POSITIVE_INFINITY;
  const bAt = b.lastSolveAtMs ?? Number.POSITIVE_INFINITY;
  if (aAt === bAt) return 0;
  return aAt < bAt ? -1 : 1;
}

/** The two seats' scores, as a result surface reports them. */
export function puzzleRankedScore(snapshot: PuzzleSessionSnapshot) {
  return {
    puzzleCount: snapshot.puzzleCount,
    player1: {
      solved: snapshot.p1.solved,
      lastSolveAtMs: snapshot.p1.lastSolveAtMs,
    },
    player2: {
      solved: snapshot.p2.solved,
      lastSolveAtMs: snapshot.p2.lastSolveAtMs,
    },
  };
}
