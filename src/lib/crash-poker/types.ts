// src/lib/crash-poker/types.ts
//
// TypeScript view of the plain-JS hand object produced by
// `src/lib/crash-poker/roundSystem.js` (stored in crash_arena_rounds.hand_state
// as jsonb). The engine itself is JS for zero-friction unit tests; these
// types let the TS API routes / settlement module work with it safely.

export type CrashPokerRole = "sb" | "bb" | "ante";

export interface CrashPokerPlayer {
  userId: number;
  name?: string | null;
  role: CrashPokerRole;
  contributed: number;
  isActive: boolean;
  folded: boolean;
  foldedAtMultiplier: number | null;
  lastAction: string | null;
  actedThisCheckpoint: boolean;
  /** Committed their whole remaining stack — can no longer act. */
  allIn: boolean;
}

export interface CrashPokerAction {
  checkpointIndex: number;
  multiplier: number;
  userId: number;
  action: string;
  amount: number;
  at: string;
}

export interface CrashPokerHand {
  bigBlind: number;
  smallBlind: number;
  dealerPosition: number;
  carryOver: number;
  checkpointIndex: number;
  bettingOpen: boolean;
  requiredBet: number;
  pot: number;
  players: CrashPokerPlayer[];
  actions: CrashPokerAction[];
  /**
   * Epoch-ms the current flight segment started (hand start, or the moment
   * the last checkpoint closed). Drives the pause-aware crash curve.
   */
  flightResumedAt: number | null;
  /** Stall guard: epoch-ms deadline for the open checkpoint window. */
  windowDeadlineAt: number | null;
}
