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
    const requested = Number(body.wager);

    // An AI match is FREE PLAY: the client sends no stake (0), which is the
    // normal case here — not an invalid wager. Reject only malformed input
    // (NaN/Infinity) or a negative stake.
    if (!Number.isFinite(requested) || requested < 0) {
      return NextResponse.json({ error: "Invalid wager amount" }, { status: 400 });
    }

    if (requested > 10000) {
      return NextResponse.json({ error: "Wager exceeds maximum limit" }, { status: 400 });
    }

    if (!process.env.DATABASE_URL) {
      return NextResponse.json(
        { success: false, error: "Database not available" },
        { status: 503 },
      );
    }

    // AI mode is free play: nothing is ever deducted, and the match is
    // recorded with a 0 stake (the client sends no wager) so the game row,
    // the in-game HUD and the history never show a phantom stake. The pick
    // and end routes also skip every payout when `game.isAi === true`, so
    // this can't be exploited as a free-token credit on a player win.
    const gameState = initInteractiveOddsGame();

    const result = await db.transaction(async (tx: any) => {
      const [game] = await tx
        .insert(oddsGames)
        .values({
          player1Id: userId,
          player2Id: "AI",
          wager: 0,
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
