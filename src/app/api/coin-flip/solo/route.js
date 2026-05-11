import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { users, coinFlipGames } from "../../../../db/schema"; // ✅ include coinFlipGames
import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { applyLeaderboardCounters } from "../../../../lib/leaderboardCounters";

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { bet, choice } = await req.json();
    if (
      !Number.isFinite(bet) ||
      bet <= 0 ||
      !["heads", "tails"].includes(choice)
    ) {
      return NextResponse.json(
        { error: "Invalid parameters" },
        { status: 400 },
      );
    }

    // ✅ Deduct bet from user's balance only if sufficient
    const [user] = await db
      .update(users)
      .set({ balance: sql`balance - ${bet}` })
      .where(sql`${users.clerkId} = ${userId} AND ${users.balance} >= ${bet}`)
      .returning({ balance: users.balance });

    if (!user) {
      return NextResponse.json(
        { error: "Insufficient balance" },
        { status: 400 },
      );
    }

    // 🎲 Simulate coin flip
    const outcome = Math.random() < 0.5 ? "heads" : "tails";
    const won = outcome === choice;
    const payout = won ? parseFloat((bet * 1.98).toFixed(2)) : 0;
    const result = won ? "won" : "lost";

    // ✅ If user wins, credit payout
    if (won) {
      await db
        .update(users)
        .set({ balance: sql`balance + ${payout}` })
        .where(eq(users.clerkId, userId));
    }

    const newBalance = Number(user.balance) + payout;

    // 🧾 Save coin flip record to database
    await db.insert(coinFlipGames).values({
      player1Id: userId,
      betAmount: bet,
      player1Choice: choice,
      outcome,
      winnerId: won ? userId : null,
      result,
      status: "completed",
    });

    await applyLeaderboardCounters({
      clerkId: userId,
      game: "coin-flip",
      betAmount: bet,
      payout,
    });

    // ✅ Respond with game result
    return NextResponse.json({
      success: true,
      data: { outcome, won, payout, newBalance },
    });
  } catch (err) {
    console.error("Coin flip error:", err);
    return NextResponse.json(
      { error: err.message || "Server error" },
      { status: 500 },
    );
  }
}
