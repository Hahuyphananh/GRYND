import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../../db/client";
import { coinFlipGames, users } from "../../../../../db/schema";
import { eq, and, isNull, sql } from "drizzle-orm";

export async function POST(req) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { gameId } = await req.json();

  try {
    await db.transaction(async (tx) => {
      const [game] = await tx
        .select()
        .from(coinFlipGames)
        .where(and(eq(coinFlipGames.id, Number(gameId)), isNull(coinFlipGames.player2Id)))
        .for("update");

      if (!game) throw new Error("Game not found or already started");
      if (game.player1Id !== userId) throw new Error("Not your game");

      await tx
        .update(users)
        .set({ balance: sql`${users.balance} + ${Number(game.betAmount)}` })
        .where(eq(users.clerkId, userId));

      await tx.delete(coinFlipGames).where(eq(coinFlipGames.id, Number(gameId)));
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
