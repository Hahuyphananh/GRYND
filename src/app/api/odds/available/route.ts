import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { oddsGames, users } from "../../../../db/schema";
import { eq, desc } from "drizzle-orm";

export async function GET() {
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


    const games = await db
      .select({
        id: oddsGames.id,
        player1Id: oddsGames.player1Id,
        wager: oddsGames.wager,
        createdAt: oddsGames.createdAt,
      })
      .from(oddsGames)
      .where(eq(oddsGames.status, "waiting"))
      .orderBy(desc(oddsGames.createdAt));

    // Enrich with player names
    const enriched = await Promise.all(
      games.map(async (game) => {
        const [player] = await db
          .select({ name: users.name })
          .from(users)
          .where(eq(users.clerkId, game.player1Id));
        return {
          ...game,
          player1Name: player?.name || "Unknown Player",
        };
      })
    );

    return NextResponse.json({
      success: true,
      data: { games: enriched },
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || "Failed to fetch games" },
      { status: 500 }
    );
  }
}
