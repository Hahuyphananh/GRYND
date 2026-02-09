import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../../db/client";
import { coinFlipGames, users } from "../../../../../db/schema";
import { eq, sql, and } from "drizzle-orm";

export async function POST(req) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

 const body = await req.json();

const betAmount = Number(body.betAmount);
const choice = body.choice;

  if (!Number.isFinite(betAmount) || betAmount <= 0){
  return NextResponse.json(
    { error: "Invalid bet amount" },
    { status: 400 }
  );
}

if (betAmount > 10000) {
  return NextResponse.json(
    { error: "Bet exceeds maximum limit" },
    { status: 400 }
  );
}

  if (!["heads", "tails"].includes(choice)) {
    return NextResponse.json({ error: "Invalid choice" }, { status: 400 });
  }

  // Deduct bet from creator
const newGame = await db.transaction(async (tx) => {

  const [creator] = await tx
    .update(users)
    .set({
      balance: sql`${users.balance} - ${betAmount}`
    })
    .where(
      and(
        eq(users.clerkId, userId),
        sql`${users.balance} >= ${betAmount}`
      )
    )
    .returning();

  if (!creator) throw new Error("Insufficient balance");

  const [newGame] = await tx
    .insert(coinFlipGames)
    .values({
      player1Id: userId,
      betAmount,
      player1Choice: choice,
    })
    .returning();

  return newGame;
});

  return NextResponse.json({
    success: true,
    data: {
      gameId: newGame.id,
      betAmount: newGame.betAmount,
      player1Choice: newGame.player1Choice,
    },
  });
}
