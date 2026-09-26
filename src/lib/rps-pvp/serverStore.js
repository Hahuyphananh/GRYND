// src/lib/rps-pvp/serverStore.js
//
// Shared server-side helpers for RPS PvP (best-of-7) matches.
// Extracted from the inline settlement in `/api/rps/pvp/forfeit`
// so the user-initiated forfeit route and the realtime-server
// disconnect-forfeit route settle identically.

import { db } from "../../db/client";
import { rpsPvpGames } from "../../db/schema";
import { applyLeaderboardCounters } from "../leaderboardCounters";
import { applyRatingResult } from "../rating";
import { applyTrophyResult } from "../trophyStore";
import { eq } from "drizzle-orm";

// Forfeit an in-progress RPS PvP match. The forfeiter loses and the
// opponent is credited the pot minus the house rake. Only valid while
// the match is `matched` (both players joined); terminal matches are
// left untouched; `active` (waiting) games are cancelled with a full
// refund via the /cancel route instead.
export async function forfeitRpsPvpGame({ userId, gameId }) {
  return await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(rpsPvpGames)
      .where(eq(rpsPvpGames.id, gameId))
      .for("update");

    if (!locked) return { error: "Game not found", status: 404 };
    if (locked.status === "finished" || locked.status === "cancelled") {
      return { error: "Game already finished", status: 400 };
    }
    if (locked.status !== "matched") {
      return { error: "Game is not in progress", status: 400 };
    }
    if (locked.player1Id !== userId && locked.player2Id !== userId) {
      return { error: "Forbidden", status: 403 };
    }

    // The forfeiter loses; the opponent wins the pot minus the rake.
    const forfeiterIsPlayer1 = locked.player1Id === userId;
    const winnerId = forfeiterIsPlayer1
      ? locked.player2Id
      : locked.player1Id;

    const betAmount = Number(locked.betAmount);

    const [finished] = await tx
      .update(rpsPvpGames)
      .set({
        player1Choice: null,
        player2Choice: null,
        outcome: forfeiterIsPlayer1 ? "player2" : "player1",
        winnerId,
        result: forfeiterIsPlayer1 ? "player2" : "player1",
        status: "finished",
        endedAt: new Date(),
      })
      .where(eq(rpsPvpGames.id, gameId))
      .returning();

    return {
      game: finished,
      winnerId,
      winnerPayout: 0,
      forfeiterId: userId,
      betAmount,
    };
  });
}

// Best-effort leaderboard stats for a forfeited match. Failures are
// swallowed so they can never roll the settlement.
export function recordForfeitStats(result) {
  if (!result || !result.game) return;
  applyLeaderboardCounters({
    clerkId: result.winnerId,
    game: "rps-pvp",
    betAmount: Number(result.game.betAmount),
    payout: result.winnerPayout,
    isPvpWin: true,
  }).catch(() => {});
  applyLeaderboardCounters({
    clerkId: result.forfeiterId,
    game: "rps-pvp",
    betAmount: Number(result.game.betAmount),
    payout: 0,
  }).catch(() => {});

  // Per-game Elo — a competitive forfeit (the winner is the opponent who
  // stayed, resolved server-side in the settle transaction above). Runs on
  // its own transaction; the rating_events journal makes a replayed forfeit
  // (disconnect + poll, double submit) a no-op.
  applyRatingResult({
    gameKey: "rps-pvp",
    matchId: String(result.game.id),
    winnerClerkId: result.winnerId,
    loserClerkId: result.forfeiterId,
  }).catch(() => {});
  // Per-game trophies — the same authoritative forfeit (+30 / −30), on the
  // same idempotent path.
  applyTrophyResult({
    gameKey: "rps-pvp",
    matchId: String(result.game.id),
    winnerClerkId: result.winnerId,
    loserClerkId: result.forfeiterId,
  }).catch(() => {});
}
