import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../db/client";
import { oddsGames } from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { viewForPlayer } from "../../../../lib/odds";

export async function GET(req: Request) {
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

    // Only participants may read a game's state — otherwise a stranger
    // could pull the sanitized view and still learn one side's current
    // submission (e.g. player2's hidden number via the player1 view).
    const isPlayer1 = game.player1Id === userId;
    const isParticipant = isPlayer1 || game.player2Id === userId;
    if (!isParticipant) {
      return NextResponse.json(
        { error: "Not part of this game" },
        { status: 403 },
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        id: game.id,
        status: game.status,
        player2Id: game.player2Id,
        gameState: game.gameState
          ? viewForPlayer(game.gameState as any, isPlayer1)
          : game.gameState,
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
