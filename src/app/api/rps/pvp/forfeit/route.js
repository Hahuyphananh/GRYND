// src/app/api/rps/pvp/forfeit/route.js
//
// POST — forfeit from an in-progress RPS PvP best-of-7 game. The
// forfeiter loses and the opponent is credited the pot minus the
// shared 5% house rake (same settlement math as the `choose` route's
// match-finish branch). Only valid while the match is `matched`
// (both players joined, rounds in progress); a `active` (waiting)
// game is cancelled with a full refund via `/cancel` instead.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../../db/client";
import { rpsPvpGames, users } from "../../../../../db/schema";
import { applyLeaderboardCounters } from "../../../../../lib/leaderboardCounters";
import { eq, sql } from "drizzle-orm";

// Harmonized to the shared 5% PvP rake (must match PVP_RAKE_PCT in
// src/lib/games/economy.ts). Winner keeps 95% of the pot.
const HOUSE_EDGE_PERCENT = 5;

export async function POST(req) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const { gameId } = await req.json();
  const parsedGameId = Number(gameId);
  if (!Number.isFinite(parsedGameId)) {
    return NextResponse.json(
      { success: false, error: "Invalid gameId" },
      { status: 400 },
    );
  }

  try {
    const result = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(rpsPvpGames)
        .where(eq(rpsPvpGames.id, parsedGameId))
        .for("update");

      if (!locked) throw new Error("Game not found");
      if (locked.status === "finished" || locked.status === "cancelled") {
        throw new Error("Game already finished");
      }
      if (locked.status !== "matched") {
        throw new Error("Game is not in progress");
      }
      if (locked.player1Id !== userId && locked.player2Id !== userId) {
        throw new Error("Forbidden");
      }

      // The forfeiter loses; the opponent wins the pot minus the rake.
      const forfeiterIsPlayer1 = locked.player1Id === userId;
      const winnerId = forfeiterIsPlayer1
        ? locked.player2Id
        : locked.player1Id;

      const betAmount = Number(locked.betAmount);
      const pot = betAmount * 2;
      const houseFee = Number(((pot * HOUSE_EDGE_PERCENT) / 100).toFixed(2));
      const winnerPayout = Number((pot - houseFee).toFixed(2));

      await tx
        .update(users)
        .set({ balance: sql`${users.balance} + ${winnerPayout}` })
        .where(eq(users.clerkId, winnerId));

      const [finished] = await tx
        .update(rpsPvpGames)
        .set({
          player1Choice: null,
          player2Choice: null,
          outcome: forfeiterIsPlayer1 ? "player2" : "player1",
          winnerId,
          result: forfeiterIsPlayer1 ? "player2" : "player1",
          status: "finished",
        })
        .where(eq(rpsPvpGames.id, parsedGameId))
        .returning();

      return { game: finished, winnerId, winnerPayout };
    });

    // Best-effort leaderboard stats for both players.
    applyLeaderboardCounters({
      clerkId: result.winnerId,
      game: "rps-pvp",
      betAmount: Number(result.game.betAmount),
      payout: result.winnerPayout,
      isPvpWin: true,
    }).catch(() => {});
    applyLeaderboardCounters({
      clerkId: userId,
      game: "rps-pvp",
      betAmount: Number(result.game.betAmount),
      payout: 0,
    }).catch(() => {});

    return NextResponse.json({
      success: true,
      data: {
        gameId: parsedGameId,
        status: result.game.status,
        winnerId: result.winnerId,
        winnerPayout: result.winnerPayout,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err.message || "Failed to forfeit game" },
      { status: 400 },
    );
  }
}
