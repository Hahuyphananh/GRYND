import {
  createMatchLifecycle,
  transitionMatchLifecycle,
} from "../matchLifecycleStore";
import type { MatchCancelReason, MatchLifecycleStatus } from "../matchLifecycle";

const PRECISION_GAME_KEY = "precision";

/**
 * Shadow/dual-write adapter for the current Precision in-memory flow.
 * Lifecycle persistence must never prevent the game route from responding,
 * so failures are logged and deliberately isolated from gameplay.
 */
export function mirrorPrecisionQueued(input: {
  matchId: string;
  mode?: string;
  playerCount?: number;
  queuedAt?: Date;
}): void {
  void createMatchLifecycle({
    matchId: input.matchId,
    gameKey: PRECISION_GAME_KEY,
    mode: input.mode ?? "pvp",
    playerCount: input.playerCount ?? 1,
    queuedAt: input.queuedAt,
  }).catch((error) => {
    console.error("[precision] canonical lifecycle queue mirror failed", error);
  });
}

export function mirrorPrecisionTransition(input: {
  matchId: string;
  status: Extract<MatchLifecycleStatus, "started" | "completed" | "cancelled" | "failed" | "expired">;
  playerCount?: number;
  cancelReason?: MatchCancelReason;
  at?: Date;
}): void {
  void transitionMatchLifecycle({
    matchId: input.matchId,
    to: input.status,
    playerCount: input.playerCount,
    cancelReason: input.cancelReason,
    at: input.at,
  }).catch((error) => {
    console.error("[precision] canonical lifecycle transition mirror failed", error);
  });
}
