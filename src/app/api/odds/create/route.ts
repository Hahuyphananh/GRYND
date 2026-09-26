import { NextResponse } from "next/server";
import { normalizeStake } from "../../../../lib/games/stakes";
import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../db/client";
import { oddsGames } from "../../../../db/schema";
import { eq, and } from "drizzle-orm";
import { initPvPOddsGame } from "../../../../lib/odds";

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
    // STAKES ARE RETIRED (src/lib/games/stakes.js) — a lobby is free to open.
    const wager = normalizeStake(body.wager);

    // This endpoint only creates PvP lobbies — AI practice mode uses the
    // /api/odds/ai/* routes (free play, no wager deducted).
    const gameState = initPvPOddsGame();

    const newGame = await db.transaction(async (tx: any) => {
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
