import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { users, blackjackGames } from "../../../../db/schema";
import { eq, desc } from "drizzle-orm";

// Simple deck + draw helper
const suits = ["♠", "♥", "♦", "♣"];
const values = [
  "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"
];
const deck = suits.flatMap((s) => values.map((v) => `${v}${s}`));

function shuffle(array: string[]) {
  return array.sort(() => Math.random() - 0.5);
}

function getValue(hand: string[]) {
  let total = 0;
  let aces = 0;
  for (const card of hand) {
    const val = card.slice(0, -1);
    if (["J", "Q", "K"].includes(val)) total += 10;
    else if (val === "A") {
      total += 11;
      aces++;
    } else total += parseInt(val);
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

export async function POST(request: Request) {
  const { userId } = await auth();

  if (!userId) {
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  const body = await request.json();
  const amount = parseFloat(body?.amount);

  if (!amount || amount <= 0) {
    return new Response(
      JSON.stringify({ success: false, error: "Invalid amount" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const user = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
    });

    if (!user || parseFloat(user.balance) < amount) {
      return new Response(
        JSON.stringify({ success: false, error: "Insufficient balance" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Initialize game simulation
    const gameDeck = shuffle([...deck]);
    const playerHand = [gameDeck.pop()!, gameDeck.pop()!];
    const dealerHand = [gameDeck.pop()!, gameDeck.pop()!];

    const playerValue = getValue(playerHand);
    const dealerValue = getValue(dealerHand);

    let result: "win" | "lose" | "draw" = "draw";
    let payout = 0;

    // Determine outcome
    if (playerValue > 21) {
      result = "lose";
      payout = 0;
    } else if (dealerValue > 21 || playerValue > dealerValue) {
      result = "win";
      payout = amount * 2;
    } else if (playerValue < dealerValue) {
      result = "lose";
      payout = 0;
    } else {
      result = "draw";
      payout = amount;
    }

    const finalBalance =
      result === "win"
        ? parseFloat(user.balance) - amount + payout
        : result === "draw"
        ? parseFloat(user.balance)
        : parseFloat(user.balance) - amount;

    // Record in database
    const gameRecord = await db.transaction(async (tx) => {
      await tx.update(users)
        .set({ [users.balance.name]: finalBalance.toString() })
        .where(eq(users.clerkId, userId));

      const [inserted] = await tx
        .insert(blackjackGames)
        .values({
          userId: user.id,
          betAmount: amount.toString(),
          result,
          payout: payout.toString(),
        })
        .returning();

      return inserted;
    });

    return new Response(
      JSON.stringify({
        success: true,
        data: {
          result,
          payout,
          playerHand,
          dealerHand,
          playerValue,
          dealerValue,
          finalBalance,
          message:
            result === "win"
              ? `🎉 Vous avez gagné ${payout - amount} tokens !`
              : result === "lose"
              ? `😞 Vous avez perdu ${amount} tokens.`
              : "😐 Match nul !",
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("❌ Blackjack game error:", err);
    return new Response(
      JSON.stringify({ success: false, error: "Server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
