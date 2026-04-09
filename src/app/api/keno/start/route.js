import { getAuth } from "@clerk/nextjs/server";
import { eq, sql } from "drizzle-orm";
import { db } from "../../../../db/client";
import { users, keno_games } from "../../../../db/schema";

const multiplierTable = {
  1: { 1: 3 },
  2: { 1: 1.5, 2: 6 },
  3: { 1: 1.2, 2: 3, 3: 12 },
  4: { 2: 2, 3: 6, 4: 20 },
  5: { 2: 2, 3: 5, 4: 15, 5: 50 },
  // Extend if needed
};

export async function POST(req) {
  try {
    const { userId } = getAuth(req);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { betAmount, numbers } = await req.json();

    if (!Array.isArray(numbers) || numbers.length < 1 || numbers.length > 10) {
      return new Response(JSON.stringify({ error: "Invalid numbers" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (typeof betAmount !== "number" || betAmount <= 0) {
      return new Response(JSON.stringify({ error: "Invalid bet amount" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const user = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
    });

    if (!user) {
      return new Response(JSON.stringify({ error: "User not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const [deducted] = await db
      .update(users)
      .set({ balance: sql`${users.balance} - ${betAmount}` })
      .where(sql`${users.id} = ${user.id} AND ${users.balance} >= ${betAmount}`)
      .returning({ balance: users.balance });

    if (!deducted) {
      return new Response(JSON.stringify({ error: "Not enough balance" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Draw 10 unique winning numbers (1-40)
    const available = Array.from({ length: 40 }, (_, i) => i + 1);
    const winningNumbers = [];
    while (winningNumbers.length < 10) {
      const idx = Math.floor(Math.random() * available.length);
      winningNumbers.push(available[idx]);
      available.splice(idx, 1);
    }

    // Calculate matches and payout
    const matches = numbers.filter((n) => winningNumbers.includes(n));
    const picks = numbers.length;
    const matchCount = matches.length;
    const multiplier = multiplierTable[picks]?.[matchCount] || 0;
    const payout = +(betAmount * multiplier).toFixed(2);

    // Insert game record
    await db.insert(keno_games).values({
      user_id: user.id,
      bet_amount: betAmount,
      numbers_picked: numbers,
      numbers_drawn: winningNumbers,
      hits: matchCount,
      payout,
      multiplier,
      status: payout > 0 ? "won" : "lost",
      created_at: new Date(),
    });

    // Update user stats & balance
    if (payout > 0) {
      await db
        .update(users)
        .set({
          balance: sql`${users.balance} + ${payout}`,
          gamesWon: (user.gamesWon ?? 0) + 1,
        })
        .where(eq(users.id, user.id));
    } else {
      await db
        .update(users)
        .set({ gamesLost: (user.gamesLost ?? 0) + 1 })
        .where(eq(users.id, user.id));
    }

    return new Response(
      JSON.stringify({ winningNumbers, matches, payout }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error in Keno POST:", error);
    return new Response(
      JSON.stringify({ error: "Internal Server Error" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
