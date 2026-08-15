import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../../db/client";
import { oddsGames } from "../../../../../db/schema";
import { eq, and, desc } from "drizzle-orm";
import { viewForPlayer } from "../../../../../lib/odds";
import type { InteractiveOddsState } from "../../../../../lib/odds";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    if (!process.env.DATABASE_URL) {
      return NextResponse.json({
        success: true,
        data: { active: false },
      });
    }

    // Find the user's currently active interactive AI game (most recent first)
    const [game] = await db
      .select()
      .from(oddsGames)
      .where(
        and(
          eq(oddsGames.player1Id, userId),
          eq(oddsGames.status, "playing"),
          eq(oddsGames.isAi, true),
        ),
      )
      .orderBy(desc(oddsGames.createdAt))
      .limit(1);

    if (!game) {
      return NextResponse.json({
        success: true,
        data: { active: false },
      });
    }

    const state = game.gameState as InteractiveOddsState;

    // The player is always player1 in AI mode — hide the AI's
    // current-round number until the reveal.
    return NextResponse.json({
      success: true,
      data: {
        active: true,
        gameId: game.id,
        wager: game.wager,
        gameState: state ? viewForPlayer(state, true) : state,
        rounds: state?.rounds ?? [],
        gameOver: state?.gameOver ?? false,
        winner: state?.winner ?? null,
        payout: game.wager * 2,
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || "Failed to fetch status" },
      { status: 500 },
    );
  }
}
