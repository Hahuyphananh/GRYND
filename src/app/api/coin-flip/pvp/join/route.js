import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../../db/client";
import { coinFlipGames, users } from "../../../../../db/schema";
import { eq, and, isNull, sql } from "drizzle-orm";

const HOUSE_EDGE = 0.98;

export async function POST(req) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { gameId, choice } = await req.json();

  if (!Number.isFinite(Number(gameId))) {
    return NextResponse.json({ error: "Invalid game id" }, { status: 400 });
  }

  if (!["heads", "tails"].includes(choice)) {
    return NextResponse.json({ error: "Invalid choice" }, { status: 400 });
  }

  try {
    const game = await db.transaction(async (tx) => {
      const [openGame] = await tx
        .select()
        .from(coinFlipGames)
        .where(and(eq(coinFlipGames.id, Number(gameId)), isNull(coinFlipGames.player2Id)))
        .for("update");

      if (!openGame) throw new Error("Game already joined");
      if (openGame.player1Id === userId) throw new Error("Cannot join your own game");

      const [joiner] = await tx
        .update(users)
        .set({ balance: sql`${users.balance} - ${openGame.betAmount}` })
        .where(and(eq(users.clerkId, userId), sql`${users.balance} >= ${openGame.betAmount}`))
        .returning();

      if (!joiner) throw new Error("Insufficient balance");

      const expectedChoice = openGame.player1Choice === "heads" ? "tails" : "heads";
      if (choice !== expectedChoice) throw new Error(`You must pick ${expectedChoice} for this game`);

      const outcome = Math.random() < 0.5 ? "heads" : "tails";
      const winnerId = outcome === openGame.player1Choice ? openGame.player1Id : userId;
      const payout = Number(openGame.betAmount) * 2 * HOUSE_EDGE;

      await tx
        .update(users)
        .set({ balance: sql`${users.balance} + ${payout}` })
        .where(eq(users.clerkId, winnerId));

      const [updatedGame] = await tx
        .update(coinFlipGames)
        .set({
          player2Id: userId,
          outcome,
          winnerId,
          status: "finished",
          result: "resolved",
        })
        .where(eq(coinFlipGames.id, Number(gameId)))
        .returning();

      return updatedGame;
    });

    return NextResponse.json({
      success: true,
      data: {
        gameId: game.id,
        outcome: game.outcome,
        winnerId: game.winnerId,
        status: game.status,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
