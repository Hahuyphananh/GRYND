import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../../db/client";
import { oddsGames, users } from "../../../../../db/schema";
import { eq, sql, and } from "drizzle-orm";
import { initInteractiveOddsGame } from "../../../../../lib/odds";
import { coerceAiDifficulty } from "../../../../../lib/aiDifficulty";
import { normalizeStake } from "../../../../../lib/games/stakes";

export async function POST(req: Request) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    // STAKES ARE RETIRED (src/lib/games/stakes.js): an AI match is free play.
    // The requested wager is normalized to 0 so the match row, the HUD and the
    // history never carry a stake — and no rejection can block free play.
    const requested = normalizeStake(body.wager);
    // The lobby's AI tier; absent/invalid coerces to `normal` in the store.
    const aiDifficulty = coerceAiDifficulty(body?.difficulty);

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
          wager: requested,
          status: "playing",
          isAi: true,
          aiDifficulty,
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
