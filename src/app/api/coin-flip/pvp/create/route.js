import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../../db/client";
import { coinFlipGames, users } from "../../../../../db/schema";
import { eq, sql, and } from "drizzle-orm";
import { sendSystemNotificationEmail } from "../../../../../lib/emails/system";

export async function POST(req) {
  const { userId } = await auth();
  if (!userId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const betAmount = Number(body.betAmount);

  if (!Number.isFinite(betAmount) || betAmount <= 0) {
    return NextResponse.json({ error: "Invalid bet amount" }, { status: 400 });
  }

  if (betAmount > 10000) {
    return NextResponse.json(
      { error: "Bet exceeds maximum limit" },
      { status: 400 },
    );
  }

  const newGame = await db.transaction(async (tx) => {
    const [creator] = await tx
      .update(users)
      .set({
        balance: sql`${users.balance} - ${betAmount}`,
      })
      .where(
        and(eq(users.clerkId, userId), sql`${users.balance} >= ${betAmount}`),
      )
      .returning();

    if (!creator) throw new Error("Insufficient balance");

    const [newGame] = await tx
      .insert(coinFlipGames)
      .values({
        player1Id: userId,
        betAmount,
      })
      .returning();

    // Fire system notification for large coin flip bets (≥ 1000 tokens)
    if (betAmount >= 1000) {
      sendSystemNotificationEmail({
        eventType: "bet_placed",
        description: `User ${userId} created a large coin-flip PvP game with ${betAmount} tokens.`,
        metadata: { userId, betAmount, gameId: newGame.id },
      }).catch((err) => console.warn("[system_notify] Failed to send coin-flip:", err));
    }

    return newGame;
  });

  return NextResponse.json({
    success: true,
    data: {
      gameId: newGame.id,
      betAmount: newGame.betAmount,
    },
  });
}
