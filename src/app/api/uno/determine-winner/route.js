// File: src/app/api/uno/determine-winner/route.js
import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { users } from "../../../../db/schema";
import { eq } from "drizzle-orm";

export async function POST(req) {
  try {
    const { userId } = auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { playerCards, aiCards, betAmount } = await req.json();

    // Fetch current balance
    const [user] = await db.select().from(users).where(eq(users.clerkId, userId));
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    let winner;
    let newBalance = user.tokens;

    // UNO winner: whoever runs out of cards first
    if (playerCards.length === 0 && aiCards.length > 0) {
      winner = "player";
      const profit = betAmount * 2; // Double the bet on win
      const taxedProfit = profit * 0.95; // Apply 5% tax
      newBalance += taxedProfit;
    } else if (aiCards.length === 0 && playerCards.length > 0) {
      winner = "ai";
      newBalance -= betAmount; // Lose full bet
    } else {
      winner = "none"; // Game not over yet
    }

    // Update balance in DB if game is finished
    if (winner !== "none") {
      await db
        .update(users)
        .set({ tokens: newBalance })
        .where(eq(users.clerkId, userId));
    }

    return NextResponse.json({
      winner,
      newBalance,
      message:
        winner === "player"
          ? `🎉 Vous avez gagné ! Profit après taxe : ${betAmount * 0.95}`
          : winner === "ai"
          ? "😢 L'IA a gagné. Vous perdez votre mise."
          : "La partie continue...",
    });
  } catch (error) {
    console.error("Error determining winner:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
