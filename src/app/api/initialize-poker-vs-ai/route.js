import { auth } from "@clerk/nextjs/server";
import { db } from "../../../db/client";
import { users, pokerGames } from "../../../db/schema";
import { eq } from "drizzle-orm";

function generateCardDeck() {
  const suits = ["hearts", "diamonds", "clubs", "spades"];
  const values = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
  const deck = [];

  for (const suit of suits) {
    for (const value of values) {
      deck.push({ value, suit });
    }
  }

  // Shuffle deck (Fisher-Yates)
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

export async function POST(request) {
  const { userId } = await auth();
  if (!userId)
    return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { 
      status: 401, 
      headers: { "Content-Type": "application/json" } 
    });

  try {
    const { betAmount } = await request.json();
    if (!betAmount || isNaN(betAmount) || betAmount <= 0)
      throw new Error("Invalid bet amount");

    const user = await db.query.users.findFirst({ where: eq(users.clerkId, userId) });
    if (!user) throw new Error("User not found");

    const balance = parseFloat(user.balance);
    if (balance < betAmount) throw new Error("Insufficient balance");

    const deck = generateCardDeck();

    // Deal 5 cards each upfront
    const playerHand = deck.splice(0, 5);
    const aiHand = deck.splice(0, 5);
    const pot = betAmount * 2;

    // Store game in DB transaction
    const newGame = await db.transaction(async (tx) => {
      // Deduct player's bet
      await tx.update(users)
        .set({ balance: (balance - betAmount).toString() })
        .where(eq(users.clerkId, userId));

      const [insertedGame] = await tx.insert(pokerGames).values({
        userId: user.id,
        betAmount: betAmount.toString(),
        result: "pending",
        payout: "0.00",
        playerHand,
        aiHand,
        deck,   // remaining cards in deck
        pot,
        status: "active",
        minBet: betAmount,
      }).returning();

      return insertedGame;
    });

    return new Response(JSON.stringify({
      success: true,
      data: {
        gameId: newGame.id,
        newBalance: balance - betAmount,
        playerHand,                  // full 5-card hand for player
        aiHand: ["?", "?", "?", "?", "?"], // hide AI hand for frontend
        pot
      }
    }), { status: 200, headers: { "Content-Type": "application/json" } });

  } catch (err) {
    console.error("❌ Poker AI init error:", err);
    return new Response(JSON.stringify({ success: false, error: err.message || "Server error" }), { 
      status: 500, 
      headers: { "Content-Type": "application/json" } 
    });
  }
}
