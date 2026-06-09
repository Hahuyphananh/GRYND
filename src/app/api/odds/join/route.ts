import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { oddsGames, users } from "../../../../db/schema";
import { eq, sql, and, isNull } from "drizzle-orm";
import { resolveOddsGame } from "../../../../lib/odds";
import { applyLeaderboardCounters } from "../../../../lib/leaderboardCounters";

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
        .where(
          and(
            eq(oddsGames.id, gameId),
            eq(oddsGames.status, "waiting"),
            isNull(oddsGames.player2Id),
          )
        );

      if (!game) throw new Error("Game not found or already joined");
      if (game.player1Id === userId) throw new Error("Cannot join your own game");

      // Deduct wager from joining player
      const [joiner] = await tx
        .update(users)
        .set({ balance: sql`${users.balance} - ${game.wager}` })
        .where(and(eq(users.clerkId, userId), sql`${users.balance} >= ${game.wager}`))
        .returning();

      if (!joiner) throw new Error("Insufficient balance");

      // Resolve the game
      const gameState = resolveOddsGame(game.wager);
      const player1Won = gameState.winner === "player1";
      const winnerId = player1Won ? game.player1Id : userId;

      // Update the game
      const [updated] = await tx
        .update(oddsGames)
        .set({
          player2Id: userId,
          status: "finished",
          winner: gameState.winner,
          result: player1Won ? "player1_won" : "player2_won",
          payout: game.wager * 2,
          gameState,
          endedAt: new Date(),
        })
        .where(eq(oddsGames.id, gameId))
        .returning();

      // Pay winner
      await tx
        .update(users)
        .set({ balance: sql`${users.balance} + ${game.wager * 2}` })
        .where(eq(users.clerkId, winnerId));

      return { updated, winnerId, gameState };
    });

    // Apply leaderboard counters (outside transaction)
    const player1Won = result.gameState.winner === "player1";
    const loserId = player1Won ? result.updated.player2Id : result.updated.player1Id;

    await applyLeaderboardCounters({
      clerkId: result.winnerId,
      game: "odds",
      betAmount: result.updated.wager,
      payout: result.updated.wager * 2,
      isPvpWin: true,
    }).catch(() => {});

    await applyLeaderboardCounters({
      clerkId: loserId!,
      game: "odds",
      betAmount: result.updated.wager,
      payout: 0,
      isPvpWin: false,
    }).catch(() => {});

    return NextResponse.json({
      success: true,
      data: {
        gameId: result.updated.id,
        gameState: result.gameState,
        winner: result.gameState.winner,
        result: result.updated.result,
        payout: result.updated.payout,
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || "Failed to join game" },
      { status: 500 }
    );
  }
}
