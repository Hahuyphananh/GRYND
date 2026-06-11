import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../../db/client";
import { oddsGames, users } from "../../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { processOddsPick } from "../../../../../lib/odds";
import type { InteractiveOddsState } from "../../../../../lib/odds";
import { applyLeaderboardCounters } from "../../../../../lib/leaderboardCounters";

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const gameId = Number(body.gameId);
    const playerNumber = Number(body.playerNumber);

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

      const state = game.gameState as InteractiveOddsState;
      if (!state || state.gameOver) throw new Error("Game is already over");

      // Validate player number (checked before processing, not recoverable inside tx)
      if (!Number.isFinite(playerNumber) || !Number.isInteger(playerNumber)) {
        throw Object.assign(new Error("Number must be a whole number"), { status: 400 });
      }
      if (playerNumber < 1 || playerNumber > state.currentMax) {
        throw Object.assign(
          new Error(`Number must be between 1 and ${state.currentMax}`),
          { status: 400 },
        );
      }

      const pickResult = processOddsPick(state, playerNumber);
      const payout = game.wager * 2;

      if (pickResult.updatedState.gameOver) {
        const player1Won = pickResult.updatedState.winner === "player1";

        // Credit winnings if player won
        if (player1Won) {
          await tx
            .update(users)
            .set({ balance: sql`${users.balance} + ${payout}` })
            .where(eq(users.clerkId, userId));
        }

        await tx
          .update(oddsGames)
          .set({
            status: "finished",
            winner: pickResult.updatedState.winner,
            result: player1Won ? "won" : "lost",
            payout: player1Won ? payout : 0,
            gameState: pickResult.updatedState,
            endedAt: new Date(),
          })
          .where(eq(oddsGames.id, gameId));

        return {
          pickResult,
          gameStatus: "finished" as const,
          player1Won,
          payout,
          wager: game.wager,
        };
      }

      // Game continues — just update the gameState
      await tx
        .update(oddsGames)
        .set({ gameState: pickResult.updatedState })
        .where(eq(oddsGames.id, gameId));

      return {
        pickResult,
        gameStatus: "playing" as const,
        player1Won: false,
        payout: 0,
      };
    });

    // Track leaderboard OUTSIDE the transaction to avoid deadlocks
    if (result.gameStatus === "finished") {
      await applyLeaderboardCounters({
        clerkId: userId,
        game: "odds",
        betAmount: (result as any).wager,
        payout: result.player1Won ? result.payout : 0,
      }).catch((err) => console.error("Leaderboard error:", err));
    }

    return NextResponse.json({
      success: true,
      data: {
        round: result.pickResult.round,
        playerNumber: result.pickResult.playerNumber,
        aiNumber: result.pickResult.aiNumber,
        matched: result.pickResult.matched,
        isReverse: result.pickResult.isReverse,
        halved: result.pickResult.halved,
        updatedState: result.pickResult.updatedState,
        gameStatus: result.gameStatus,
        winner: result.pickResult.updatedState.winner,
        payout: result.payout,
      },
    });
  } catch (error: any) {
    const status = error?.status === 400 ? 400 : 500;
    return NextResponse.json(
      { success: false, error: error.message || "Failed to process pick" },
      { status },
    );
  }
}
