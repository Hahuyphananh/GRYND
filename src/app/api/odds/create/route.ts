import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { oddsGames, users } from "../../../../db/schema";
import { eq, sql, and } from "drizzle-orm";
import { resolveOddsGame, initPvPOddsGame } from "../../../../lib/odds";
import { applyLeaderboardCounters } from "../../../../lib/leaderboardCounters";

export async function POST(req: Request) {
  try {
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
    const wager = Number(body.wager);
    const isAi = body.isAi === true;

    if (!Number.isFinite(wager) || wager <= 0) {
      return NextResponse.json({ error: "Invalid wager amount" }, { status: 400 });
    }

    if (wager > 10000) {
      return NextResponse.json({ error: "Wager exceeds maximum limit" }, { status: 400 });
    }

    const isInteractivePvP = !isAi;
    const gameState = isAi ? resolveOddsGame(wager) : initPvPOddsGame();

    const newGame = await db.transaction(async (tx: any) => {
      const [creator] = await tx
        .update(users)
        .set({ balance: sql`${users.balance} - ${wager}` })
        .where(and(eq(users.clerkId, userId), sql`${users.balance} >= ${wager}`))
        .returning();

      if (!creator) throw new Error("Insufficient balance");

      const status = isAi ? "finished" : "waiting";
      const player1Won = isAi && gameState.winner === "player1";

      const [game] = await tx
        .insert(oddsGames)
        .values({
          player1Id: userId,
          player2Id: isAi ? "AI" : null,
          wager,
          status,
          winner: isAi ? gameState.winner : null,
          result: isAi ? (player1Won ? "won" : "lost") : null,
          payout: isAi ? (player1Won ? wager * 2 : 0) : null,
          isAi,
          gameState,
          endedAt: isAi ? new Date() : null,
        })
        .returning();

      // Credit winnings for AI games when player wins
      if (isAi && player1Won) {
        await tx
          .update(users)
          .set({ balance: sql`${users.balance} + ${wager * 2}` })
          .where(eq(users.clerkId, userId));
      }

      return game;
    });

    // Track leaderboard for AI mode
    if (isAi) {
      const player1Won = gameState.winner === "player1";
      await applyLeaderboardCounters({
        clerkId: userId,
        game: "odds",
        betAmount: wager,
        payout: player1Won ? wager * 2 : 0,
      }).catch(() => {});
    }

    return NextResponse.json({
      success: true,
      data: {
        gameId: newGame.id,
        wager: newGame.wager,
        isAi: newGame.isAi,
        gameState: newGame.gameState,
        status: newGame.status,
        winner: newGame.winner,
        result: newGame.result,
        payout: newGame.payout,
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || "Failed to create game" },
      { status: 500 }
    );
  }
}
