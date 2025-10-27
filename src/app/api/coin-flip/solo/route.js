import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { users, coinFlipGames } from "../../../../db/schema"; // ✅ include coinFlipGames
import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { bet, choice } = await req.json();
    if (typeof bet !== "number" || !["heads", "tails"].includes(choice)) {
      return NextResponse.json({ error: "Invalid parameters" }, { status: 400 });
    }

    // ✅ Deduct bet from user's balance
    const [user] = await db
      .update(users)
      .set({ balance: sql`balance - ${bet}` })
      .where(eq(users.clerkId, userId))
      .returning();

    if (!user) throw new Error("User not found");

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

    const newBalance = parseFloat(user.balance) - bet + payout;

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

    // ✅ Respond with game result
    return NextResponse.json({
      success: true,
      data: { outcome, won, payout, newBalance },
    });
  } catch (err) {
    console.error("Coin flip error:", err);
    return NextResponse.json({ error: err.message || "Server error" }, { status: 500 });
  }
}
