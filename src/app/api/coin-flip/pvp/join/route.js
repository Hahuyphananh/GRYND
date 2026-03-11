import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../../db/client";
import { coinFlipGames, users } from "../../../../../db/schema";
import { eq, and, isNull, sql } from "drizzle-orm";

export async function POST(req) {
  const { userId } = await auth();
  if (!userId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { gameId } = await req.json();

  try {
    const result = await db.transaction(async (tx) => {
      const [game] = await tx
        .select()
        .from(coinFlipGames)
        .where(
          and(
            eq(coinFlipGames.id, gameId),
            isNull(coinFlipGames.player2Id)
          )
        )
        .for("update");

      if (!game) throw new Error("Game already joined");
      if (game.player1Id === userId) throw new Error("Cannot join your own game");

      const [joiner] = await tx
        .update(users)
        .set({
          balance: sql`${users.balance} - ${game.betAmount}`,
        })
        .where(
          and(
            eq(users.clerkId, userId),
            sql`${users.balance} >= ${game.betAmount}`
          )
        )
        .returning();

      if (!joiner) throw new Error("Insufficient balance");

      const player2Choice = game.player1Choice === "heads" ? "tails" : "heads";
      const outcome = Math.random() < 0.5 ? "heads" : "tails";
      const winnerId = outcome === game.player1Choice ? game.player1Id : userId;
      const payout = Number(game.betAmount) * 2;

      await tx
        .update(users)
        .set({
          balance: sql`${users.balance} + ${payout}`,
        })
        .where(eq(users.clerkId, winnerId));

      await tx
        .update(coinFlipGames)
        .set({
          player2Id: userId,
          player2Choice,
          outcome,
          winnerId,
          result: winnerId === game.player1Id ? "player1" : "player2",
          status: "finished",
        })
        .where(eq(coinFlipGames.id, gameId));

      return {
        player2Choice,
        outcome,
        winner: winnerId === userId ? "you" : "opponent",
      };
    });

    return NextResponse.json({
      success: true,
      data: {
        gameId,
        player2Choice: result.player2Choice,
        outcome: result.outcome,
        winner: result.winner,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
