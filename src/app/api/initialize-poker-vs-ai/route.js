import { auth } from "@clerk/nextjs/server";
import { db } from "../../../db/client";
import { users, pokerGames } from "../../../db/schema";
import { eq } from "drizzle-orm";

function generateCardDeck() {
  const suits = ["hearts", "diamonds", "clubs", "spades"];
  const values = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
  const deck = [];

  for (const suit of suits) {
    for (const value of values) {
      deck.push(`${value} ${suit}`);
    }
  }

  // Shuffle the deck
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

export async function POST(request) {
  const { userId } = await auth();
  if (!userId) {
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const user = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
    });

    if (!user) {
      return new Response(
        JSON.stringify({ success: false, error: "User not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    const betAmount = 10;
    const balance = parseFloat(user.balance);

    if (balance < betAmount) {
      return new Response(
        JSON.stringify({ success: false, error: "Insufficient balance" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const deck = generateCardDeck();
    const playerHand = [deck.pop(), deck.pop()];
    const aiHand = [deck.pop(), deck.pop()];
    const payout = "0.00";
    const pot = betAmount * 2; // 10 from player + 10 from AI

    const result = await db.transaction(async (tx) => {
      await tx.update(users)
        .set({ balance: (balance - betAmount).toString() })
        .where(eq(users.clerkId, userId));

      const [insertedGame] = await tx.insert(pokerGames).values({
        userId: user.id,
        betAmount: betAmount.toString(),
        result: "pending",
        payout,
        playerHand: JSON.stringify(playerHand),
        aiHand: JSON.stringify(aiHand),
        pot,
        status: "active",
        playerBet: betAmount,
        aiBet: betAmount,
        stage: "preflop",
        communityCards: JSON.stringify([]),
      }).returning();

      return insertedGame;
    });

    return new Response(
      JSON.stringify({
        success: true,
        data: {
          gameId: result.id,
          newBalance: balance - betAmount,
          playerHand,
          aiHand: ["?", "?"], // Hide AI hand at start
          pot, // ✅ Include pot here so frontend can use it
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("❌ Poker AI init error:", err);
    return new Response(
      JSON.stringify({ success: false, error: "Server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
