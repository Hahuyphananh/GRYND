import {
  createMatchLifecycle,
  transitionMatchLifecycle,
} from "../matchLifecycleStore";
import type { MatchCancelReason, MatchLifecycleStatus } from "../matchLifecycle";

const PRECISION_GAME_KEY = "precision";

/**
 * Shadow/dual-write adapter for Precision's match lifecycle.
 *
 * Lifecycle persistence must never prevent the game route from responding, so
 * every mirror is fire-and-forget and failures are logged instead of thrown.
 *
 * ── Why the paths below exist ────────────────────────────────────────────
 * The canonical lifecycle is a STATE MACHINE with legal edges only:
 *
 *     queued → forming → ready → started → completed|cancelled|failed|expired
 *
 * Precision reaches `started` in ONE step (two seats appear and both ready),
 * so mirroring that directly was rejected by the store
 * ("Invalid match lifecycle transition: queued -> started") and the whole
 * mirror was silently lost — the shadow row stayed `queued` forever. Walking
 * the legal intermediaries keeps the canonical row truthful: `forming` when
 * the second seat appears, `ready` once both seats are known, `started` when
 * the first round is armed.
 */

/** Legal route to each status from `queued`. */
const TRANSITION_PATHS: Partial<Record<MatchLifecycleStatus, MatchLifecycleStatus[]>> = {
  forming: ["forming"],
  ready: ["forming", "ready"],
  started: ["forming", "ready", "started"],
  completed: ["forming", "ready", "started", "completed"],
  cancelled: ["cancelled"],
  expired: ["expired"],
  failed: ["failed"],
};

const NOT_FOUND = /lifecycle not found/i;
const ILLEGAL = /invalid match lifecycle transition/i;

/**
 * Create the canonical queue row. Called exactly once per match id, when the
 * id is first handed to a player (a new queue entry, a pairing, or a practice
 * match).
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

/**
 * Advance the canonical row to `status`, stepping through every legal
 * intermediary. Idempotent in both directions:
 *   * a step that is already behind the row (the mirror ran twice) is
 *     detected as an illegal edge and stops the walk quietly;
 *   * a missing row (nothing was queued in the first place) is ignored.
 */
export function mirrorPrecisionTransition(input: {
  matchId: string;
  status: Extract<
    MatchLifecycleStatus,
    "forming" | "ready" | "started" | "completed" | "cancelled" | "failed" | "expired"
  >;
  playerCount?: number;
  cancelReason?: MatchCancelReason;
  at?: Date;
}): void {
  const path = TRANSITION_PATHS[input.status] ?? [input.status];
  void (async () => {
    for (const step of path) {
      try {
        await transitionMatchLifecycle({
          matchId: input.matchId,
          to: step,
          playerCount: input.playerCount,
          cancelReason: step === "cancelled" ? input.cancelReason : undefined,
          at: input.at,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ILLEGAL.test(message) || NOT_FOUND.test(message)) return;
        throw error;
      }
    }
  })().catch((error) => {
    console.error("[precision] canonical lifecycle transition mirror failed", error);
  });
}
