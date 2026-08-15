import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { oddsGames, users } from "../../../../db/schema";
import { eq, sql, and } from "drizzle-orm";
import { initPvPOddsGame } from "../../../../lib/odds";

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

    if (!Number.isFinite(wager) || wager <= 0) {
      return NextResponse.json({ error: "Invalid wager amount" }, { status: 400 });
    }

    if (wager > 10000) {
      return NextResponse.json({ error: "Wager exceeds maximum limit" }, { status: 400 });
    }

    // This endpoint only creates PvP lobbies — AI practice mode uses the
    // /api/odds/ai/* routes (free play, no wager deducted).
    const gameState = initPvPOddsGame();

    const newGame = await db.transaction(async (tx: any) => {
      const [creator] = await tx
        .update(users)
        .set({ balance: sql`${users.balance} - ${wager}` })
        .where(and(eq(users.clerkId, userId), sql`${users.balance} >= ${wager}`))
        .returning();

      if (!creator) throw new Error("Insufficient balance");

      const [game] = await tx
        .insert(oddsGames)
        .values({
          player1Id: userId,
          player2Id: null,
          wager,
          status: "waiting",
          winner: null,
          result: null,
          payout: null,
          isAi: false,
          gameState,
          endedAt: null,
        })
        .returning();

      return game;
    });

    return NextResponse.json({
      success: true,
      data: {
        gameId: newGame.id,
        wager: newGame.wager,
        isAi: false,
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
