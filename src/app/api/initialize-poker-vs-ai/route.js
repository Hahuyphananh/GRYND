import { auth } from "@clerk/nextjs/server";
import { db } from "../../../db/client";
import { users, pokerGames } from "../../../db/schema";
import { eq } from "drizzle-orm";
import { performAiAction } from "../../lib/ailogic";

function generateCardDeck() {
  const suits = ["hearts", "diamonds", "clubs", "spades"];
  const values = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
  const deck = [];

  for (const suit of suits) {
    for (const value of values) {
      deck.push({ value, suit });
    }
  }

  // Shuffle deck
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

export async function POST(request) {
  const { userId } = await auth();
  if (!userId)
    return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });

  try {
    const { betAmount } = await request.json();
    if (!betAmount || isNaN(betAmount) || betAmount <= 0) {
      throw new Error("Invalid bet amount");
    }

    const user = await db.query.users.findFirst({ where: eq(users.clerkId, userId) });
    if (!user) throw new Error("User not found");

    const balance = parseFloat(user.balance);
    if (balance < betAmount) throw new Error("Insufficient balance");

    const deck = generateCardDeck();
    const playerHand = [deck.pop(), deck.pop()];
    const aiHand = [deck.pop(), deck.pop()];
    const pot = betAmount * 2;
    const communityCards = [];

    // Store game in DB
    const result = await db.transaction(async (tx) => {
      // Deduct player's bet
      await tx.update(users)
        .set({ balance: (balance - betAmount).toString() })
        .where(eq(users.clerkId, userId));

      const [insertedGame] = await tx.insert(pokerGames).values({
        userId: user.id,
        betAmount: betAmount.toString(),
        playerBet: betAmount,
        aiBet: betAmount,
        result: "pending",
        payout: "0.00",
        playerHand,
        aiHand,
        deck,
        pot,
        status: "active",
        minBet: betAmount,
        currentPlayerPosition: 0,
        dealerPosition: 1,
        currentRound: "preflop",
        communityCards
      }).returning();

      return insertedGame;
    });

    // AI performs preflop action
    await performAiAction(result.id);

    return new Response(JSON.stringify({
      success: true,
      data: {
        gameId: result.id,
        newBalance: balance - betAmount,
        playerHand,
        aiHand: ["?", "?"], // hide AI hand initially
        pot
      }
    }), { status: 200, headers: { "Content-Type": "application/json" } });

  } catch (err) {
    console.error("❌ Poker AI init error:", err);
    return new Response(JSON.stringify({ success: false, error: err.message || "Server error" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
