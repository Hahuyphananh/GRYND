import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { rouletteGames, users } from "../../../../db/schema";
import { eq } from "drizzle-orm";

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const { betAmount, result, payout } = await req.json();

    if (
      typeof betAmount !== "number" ||
      typeof payout !== "number" ||
      typeof result !== "string"
    ) {
      return NextResponse.json({ success: false, error: "Invalid request body" }, { status: 400 });
    }

    // Get user data
    const userData = await db.select().from(users).where(eq(users.clerkId, userId)).limit(1);
    if (!userData.length) {
      return NextResponse.json({ success: false, error: "User not found" }, { status: 404 });
    }

    const user = userData[0];
    let newBalance = parseFloat(user.balance);

    // Adjust balance
    if (result === "won") {
      newBalance += payout; // player wins payout
    } else if (result === "lost") {
      newBalance -= betAmount; // player loses bet
    }

    // Update user balance
    await db.update(users).set({ balance: newBalance }).where(eq(users.clerkId, userId));

    // Record the game
    await db.insert(rouletteGames).values({
      userId: user.id,
      betAmount: betAmount.toFixed(2),
      result,
      payout: payout.toFixed(2),
    });

    return NextResponse.json({
      success: true,
      data: { newBalance },
    });
  } catch (error) {
    console.error("Roulette save-game error:", error);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
