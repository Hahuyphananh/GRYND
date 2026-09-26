import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../../db/client";
import { oddsGames } from "../../../../../db/schema";
import { eq } from "drizzle-orm";
import { applyLeaderboardCounters } from "../../../../../lib/leaderboardCounters";
import { applyRatingResult } from "../../../../../lib/rating";
import { applyTrophyResult } from "../../../../../lib/trophyStore";

export async function POST(req: Request) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!process.env.DATABASE_URL) {
      return NextResponse.json(
        { success: false, error: "Database not available" },
        { status: 503 },
      );
    }


    const body = await req.json();
    const gameId = Number(body.gameId);

    if (!Number.isFinite(gameId) || gameId <= 0) {
      return NextResponse.json({ error: "Invalid game ID" }, { status: 400 });
    }

    const result = await db.transaction(async (tx: any) => {
      const [game] = await tx
        .select()
        .from(oddsGames)
        .where(eq(oddsGames.id, gameId))
        .for("update");

      if (!game) throw new Error("Game not found");
      if (game.status !== "playing")
        throw new Error("Game is not active");
      if (game.isAi) throw new Error("Cannot forfeit an AI game");

      const isPlayer1 = game.player1Id === userId;
      const isPlayer2 = game.player2Id === userId;
      if (!isPlayer1 && !isPlayer2)
        throw new Error("You are not part of this game");

      const forfeiterIsP1 = isPlayer1;
      const winnerId = forfeiterIsP1 ? game.player2Id : game.player1Id;
      // STAKES ARE RETIRED: no pot, no rake and no payout to move.
      const payout = 0;
      const winner: "player1" | "player2" = forfeiterIsP1
        ? "player2"
        : "player1";

      // Persist the game-over state so the opponent's polls/socket
      // refetches reflect the match ending (not just the forfeiter).
      const forfeitedState = game.gameState
        ? { ...(game.gameState as any), gameOver: true, winner }
        : undefined;

      // Mark game as finished (forfeit)
      await tx
        .update(oddsGames)
        .set({
          status: "finished",
          winner,
          result: forfeiterIsP1 ? "player2_won" : "player1_won",
          payout,
          ...(forfeitedState ? { gameState: forfeitedState } : {}),
          endedAt: new Date(),
        })
        .where(eq(oddsGames.id, gameId));

      // Fire-and-forget leaderboard updates
      applyLeaderboardCounters({
        clerkId: winnerId!,
        game: "odds",
        betAmount: game.wager,
        payout,
        isPvpWin: true,
      }).catch(() => {});
      applyLeaderboardCounters({
        clerkId: userId,
        game: "odds",
        betAmount: game.wager,
        payout: 0,
        isPvpWin: false,
      }).catch(() => {});

      // Per-game Elo — the forfeiter loses, the opponent (winnerId, resolved
      // server-side from the game row) gains. The caller's own id can only
      // ever be the loser here.
      applyRatingResult({
        gameKey: "odds-pvp",
        matchId: String(gameId),
        winnerClerkId: winnerId,
        loserClerkId: userId,
      }).catch(() => {});
      // Per-game trophies — the same authoritative forfeit (+30 / −30).
      applyTrophyResult({
        gameKey: "odds-pvp",
        matchId: String(gameId),
        winnerClerkId: winnerId,
        loserClerkId: userId,
      }).catch(() => {});

      return { winner, payout, winnerId };
    });

    return NextResponse.json({
      success: true,
      data: {
        winner: result.winner,
        payout: result.payout,
        gameId,
      },
    });
  } catch (error: any) {
    const status = error?.status === 400 ? 400 : 500;
    return NextResponse.json(
      { success: false, error: error.message || "Failed to forfeit game" },
      { status },
    );
  }
}
