// src/lib/last-run/settlement.ts
//
// THE ONE PLACE A FINISHED LAST RUN MATCH BECOMES A DATABASE FACT.
//
// ── INPUT ────────────────────────────────────────────────────────────────
//
// A completion record produced by the authoritative registry
// (src/lib/last-run/matchRegistry.ts): the shared engine's own final result,
// the two Clerk ids the server paired, and the server's survival times,
// distances and timestamps. Nothing here comes from a client request body.
//
// ── ONE TRANSACTION ──────────────────────────────────────────────────────
//
// The following commit together or not at all:
//
//   1. `last_run_matches` — INSERT … ON CONFLICT (id) DO NOTHING. The match id
//      is the natural idempotency key, so a retry, a duplicate completion
//      request and a concurrent settle collapse onto ONE row.
//   2. `match_lifecycle` — create the row if the pairing mirror never landed,
//      walk the canonical edges to `completed`, and write the completion event
//      with a deterministic event id (src/lib/last-run/eventIds.ts).
//   3. Elo — `applyRatingResult` (src/lib/rating.js) with the caller's
//      transaction. `rating_events`' (user, game_key, match_id) unique key is
//      the second, database-level guarantee that a rating moves once.
//   4. Trophies — `applyTrophyResult`, same transaction, same journal rules.
//
// A failure anywhere rolls the whole thing back — there is no state in which a
// match is "completed" without its record, or rated without being recorded.
//
// ── OUTSIDE THE TRANSACTION ──────────────────────────────────────────────
//
// Leaderboard/statistics counters (`applyLeaderboardCounters`) use their own
// connection and the shared helper's own idempotency assumptions, so they run
// after COMMIT, best-effort, exactly like every other game's settlement. They
// are statistics: a failure is logged, never surfaced to the player, and never
// changes a result or a rating.
//
// ── DRAWS ────────────────────────────────────────────────────────────────
//
// The game key is written as the STRING LITERAL `"last-run"` at each writer
// call site on purpose: the platform's wiring audits (tests/elo-rating.test.mjs,
// tests/trophy-system.test.mjs) prove every rated game is wired to the shared
// writers by matching `gameKey: "<key>"` in the source, and a constant
// reference would be invisible to them.
//
// A draw (both runners crashing on the same authoritative tick) is settled with
// `result: "draw"`, which the shared writers journal for BOTH seats — the same
// path Tic-Tac-Toe, Mini Golf and Dominoes use. No win counter moves, and the
// record stores `winner_id = NULL`.

import { eq } from "drizzle-orm";

import { db } from "../../db";
import { lastRunMatches, matchLifecycle } from "../../db/schema";
import { applyLeaderboardCounters } from "../leaderboardCounters";
import { canTransitionMatchLifecycle, type MatchLifecycleStatus } from "../matchLifecycle";
import {
  appendMatchLifecycleEvent,
  createMatchLifecycle,
  transitionMatchLifecycle,
} from "../matchLifecycleStore";
import { applyRatingResult } from "../rating";
import { applyTrophyResult } from "../trophyStore";
import { LAST_RUN_GAME_KEY } from "./constants";
import { completionEventId } from "./eventIds";
import {
  completionMetadata,
  planSettlement,
  type LastRunCompletion,
  type SettlementPlan,
} from "./outcome";

export type { LastRunCompletion, LastRunResult, LastRunSeat } from "./outcome";

const MODE = "pvp";

export type SettleResult = {
  /** True when THIS call inserted the match record. */
  settled: boolean;
  /** True when the record already existed (retry / concurrent completion). */
  duplicate: boolean;
  /** True when the shared Elo writer applied this match exactly once. */
  rated: boolean;
  ratingReason?: string;
};

/**
 * Persist one authoritative completion exactly once.
 *
 * Throws only for a completion the database must refuse (identical or missing
 * seats, or a lifecycle row in a terminal non-completed state). Callers on the
 * player path treat every write as best-effort; the result screen never waits.
 */
