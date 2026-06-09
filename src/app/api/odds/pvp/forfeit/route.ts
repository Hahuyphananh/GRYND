import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../../db/client";
import { oddsGames, users } from "../../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { applyLeaderboardCounters } from "../../../../../lib/leaderboardCounters";

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
      const payout = game.wager * 2;
      const winner: "player1" | "player2" = forfeiterIsP1
        ? "player2"
        : "player1";

      // Credit winner
      await tx
        .update(users)
        .set({ balance: sql`${users.balance} + ${payout}` })
        .where(eq(users.clerkId, winnerId!));

      // Mark game as finished (forfeit)
      await tx
        .update(oddsGames)
        .set({
          status: "finished",
          winner,
          result: forfeiterIsP1 ? "player2_won" : "player1_won",
          payout,
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
