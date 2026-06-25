import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../../db/client";
import { oddsGames, users } from "../../../../../db/schema";
import { eq, sql, and } from "drizzle-orm";
import { initInteractiveOddsGame } from "../../../../../lib/odds";

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const wager = Number(body.wager);

    if (!Number.isFinite(wager) || wager <= 0) {
      return NextResponse.json({ error: "Invalid wager amount" }, { status: 400 });
    }

    if (wager > 10000) {
      return NextResponse.json({ error: "Wager exceeds maximum limit" }, { status: 400 });
    }

    if (!process.env.DATABASE_URL) {
      return NextResponse.json(
        { success: false, error: "Database not available" },
        { status: 503 },
      );
    }

    // AI mode is free play — we DO NOT deduct the wager here. We still
    // persist `wager` on the game row for display/history, and the pick/end
    // routes skip any payout when `game.isAi === true` so this can't be
    // exploited as a free-token credit on a player win.
    const gameState = initInteractiveOddsGame();

    const result = await db.transaction(async (tx: any) => {
      const [game] = await tx
        .insert(oddsGames)
        .values({
          player1Id: userId,
          player2Id: "AI",
          wager,
          status: "playing",
          isAi: true,
          gameState,
        })
        .returning();

      return { game, gameState };
    });

    return NextResponse.json({
      success: true,
      data: {
        gameId: result.game.id,
        wager: result.game.wager,
        gameState: result.gameState,
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || "Failed to start game" },
      { status: 500 },
    );
  }
}
