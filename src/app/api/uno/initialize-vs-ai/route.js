import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { users, unoGames } from "../../../../db/schema";
import { eq } from "drizzle-orm";

function generateDeck() {
  const colors = ["red", "yellow", "green", "blue"];
  const values = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "Skip", "Reverse", "Draw Two"];
  const wilds = ["Wild", "Wild Draw Four"];

  const deck = [];

  for (const color of colors) {
    for (const value of values) {
      deck.push({ color, value });
      if (value !== "0") deck.push({ color, value }); // each card (except 0) appears twice
    }
  }

  for (let i = 0; i < 4; i++) {
    for (const wild of wilds) {
      deck.push({ color: "black", value: wild });
    }
  }

  // Shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

export async function POST(request) {
  const { userId } = await auth();
  if (!userId) {
    return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
      status: 401,
    });
  }

  const { betAmount } = await request.json();
  if (!betAmount || isNaN(betAmount) || betAmount <= 0 || betAmount > 1000) {
    return new Response(JSON.stringify({ success: false, error: "Invalid bet amount" }), {
      status: 400,
    });
  }

  try {
    const user = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
    });

    if (!user) {
      return new Response(JSON.stringify({ success: false, error: "User not found" }), {
        status: 404,
      });
    }

    const balance = parseFloat(user.balance);
    if (balance < betAmount) {
      return new Response(JSON.stringify({ success: false, error: "Insufficient balance" }), {
        status: 400,
      });
    }

    const deck = generateDeck();
    const playerHand = deck.splice(0, 7);
    const aiHand = deck.splice(0, 7);

    // Get a non-wild starting card
    let topCard;
    do {
      topCard = deck.pop();
    } while (topCard.value === "Wild" || topCard.value === "Wild Draw Four");

    const discardPile = [topCard];
    const pot = (betAmount * 2).toFixed(2); // 2x pot

    const result = await db.transaction(async (tx) => {
      await tx.update(users)
        .set({ balance: (balance - betAmount).toFixed(2) })
        .where(eq(users.clerkId, userId));

      const inserted = await tx.insert(unoGames).values({
        userId: user.id,
        betAmount: betAmount.toFixed(2),
        pot,
        result: "pending",
        payout: "0.00",
        playerHand,
        aiHand,
        deck,
        discardPile,
        turn: "player",
      }).returning();

      return inserted[0];
    });

    return new Response(
      JSON.stringify({
        success: true,
        data: {
          gameId: result.id,
          newBalance: (balance - betAmount).toFixed(2),
          playerHand,
          aiHand: ["?", "?", "?", "?", "?", "?", "?"], // hidden
          discardPile,
          topCard, // Optional, if frontend uses this separately
          turn: "player",
          pot,
        },
      }),
      { status: 200 }
    );
  } catch (err) {
    console.error("UNO AI init error:", err);
    return new Response(JSON.stringify({ success: false, error: "Server error" }), {
      status: 500,
    });
  }
}
