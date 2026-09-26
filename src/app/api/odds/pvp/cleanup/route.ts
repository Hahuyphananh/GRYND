import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../../db/client";
import { oddsGames } from "../../../../../db/schema";
import { eq, and } from "drizzle-orm";
import type { PvPInteractiveOddsState } from "../../../../../lib/odds";
import { applyLeaderboardCounters } from "../../../../../lib/leaderboardCounters";
import { applyRatingResult } from "../../../../../lib/rating";
import { applyTrophyResult } from "../../../../../lib/trophyStore";

/** Maximum time (ms) a player can stay inactive before being auto-forfeited */
const TIMEOUT_MS = 120_000;

export async function POST(req: Request) {
  try {
    // Require auth — callers should be authenticated (or use a secret key)
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // Find all active PvP games
    const games = await db
      .select()
      .from(oddsGames)
      .where(and(eq(oddsGames.status, "playing"), eq(oddsGames.isAi, false)));

    let forfeited = 0;

    for (const game of games) {
      const state = game.gameState as PvPInteractiveOddsState | null;
      if (!state || state.gameOver) continue;

      const now = Date.now();
      const roundAge = state.roundStartedAt ? now - state.roundStartedAt : 0;
      if (roundAge <= TIMEOUT_MS) continue;

      // Game has been inactive too long — determine who to forfeit.
      // Phase-aware: in "pick" a player must lock in their number, in
      // "predict" they must submit their prediction.
      const p1Done =
        state.phase === "predict"
          ? state.player1Prediction !== null
          : state.player1Pick !== null;
      const p2Done =
        state.phase === "predict"
          ? state.player2Prediction !== null
          : state.player2Pick !== null;

      // Only forfeit when exactly one player hasn't completed their part
      // of the current phase (the inactive one)
      if (p1Done && !p2Done) {
        // Player 2 timed out
        await forfeitPlayer(game.id, game.player2Id!, game.player1Id, game.wager, "player1");
        forfeited++;
      } else if (!p1Done && p2Done) {
        // Player 1 timed out
        await forfeitPlayer(game.id, game.player1Id, game.player2Id!, game.wager, "player2");
        forfeited++;
      } else if (!p1Done && !p2Done) {
        // Both inactive — game abandoned. Cancel it (refund both).
        // Only trigger if the game has been idle for more than 2x timeout
        if (roundAge > TIMEOUT_MS * 2) {
          await cancelAbandonedGame(game.id, game.player1Id, game.player2Id!, game.wager);
          forfeited++;
        }
      }
      // If both done (should have been resolved), skip
    }

    return NextResponse.json({
      success: true,
      data: { cleaned: forfeited, checked: games.length },
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || "Cleanup failed" },
      { status: 500 },
    );
  }
}

async function forfeitPlayer(
  gameId: number,
  forfeiterId: string,
  winnerId: string,
  wager: number,
  winner: "player1" | "player2",
) {
  // STAKES ARE RETIRED: no pot, no rake and no payout to move.
  const payout = 0;

  await db.transaction(async (tx: any) => {
    // Lock the row
    const [game] = await tx
      .select()
      .from(oddsGames)
      .where(eq(oddsGames.id, gameId))
      .for("update");

    if (!game || game.status !== "playing") return;

    // Persist the game-over state so polls/refetches reflect the end.
    const forfeitedState = game.gameState
      ? { ...(game.gameState as any), gameOver: true, winner }
      : undefined;

    // Mark game as finished (forfeit)
    await tx
      .update(oddsGames)
      .set({
        status: "finished",
        winner,
        result: winner === "player1" ? "player1_won" : "player2_won",
        payout,
        ...(forfeitedState ? { gameState: forfeitedState } : {}),
        endedAt: new Date(),
      })
      .where(eq(oddsGames.id, gameId));

    // Leaderboard counters (fire-and-forget)
    applyLeaderboardCounters({
      clerkId: winnerId,
      game: "odds",
      betAmount: wager,
      payout,
      isPvpWin: true,
    }).catch(() => {});
    applyLeaderboardCounters({
      clerkId: forfeiterId,
      game: "odds",
      betAmount: wager,
      payout: 0,
      isPvpWin: false,
    }).catch(() => {});

    // Per-game Elo — inactivity forfeit: the opponent wins, the idle player
    // records the loss. Both sides come from the game row, never the client.
    applyRatingResult({
      gameKey: "odds-pvp",
      matchId: String(gameId),
      winnerClerkId: winnerId,
      loserClerkId: forfeiterId,
    }).catch(() => {});
    // Per-game trophies — the same authoritative forfeit (+30 / −30).
    applyTrophyResult({
      gameKey: "odds-pvp",
      matchId: String(gameId),
      winnerClerkId: winnerId,
      loserClerkId: forfeiterId,
    }).catch(() => {});
  });
}

async function cancelAbandonedGame(
  gameId: number,
  player1Id: string,
  player2Id: string,
  wager: number,
) {
  await db.transaction(async (tx: any) => {
    const [game] = await tx
      .select()
      .from(oddsGames)
      .where(eq(oddsGames.id, gameId))
      .for("update");

    if (!game || game.status !== "playing") return;

    // Persist the game-over state so polls/refetches reflect the end.
    const cancelledState = game.gameState
      ? { ...(game.gameState as any), gameOver: true, winner: null }
      : undefined;

    // Mark game as cancelled
    await tx
      .update(oddsGames)
      .set({
        status: "finished",
        winner: null,
        result: "cancelled",
        payout: 0,
        ...(cancelledState ? { gameState: cancelledState } : {}),
        endedAt: new Date(),
      })
      .where(eq(oddsGames.id, gameId));
  });
}
