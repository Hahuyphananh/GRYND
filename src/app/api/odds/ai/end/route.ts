import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../../db/client";
import { oddsGames, users } from "../../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { applyLeaderboardCounters } from "../../../../../lib/leaderboardCounters";
import type { InteractiveOddsState } from "../../../../../lib/odds";

export async function POST(req: Request) {
  try {
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
      const payout = game.wager * 2;

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

      // AI games are free play — `game.isAi` is guaranteed true for this
      // route, but the guard keeps the credit logic defensive. Never pay
      // out on AI-mode game end even if the persisted `wager` is non-zero.
      if (player1Won && !game.isAi) {
        // Credit winnings to the player
        await tx
          .update(users)
          .set({ balance: sql`${users.balance} + ${payout}` })
          .where(eq(users.clerkId, userId));
      }

      // Recorded payout is 0 in AI mode so history reflects the free-play
      // outcome rather than a phantom `wager * 2` credit.
      const recordedPayout = game.isAi ? 0 : player1Won ? payout : 0;

      const finalState: InteractiveOddsState = state
        ? { ...state, winner, gameOver: true }
        : {
            currentMax: 100,
            currentStarter: "player1" as const,
            phase: "first_attempt" as const,
            rounds: [],
            winner,
            firstStarter: "player1" as const,
            gameOver: true,
          };

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

      // Track leaderboard — AI-mode wins/losses use the actual wager value
      // for visibility, but the payout column on the game is 0.
      await applyLeaderboardCounters({
        clerkId: userId,
        game: "odds",
        betAmount: game.wager,
        payout: recordedPayout,
      }).catch(() => {});

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
