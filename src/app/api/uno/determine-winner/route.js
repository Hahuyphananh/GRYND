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

    // Fetch the current game
    const game = await db.query.unoGames.findFirst({
      where: eq(unoGames.id, gameId),
    });
    if (!game) {
      return NextResponse.json({ error: "Game not found" }, { status: 404 });
    }

    // Prevent double processing
    if (game.result !== "pending" && game.winner) {
      const user = await db.query.users.findFirst({
        where: eq(users.clerkId, userId),
      });
      return NextResponse.json({
        success: true,
        winner: game.winner,
        result: game.result,
        newBalance: parseFloat(user.balance),
        message: "Winner already determined.",
      });
    }

    // Parse player and AI hands
    const playerCards = typeof game.playerHand === "string"
      ? JSON.parse(game.playerHand)
      : game.playerHand || [];
    const aiCards = typeof game.aiHand === "string"
      ? JSON.parse(game.aiHand)
      : game.aiHand || [];

    const user = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
    });
    if (!user)
      return NextResponse.json({ error: "User not found" }, { status: 404 });

    let newBalance = parseFloat(user.balance);
    let winner = null;
    let result = "pending";

    // Determine winner logic
    if (playerCards.length === 0) {
      winner = "player";
      result = "win";
      const profit = parseFloat(game.betAmount) * 2; // double bet
      const taxedProfit = profit * 0.95; // 5% tax
      newBalance += taxedProfit;
    } else if (aiCards.length === 0) {
      winner = "ai";
      result = "lose";
    } else {
      // Neither finished
      return NextResponse.json({
        success: true,
        winner: null,
        result: "pending",
        message: "Game still in progress.",
      });
    }

    // ✅ Update game in DB
    await db
      .update(unoGames)
      .set({
        winner,
        result,
        status: "finished",
        payout:
          result === "win"
            ? (parseFloat(game.betAmount) * 1.9).toFixed(2)
            : "0.00",
      })
      .where(eq(unoGames.id, gameId));

    // ✅ Update user balance if player wins
    if (result === "win") {
      await db
        .update(users)
        .set({ balance: newBalance.toFixed(2) })
        .where(eq(users.clerkId, userId));
    }

    return NextResponse.json({
      success: true,
      winner,
      result,
      newBalance,
      message:
        result === "win"
          ? `🎉 You won! Profit after tax: ${(parseFloat(game.betAmount) * 0.95).toFixed(2)}`
          : "😢 The AI won. You lost your bet.",
    });
  } catch (error) {
    console.error("Error determining UNO winner:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
