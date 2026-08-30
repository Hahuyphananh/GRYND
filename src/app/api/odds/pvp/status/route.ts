import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../../db/client";
import { oddsGames } from "../../../../../db/schema";
import { eq, and, or, desc } from "drizzle-orm";
import { viewForPlayer } from "../../../../../lib/odds";
import type { PvPInteractiveOddsState } from "../../../../../lib/odds";

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


    // Find the user's most recent active interactive PvP game
    const [game] = await db
      .select()
      .from(oddsGames)
      .where(
        and(
          or(eq(oddsGames.player1Id, userId), eq(oddsGames.player2Id, userId)),
          eq(oddsGames.status, "playing"),
          eq(oddsGames.isAi, false),
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

    const isPlayer1 = game.player1Id === userId;
    const opponentId = isPlayer1 ? game.player2Id : game.player1Id;
    const state = game.gameState as PvPInteractiveOddsState | null;

    // Phase-aware: has the user already submitted their part of the
    // current phase (number in "pick", prediction in "predict")?
    const userHasPendingPick =
      state &&
      !state.gameOver &&
      ((state.phase === "predict" &&
        (isPlayer1 ? state.player1Prediction !== null : state.player2Prediction !== null)) ||
        (state.phase === "pick" &&
          (isPlayer1 ? state.player1Pick !== null : state.player2Pick !== null)));

    return NextResponse.json({
      success: true,
      data: {
        active: true,
        gameId: game.id,
        wager: game.wager,
        isPlayer1,
        opponentId,
        gameState: state ? viewForPlayer(state, isPlayer1) : null,
        rounds: state?.rounds ?? [],
        gameOver: state?.gameOver ?? false,
        winner: state?.winner ?? null,
        payout: game.wager * 1.9,
        userHasPendingPick,
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || "Failed to fetch PvP status" },
      { status: 500 },
    );
  }
}
