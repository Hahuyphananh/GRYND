import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { oddsGames } from "../../../../db/schema";
import { eq } from "drizzle-orm";

export async function GET(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const url = new URL(req.url);
    const gameId = Number(url.searchParams.get("gameId"));

    if (!Number.isFinite(gameId) || gameId <= 0) {
      return NextResponse.json({ error: "Invalid game ID" }, { status: 400 });
    }

    const [game] = await db
      .select()
      .from(oddsGames)
      .where(eq(oddsGames.id, gameId));

    if (!game) {
      return NextResponse.json({ error: "Game not found" }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      data: {
        id: game.id,
        status: game.status,
        player2Id: game.player2Id,
        gameState: game.gameState,
        winner: game.winner,
        result: game.result,
        payout: game.payout,
        wager: game.wager,
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || "Failed to fetch status" },
      { status: 500 }
    );
  }
}
