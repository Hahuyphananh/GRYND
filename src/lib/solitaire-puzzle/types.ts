// src/lib/solitaire-puzzle/types.ts
//
// Server snapshot vs client projection. The snapshot contains the authoritative
// SolitaireState (face-down identities and stock order included) and must never
// be serialized to a browser. `PuzzleSessionView` is the only shape a route may
// return.

import type {
  PuzzleSessionSpec,
  PuzzleSessionStats,
  PuzzleProgress,
} from "../solitaire-duel/puzzleSession";
import type {
  PublicPuzzleObjective,
} from "../solitaire-duel/puzzleValidation";
import type {
  SolitaireState,
  SolitaireView,
} from "../solitaire-duel/types";
import type {
  PuzzleSessionMode,
  PuzzleSessionReason,
  PuzzleSessionResult,
  PuzzleSessionSeat,
  PuzzleSessionStatus,
} from "./constants";

/** One server-only manifest entry. The spec includes the hidden start state. */
export type PuzzleManifestEntry = {
  /** Opaque display slot, 0-based. Never an internal library lookup key. */
  slot: number;
  id: string;
  level: string;
  category: string;
  objectiveText: string;
  concept: string;
  spec: PuzzleSessionSpec;
};

/** Authoritative per-seat state. Stored as JSONB and never sent to a browser. */
export type PuzzleSeatSnapshot = {
  puzzleIndex: number;
  solved: number;
  /** Monotonic accepted-move cursor for this seat across the whole session. */
  ply: number;
  state: SolitaireState;
  stats: PuzzleSessionStats;
  lastSolveAtMs: number | null;
  finishedAtMs: number | null;
  lastActionAtMs: number | null;
  /** Remaining lives, 3 at the start. Zero ends the match. */
  lives: number;
  /** Absolute end of the seat's current 60-second puzzle clock. */
  puzzleDeadlineAtMs: number | null;
};

/** Server-only session snapshot; the store maps a database row into this. */
export type PuzzleSessionSnapshot = {
  id: string;
  mode: PuzzleSessionMode;
  status: PuzzleSessionStatus;
  player1Id: string;
  player2Id: string | null;
  isAi: boolean;
  aiDifficulty: string | null;
  manifest: PuzzleManifestEntry[];
  puzzleCount: number;
  /** True when the frozen stream grows instead of ending after five puzzles. */
  endless: boolean;
  selectionSeed: string;
  selectionHash: string;
  p1: PuzzleSeatSnapshot;
  p2: PuzzleSeatSnapshot;
  goAtMs: number | null;
  deadlineAtMs: number | null;
  endedAtMs: number | null;
  result: PuzzleSessionResult | null;
  winnerId: string | null;
  resolutionReason: PuzzleSessionReason | null;
  createdAtMs: number;
  updatedAtMs: number;
};

export type PuzzleSessionViewResult = {
  winnerSeat: PuzzleSessionSeat | null;
  result: PuzzleSessionResult;
  resolutionReason: PuzzleSessionReason | null;
  /** The OTHER seat only — never both seats' board or hidden state. */
  opponentId: string | null;
  /**
   * The opponent's display name, resolved for a settled ranked result. Null for
   * the synthetic practice bot (the AI's roster name comes from the picker).
   */
  opponentName?: string | null;
  /** The server's own score for each seat; the result is derived from these. */
  player1: { solved: number; lastSolveAtMs: number | null };
  player2: { solved: number; lastSolveAtMs: number | null };
  /** The viewer's own applied rating/trophy deltas, when a writer journal exists. */
  reward: PuzzleReward | null;
};

/** Rating/trophy movement applied to the viewing player for one session. */
export type PuzzleReward = {
  ratingDelta: number | null;
  trophiesDelta: number | null;
};

/** One settled Puzzle Ranked match, as the player's history reports it. */
export type PuzzleRankedHistoryEntry = {
  sessionId: string;
  seat: PuzzleSessionSeat;
  status: PuzzleSessionStatus;
  opponentId: string | null;
  puzzleCount: number;
  youSolved: number;
  opponentSolved: number;
  youLastSolveAtMs: number | null;
  opponentLastSolveAtMs: number | null;
  goAtMs: number | null;
  deadlineAtMs: number | null;
  endedAtMs: number | null;
  createdAtMs: number;
  result: PuzzleSessionViewResult | null;
};

/**
 * The ONLY puzzle-session shape a route returns.
 *
 * `board` is `puzzleViewFor` output: face-down cards carry `card: null`,
 * `nextStockCard` is always null, and no stock order is present. It is null
 * while the session is still waiting, so neither seat can study (or start) its
 * puzzles before both are seated and the shared clock starts. The puzzle
 * metadata is projected from the manifest; accepted solutions and verification
 * data never enter this type.
 */
export type PuzzleSessionView = {
  sessionId: string;
  mode: PuzzleSessionMode;
  status: PuzzleSessionStatus;
  seat: PuzzleSessionSeat;
  puzzleNumber: number;
  puzzleCount: number;
  puzzle: {
    slot: number;
    level: string;
    category: string;
    objectiveText: string;
    concept: string;
    objective: PublicPuzzleObjective;
    constraints: { maxMoves?: number; maxStockPasses?: number };
    par: number;
  };
  board: SolitaireView | null;
  /**
   * The VIEWER'S own accepted-move cursor (never the opponent's). It is the
   * value a move submission echoes as `expectedPly`, so a stale tab is refused
   * instead of applying an unintended move. It carries no hidden information.
   */
  ply: number;
  progress: PuzzleProgress;
  solvedCount: number;
  opponentSolvedCount: number;
  /** The viewer's own remaining lives, and the opponent's. */
  lives: number;
  opponentLives: number;
  /** The viewer's own 60-second clock; null while the session waits. */
  puzzleDeadlineAtMs: number | null;
  startedAtMs: number | null;
  deadlineAtMs: number | null;
  serverNowMs: number;
  result: PuzzleSessionViewResult | null;
  duplicate?: boolean;
};
