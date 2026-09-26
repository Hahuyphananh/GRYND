import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../../db/client";
import { oddsGames } from "../../../../../db/schema";
import { eq } from "drizzle-orm";
import { applyLeaderboardCounters } from "../../../../../lib/leaderboardCounters";
import {
  initInteractiveOddsGame,
  type InteractiveOddsState,
} from "../../../../../lib/odds";

export async function POST(req: Request) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const gameId = Number(body.gameId);

    if (!Number.isFinite(gameId) || gameId <= 0) {
      return NextResponse.json({ error: "Invalid game ID" }, { status: 400 });
    }

    if (!process.env.DATABASE_URL) {
      return NextResponse.json(
        { success: false, error: "Database not available" },
        { status: 503 },
      );
    }

    const result = await db.transaction(async (tx: any) => {
      const [game] = await tx
        .select()
        .from(oddsGames)
        .where(eq(oddsGames.id, gameId))
        .for("update");

      if (!game) throw new Error("Game not found");
      if (game.player1Id !== userId) throw new Error("Not your game");
      if (game.status !== "playing") throw new Error("Game is not active");
      if (!game.isAi) throw new Error("Use PvP endpoints for multiplayer games");

      const state = game.gameState as InteractiveOddsState | null;

      // Determine winner: if state has a winner, use it; otherwise resolve via timeout/default
      let winner: "player1" | "player2";
      let player1Won: boolean;

      if (state?.winner) {
        winner = state.winner;
        player1Won = winner === "player1";
      } else {
        // Game ended without a resolved winner – player forfeits/loses
        winner = "player2";
        player1Won = false;
      }

      // STAKES ARE RETIRED: AI games are free play, so nothing is paid out.
      const recordedPayout = 0;

      const finalState: InteractiveOddsState = state
        ? { ...state, winner, gameOver: true }
        : { ...initInteractiveOddsGame(), winner, gameOver: true };

      await tx
        .update(oddsGames)
        .set({
          status: "finished",
          winner,
          result: player1Won ? "won" : "lost",
          payout: recordedPayout,
          gameState: finalState,
          endedAt: new Date(),
        })
        .where(eq(oddsGames.id, gameId));

      // AI games are free play (wager is never deducted) — skip the stats
      // pipeline entirely so beating the AI no longer records a phantom
      // loss (payout 0) in user_stats. Real PvP games settle via
      // /api/odds/pvp/* instead. This route is AI-only (guarded above), so
      // the isAi guard keeps it defensive.
      if (!game.isAi) {
        await applyLeaderboardCounters({
          clerkId: userId,
          game: "odds",
          betAmount: game.wager,
          payout: recordedPayout,
        }).catch(() => {});
      }

      return { winner, player1Won, payout: recordedPayout };
    });

    return NextResponse.json({
      success: true,
      data: {
        gameId,
        winner: result.winner,
        player1Won: result.player1Won,
        payout: result.payout,
      },
    });
  } catch (error: any) {
    const status = error?.status === 400 ? 400 : 500;
    return NextResponse.json(
      { success: false, error: error.message || "Failed to end game" },
      { status },
    );
  }
}
