import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../../db/client";
import { coinFlipGames, users } from "../../../../../db/schema";
import { eq, and, sql } from "drizzle-orm";

export async function POST(req) {
  const { userId } = await auth();
  if (!userId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { gameId } = await req.json();

  const game = await db.query.coinFlipGames.findFirst({
    where: eq(coinFlipGames.id, gameId),
  });

  if (!game)
    return NextResponse.json({ error: "Game not found" }, { status: 404 });

  if (game.player1Id !== userId)
    return NextResponse.json({ error: "Not your game" }, { status: 403 });

  if (game.player2Id)
    return NextResponse.json(
      { error: "Game already started" },
      { status: 400 },
    );

  await db.transaction(async (tx) => {
    // refund safely
    await tx
      .update(users)
      .set({
        balance: sql`${users.balance} + ${Number(game.betAmount)}`,
      })
      .where(eq(users.clerkId, userId));

    // delete game
    await tx.delete(coinFlipGames).where(eq(coinFlipGames.id, gameId));
  });

  return NextResponse.json({ success: true });
}
