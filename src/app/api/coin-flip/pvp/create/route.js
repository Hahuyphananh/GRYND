import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../../db/client";
import { coinFlipGames, users } from "../../../../../db/schema";
import { eq, sql, and } from "drizzle-orm";
import { sendSystemNotificationEmail } from "../../../../../lib/emails/system";

const MAX_BET_AMOUNT = 10000;

function validateBetAmount(value) {
  const betAmount = Number(value);

  if (!Number.isFinite(betAmount) || betAmount <= 0) {
    return { error: "Invalid bet amount" };
  }

  if (betAmount > MAX_BET_AMOUNT) {
    return { error: "Bet exceeds maximum limit" };
  }

  return { betAmount };
}

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const { betAmount, error } = validateBetAmount(body?.betAmount);
    if (error) return NextResponse.json({ error }, { status: 400 });

    const newGame = await db.transaction(async (tx) => {
      const [creator] = await tx
        .update(users)
        .set({
          balance: sql`${users.balance} - ${betAmount}`,
        })
        .where(and(eq(users.clerkId, userId), sql`${users.balance} >= ${betAmount}`))
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
        betAmount: Number(newGame.betAmount),
      },
    });
  } catch (err) {
    console.error("Coin-flip PvP create error:", err);
    const message = err?.message || "Failed to create game";
    const status = message === "Insufficient balance" ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
