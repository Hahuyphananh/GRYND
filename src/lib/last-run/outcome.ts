// src/lib/last-run/outcome.ts
//
// PURE completion → settlement plan. No database, no clock, no I/O, so the
// mapping that decides "who is the winner seat" is trivially testable and is
// the ONLY place that mapping exists.
//
// The input is the registry's server-derived completion record: the engine's own
// final result plus the server's survival times and distances. Nothing here is
// client-supplied, and nothing here can be influenced by a client.

import { LAST_RUN_GAME_KEY } from "./constants";

export type LastRunSeat = "player1" | "player2";
export type LastRunResult = LastRunSeat | "draw";

/** A completion, already derived from the authoritative match by the registry. */
export type LastRunCompletion = {
  matchId: string;
  seed: number;
  queuedAt: number;
  startedAt: number;
  endedAt: number;
  result: LastRunResult;
  reason: string;
  player1Id: string;
  player2Id: string;
  durations: Record<LastRunSeat, number>;
  distances: Record<LastRunSeat, number>;
  playerCount: number;
};

export type SettlementPlan = {
  /** The shared Elo/trophy writer's seat-A id (the draw's first seat). */
  winnerClerkId: string;
  /** The shared writer's seat-B id. */
  loserClerkId: string;
  /** `win` or `draw` — the vocabulary applyRatingResult expects. */
  result: "win" | "draw";
  /** The recorded winner, or null for a draw. */
  winnerId: string | null;
  outcome: "win" | "loss" | "draw";
};

/**
 * Validate a completion and derive the settlement arguments.
 *
 * Returns null for anything the database must refuse: a missing seat, the same
 * player in both seats, or an unknown result. The caller turns null into a
 * thrown error, which rolls the whole settlement transaction back.
 */
export function planSettlement(
  completion: Pick<LastRunCompletion, "player1Id" | "player2Id" | "result">,
): SettlementPlan | null {
  const p1 = String(completion.player1Id ?? "").trim();
  const p2 = String(completion.player2Id ?? "").trim();
  if (!p1 || !p2 || p1 === p2) return null;

  if (completion.result === "draw") {
    return {
      winnerClerkId: p1,
      loserClerkId: p2,
      result: "draw",
      winnerId: null,
      outcome: "draw",
    };
  }
  if (completion.result !== "player1" && completion.result !== "player2") return null;

  const winnerClerkId = completion.result === "player1" ? p1 : p2;
  const loserClerkId = completion.result === "player1" ? p2 : p1;
  return { winnerClerkId, loserClerkId, result: "win", winnerId: winnerClerkId, outcome: "win" };
}

/**
 * The additive `payload.metadata` written on the canonical completion event.
 *
 * It mirrors the typed match row (participants + outcome + server-measured
 * numbers) so the outbox is self-describing, and it carries no simulation
 * frames, no input log and no client claim.
 */
export function completionMetadata(
  completion: LastRunCompletion,
  plan: SettlementPlan,
): Record<string, unknown> {
  return {
    gameKey: LAST_RUN_GAME_KEY,
    result: completion.result,
    reason: completion.reason,
    outcome: plan.outcome,
    winnerId: plan.winnerId,
    player1Id: String(completion.player1Id).trim(),
    player2Id: String(completion.player2Id).trim(),
    // Durations are the SERVER's elapsed times, not client claims.
    durationMs: Math.max(0, completion.endedAt - completion.startedAt),
    survivalMs: {
      player1: Math.max(0, Math.round(completion.durations.player1)),
      player2: Math.max(0, Math.round(completion.durations.player2)),
    },
    distance: {
      player1: Math.max(0, Math.round(completion.distances.player1)),
      player2: Math.max(0, Math.round(completion.distances.player2)),
    },
    seed: completion.seed,
  };
}
