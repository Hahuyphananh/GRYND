import { auth } from "@clerk/nextjs/server";
import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../../db/client";
import { hexDuelGames, users } from "../../../../../db/schema";
import { recordBigWinIfNeeded } from "../../../../../lib/bigWins";
import { applyLeaderboardCounters } from "../../../../../lib/leaderboardCounters";

const PAYOUT_MULTIPLIER = 1.9;

export async function POST(req: Request) {
  try {
    const { userId: clerkId } = await auth();
    if (!clerkId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const { winner, player1Moves, player2Moves, player1Territory, player2Territory, durationSeconds, startedAt } =
      await req.json() as {
        winner: string;
        player1Moves?: number;
        player2Moves?: number;
        player1Territory?: number;
        player2Territory?: number;
        durationSeconds?: number;
        startedAt?: string;
      };

    if (winner !== "player1" && winner !== "player2") {
      return NextResponse.json({ success: false, error: "Invalid winner" }, { status: 400 });
    }

    // Atomic: find the active multiplayer game and update it
    const result = await db.transaction(async (tx) => {
      // Find an in-progress multiplayer game where the caller is either player1 or player2
      const [game] = await tx
        .select()
        .from(hexDuelGames)
        .where(
          and(
            eq(hexDuelGames.status, "in_progress"),
            sql`(${hexDuelGames.player1Id} = ${clerkId} OR ${hexDuelGames.player2Id} = ${clerkId})`,
          ),
        )
        .for("update")
        .limit(1);

      if (!game) {
        // Check if already completed (idempotent)
        const [completed] = await tx
          .select()
          .from(hexDuelGames)
          .where(
            and(
              eq(hexDuelGames.status, "completed"),
              sql`(${hexDuelGames.player1Id} = ${clerkId} OR ${hexDuelGames.player2Id} = ${clerkId})`,
            ),
          )
          .orderBy(sql`${hexDuelGames.endedAt} DESC`)
          .limit(1);

        if (completed) {
          // Already paid out — return the existing result
          const callerWon =
            (winner === "player1" && completed.player1Id === clerkId) ||
            (winner === "player2" && completed.player2Id === clerkId);
          return {
            alreadyProcessed: true,
            won: callerWon,
            wager: Number(completed.wagerAmount),
            payout: Number(completed.payout || 0),
            multiplier: PAYOUT_MULTIPLIER,
          };
        }

        throw new Error("No active game found");
      }

      const wagerAmount = Number(game.wagerAmount);

      // Determine if the calling player won
      const callerIsPlayer1 = game.player1Id === clerkId;
      const callerWon =
        (callerIsPlayer1 && winner === "player1") ||
        (!callerIsPlayer1 && winner === "player2");

      let payout = 0;
      let newBalance: number | undefined;

      if (callerWon) {
        payout = Number((wagerAmount * PAYOUT_MULTIPLIER).toFixed(2));

        const [updatedUser] = await tx
          .update(users)
          .set({
            balance: sql`${users.balance} + ${payout}`,
            totalWon: sql`${users.totalWon} + ${payout}`,
            gamesWon: sql`${users.gamesWon} + 1`,
            currentStreak: sql`${users.currentStreak} + 1`,
            bestStreak: sql`GREATEST(${users.bestStreak}, ${users.currentStreak} + 1)`,
            biggestWin: sql`GREATEST(${users.biggestWin}, ${payout})`,
          })
          .where(eq(users.clerkId, clerkId))
          .returning({ balance: users.balance });

        newBalance = Number(updatedUser?.[0]?.balance ?? 0);
      } else {
        const [updatedUser] = await tx
          .update(users)
          .set({
            currentStreak: sql`0`,
            gamesLost: sql`${users.gamesLost} + 1`,
          })
          .where(eq(users.clerkId, clerkId))
          .returning({ balance: users.balance });

        newBalance = Number(updatedUser?.[0]?.balance ?? 0);
      }

      // Update the game record
      const endedAt = new Date();
      await tx
        .update(hexDuelGames)
        .set({
          winner,
          result: callerWon ? "win" : "loss",
          payout: payout > 0 ? payout.toFixed(2) : "0.00",
          player1Moves: player1Moves ?? game.player1Moves ?? 0,
          player2Moves: player2Moves ?? game.player2Moves ?? 0,
          player1Territory: player1Territory ?? game.player1Territory ?? 1,
          player2Territory: player2Territory ?? game.player2Territory ?? 1,
          durationSeconds: durationSeconds ?? 0,
          status: "completed",
          endedAt,
        })
        .where(eq(hexDuelGames.id, game.id));

      // Record big win if needed
      if (callerWon && payout >= 1_000_000) {
        const userRow = await tx
          .select({ name: users.name })
          .from(users)
          .where(eq(users.clerkId, clerkId))
          .limit(1);
        recordBigWinIfNeeded({
          userId: clerkId,
          username: userRow?.[0]?.name || "Player",
          game: "Hex Duel",
          betAmount: wagerAmount,
          winAmount: payout,
          multiplier: PAYOUT_MULTIPLIER,
        }).catch(() => {});
      }

      return {
        alreadyProcessed: false,
        won: callerWon,
        wager: wagerAmount,
        payout,
        multiplier: PAYOUT_MULTIPLIER,
        newBalance,
      };
    });

    // Record leaderboard stats (fire-and-forget, outside transaction)
    if (!result.alreadyProcessed) {
      applyLeaderboardCounters({
        clerkId,
        game: "Hex Duel",
        betAmount: result.wager,
        payout: result.won ? result.payout : 0,
        isPvpWin: result.won,
      }).catch(() => {});
    }

    return NextResponse.json({ success: true, data: result });
  } catch (error: any) {
    const status = error?.message === "No active game found" ? 404 : 500;
    return NextResponse.json(
      { success: false, error: error?.message || "Server error" },
      { status },
    );
  }
}
