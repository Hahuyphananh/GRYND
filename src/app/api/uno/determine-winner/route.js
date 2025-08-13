// File: src/app/api/uno/determine-winner/route.js
import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { users, unoGames } from "../../../../db/schema";
import { eq } from "drizzle-orm";

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { gameId } = await req.json();
    if (!gameId) {
      return NextResponse.json({ error: "Missing gameId" }, { status: 400 });
    }

    // Fetch the current game state
    const game = await db.query.unoGames.findFirst({
      where: eq(unoGames.id, gameId),
    });
    if (!game) {
      return NextResponse.json({ error: "Game not found" }, { status: 404 });
    }

    // ✅ Prevent double payout if winner already exists
    if (game.winner) {
      const user = await db.query.users.findFirst({
        where: eq(users.clerkId, userId),
      });
      return NextResponse.json({
        success: true,
        winner: game.winner,
        newBalance: parseFloat(user.balance),
        message: "Winner already determined — no balance change.",
      });
    }

    // Safely parse hands
    const playerCards = game.playerHand
      ? typeof game.playerHand === "string"
        ? JSON.parse(game.playerHand)
        : game.playerHand
      : [];
    const aiCards = game.aiHand
      ? typeof game.aiHand === "string"
        ? JSON.parse(game.aiHand)
        : game.aiHand
      : [];

    // Fetch user balance
    const user = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
    });
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    let newBalance = parseFloat(user.balance);

    let winner;

    // Determine winner (only player or AI)
    if (playerCards.length === 0) {
      winner = "player";
      const profit = parseFloat(game.betAmount) * 2; // double bet
      const taxedProfit = profit * 0.95; // 5% tax
      newBalance += taxedProfit;
    } else if (aiCards.length === 0) {
      winner = "ai";
    } else {
      // If neither has 0 cards, just return current game state without winner
      return NextResponse.json({
        success: true,
        winner: null,
        newBalance,
        message: "La partie continue...",
      });
    }

    // ✅ Save winner in DB to prevent double payout
    await db.update(unoGames).set({ winner }).where(eq(unoGames.id, gameId));

    // Update user balance if player won
    if (winner === "player") {
      await db
        .update(users)
        .set({ balance: newBalance.toFixed(2) })
        .where(eq(users.clerkId, userId));
    }

    return NextResponse.json({
      success: true,
      winner,
      newBalance,
      message:
        winner === "player"
          ? `🎉 Vous avez gagné ! Profit après taxe : ${(parseFloat(game.betAmount) * 0.95).toFixed(2)}`
          : "😢 L'IA a gagné. Vous perdez votre mise.",
    });
  } catch (error) {
    console.error("Error determining winner:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