export async function settleLastRunMatch(completion: LastRunCompletion): Promise<SettleResult> {
  const plan = planSettlement(completion);
  if (!plan) {
    throw new Error("last-run: completion must name two distinct registered seats");
  }
  const metadata = completionMetadata(completion, plan);

  const outcome = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(lastRunMatches)
      .values({
        id: completion.matchId,
        player1Id: completion.player1Id,
        player2Id: completion.player2Id,
        winnerId: plan.winnerId,
        result: completion.result,
        endReason: completion.reason,
        player1Distance: Math.max(0, Math.round(completion.distances.player1)),
        player2Distance: Math.max(0, Math.round(completion.distances.player2)),
        player1SurvivalMs: Math.max(0, Math.round(completion.durations.player1)),
        player2SurvivalMs: Math.max(0, Math.round(completion.durations.player2)),
        durationMs: Math.max(0, completion.endedAt - completion.startedAt),
        seed: completion.seed,
        rated: false,
        startedAt: new Date(completion.startedAt),
        endedAt: new Date(completion.endedAt),
      })
      .onConflictDoNothing()
      .returning({ id: lastRunMatches.id });

    // The record already exists: a previous settlement committed (or another
    // concurrent request won the insert). Nothing is applied twice.
    if (!inserted) return { duplicate: true as const, rating: null };

    // ── Canonical lifecycle: queued → forming → ready → started → completed ──
    // A pairing mirror can be lost (server restart, a transient DB error), so
    // the settlement REBUILDS the path instead of assuming it exists. Every
    // transition is status-guarded, so an existing row simply skips the edges
    // it has already taken.
    const queuedAt = new Date(Math.min(completion.queuedAt, completion.startedAt));
    let row =
      (
        await tx
          .select()
          .from(matchLifecycle)
          .where(eq(matchLifecycle.matchId, completion.matchId))
          .limit(1)
      )[0] ?? null;

    if (!row) {
      row = await createMatchLifecycle({
        matchId: completion.matchId,
        gameKey: LAST_RUN_GAME_KEY,
        mode: MODE,
        playerCount: 2,
        queuedAt,
        tx,
      });
    }

    const startedAt = new Date(completion.startedAt);
    for (const target of ["forming", "ready", "started"] as const) {
      if (!row || !canTransitionMatchLifecycle(row.status as MatchLifecycleStatus, target)) continue;
      row = await transitionMatchLifecycle({
        tx,
        matchId: completion.matchId,
        to: target,
        at: startedAt,
        playerCount: 2,
      });
    }

    const endedAt = new Date(completion.endedAt);
    const eventId = completionEventId(completion.matchId);
    if (row && row.status === "completed") {
      // Repair path: completed by an earlier write that lost its event. The
      // deterministic event id means this can only ever add the SAME row.
      await appendMatchLifecycleEvent({ tx, row, eventId, at: endedAt, metadata });
    } else if (row && canTransitionMatchLifecycle(row.status as MatchLifecycleStatus, "completed")) {
      await transitionMatchLifecycle({
        tx,
        matchId: completion.matchId,
        to: "completed",
        at: endedAt,
        playerCount: 2,
        eventId,
        metadata,
      });
    } else {
      // cancelled / expired / failed — a completion must not resurrect it.
      throw new Error(
        `last-run: lifecycle cannot complete from ${row?.status ?? "missing"}`,
      );
    }

    // ── Elo, inside the same transaction ────────────────────────────────
    // A refusal (e.g. a seat's user row no longer exists) is NOT allowed to
    // discard the match record: the result happened. It is stored as
    // `rated = false` and the reason is logged.
    const rating = (await applyRatingResult({
      tx,
      gameKey: "last-run",
      matchId: completion.matchId,
      winnerClerkId: plan.winnerClerkId,
      loserClerkId: plan.loserClerkId,
      result: plan.result,
    }).catch((error: unknown) => {
      console.error(
        "[last-run] rating writer failed:",
        error instanceof Error ? error.message : error,
      );
      return { applied: false, reason: "writer-error" };
    })) as { applied?: boolean; reason?: string };

    if (rating?.applied) {
      // Trophies reuse the same RATED_GAMES registry, so this cannot drift.
      await applyTrophyResult({
        tx,
        gameKey: LAST_RUN_GAME_KEY,
        matchId: completion.matchId,
        winnerClerkId: plan.winnerClerkId,
        loserClerkId: plan.loserClerkId,
        result: plan.result,
      }).catch((error: unknown) => {
        console.error(
          "[last-run] trophy writer failed:",
          error instanceof Error ? error.message : error,
        );
      });

      await tx
        .update(lastRunMatches)
        .set({ rated: true })
        .where(eq(lastRunMatches.id, completion.matchId));
    }

    return { duplicate: false as const, rating };
  });

  if (!outcome.duplicate) void applyCounters(plan);

  return {
    settled: !outcome.duplicate,
    duplicate: outcome.duplicate,
    rated: Boolean(outcome.rating?.applied),
    ratingReason: outcome.rating?.applied ? undefined : outcome.rating?.reason,
  };
}

/**
 * Statistics only — never a result, never a rating, never a coin.
 *
 * Uses the platform's existing shared counters (weekly wins/losses, streaks,
 * win rate, pvp wins). Draws are deliberately skipped: the shared writer has no
 * draw branch, so a draw enters neither the win nor the loss counter — exactly
 * how every other drawing game behaves.
 */
async function applyCounters(plan: SettlementPlan): Promise<void> {
  if (plan.result === "draw") return;
  try {
    await Promise.all([
      applyLeaderboardCounters({
        clerkId: plan.winnerClerkId,
        game: LAST_RUN_GAME_KEY,
        outcome: "win",
        isPvpWin: true,
      }),
      applyLeaderboardCounters({
        clerkId: plan.loserClerkId,
        game: LAST_RUN_GAME_KEY,
        outcome: "loss",
        isPvpWin: false,
      }),
    ]);
  } catch (error) {
    console.error(
      "[last-run] leaderboard counters failed:",
      error instanceof Error ? error.message : error,
    );
  }
}
