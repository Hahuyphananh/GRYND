// src/lib/crash-poker/types.ts
//
// TypeScript view of the plain-JS hand object produced by
// `src/lib/crash-poker/roundSystem.js` (stored in crash_arena_rounds.hand_state
// as jsonb). The engine itself is JS for zero-friction unit tests; these
// types let the TS API routes / settlement module work with it safely.

export interface CrashPokerPlayer {
  userId: number;
  name?: string | null;
  contributed: number;
  isActive: boolean;
  folded: boolean;
  foldedAtMultiplier: number | null;
  lastAction: string | null;
  /** Committed their whole remaining stack — can no longer fold. */
  allIn: boolean;
}

export interface CrashPokerAction {
  userId: number;
  action: string;
  multiplier: number;
  at: string;
}

export interface CrashPokerHand {
  /** The table wager — the flat ante every player posts. */
  wager: number;
  carryOver: number;
  pot: number;
  players: CrashPokerPlayer[];
  /** Chronological fold log (audit + fold-order tie-break). */
  actions: CrashPokerAction[];
  /** Epoch-ms the curve started (hand start). Continuous — never re-anchors. */
  flightResumedAt: number | null;
}

/** One ranked payout at settlement (rank 1 = winner). */
export interface CrashPokerPayout {
  userId: number;
  rank: number;
  amount: number;
}