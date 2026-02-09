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

      // 🔥 LOCK THE GAME ROW
      const [game] = await tx
        .select()
        .from(coinFlipGames)
        .where(
          and(
            eq(coinFlipGames.id, gameId),
            isNull(coinFlipGames.player2Id)
          )
        )
        .for("update"); // ← VERY IMPORTANT (row lock)

      if (!game) throw new Error("Game already joined");

      if (game.player1Id === userId)
        throw new Error("Cannot join your own game");

      // 🔥 Deduct ONLY if enough balance
      const [joiner] = await tx
        .update(users)
        .set({
          balance: sql`${users.balance} - ${game.betAmount}`
        })
        .where(
          and(
            eq(users.clerkId, userId),
            sql`${users.balance} >= ${game.betAmount}`
          )
        )
        .returning();

      if (!joiner) throw new Error("Insufficient balance");

      // 🔥 Seat the player
      await tx
        .update(coinFlipGames)
        .set({ player2Id: userId })
        .where(eq(coinFlipGames.id, gameId));

      return { game };
    });

    return NextResponse.json({
      success: true,
      data: { gameId }
    });

  } catch (err) {
    return NextResponse.json(
      { error: err.message },
      { status: 400 }
    );
  }
}
