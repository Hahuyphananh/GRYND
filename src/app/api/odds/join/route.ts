import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { oddsGames, users } from "../../../../db/schema";
import { eq, sql, and, isNull } from "drizzle-orm";
import { initPvPOddsGame } from "../../../../lib/odds";

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

      // Initialize interactive PvP game state
      const gameState = initPvPOddsGame();

      // Update the game — status "playing", game is now interactive
      const [updated] = await tx
        .update(oddsGames)
        .set({
          player2Id: userId,
          status: "playing",
          gameState,
        })
        .where(eq(oddsGames.id, gameId))
        .returning();

      return { updated, gameState };
    });

    return NextResponse.json({
      success: true,
      data: {
        gameId: result.updated.id,
        wager: result.updated.wager,
        player1Id: result.updated.player1Id,
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
