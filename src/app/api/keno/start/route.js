import { getAuth } from "@clerk/nextjs/server";
import { eq, sql } from "drizzle-orm";
import { db } from "../../../../db/client";
import { applyLeaderboardCounters } from "../../../../lib/leaderboardCounters";
import { sendSystemNotificationEmail } from "../../../../lib/emails/system";
import { users, keno_games } from "../../../../db/schema";
import { KENO_MAX_PICKS, KENO_POOL_SIZE, KENO_DRAW_COUNT, calcKenoPayout, getKenoMultiplier } from "../../../../lib/kenoMultipliers";

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

    if (!Array.isArray(numbers) || numbers.length < 1 || numbers.length > KENO_MAX_PICKS) {
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

    // Draw winning numbers from the pool
    const available = Array.from({ length: KENO_POOL_SIZE }, (_, i) => i + 1);
    const winningNumbers = [];
    while (winningNumbers.length < KENO_DRAW_COUNT) {
      const idx = Math.floor(Math.random() * available.length);
      winningNumbers.push(available[idx]);
      available.splice(idx, 1);
    }

    // Calculate matches and payout
    const matches = numbers.filter((n) => winningNumbers.includes(n));
    const picks = numbers.length;
    const matchCount = matches.length;
    const multiplier = getKenoMultiplier(picks, matchCount);
    const payout = calcKenoPayout(picks, matchCount, betAmount);

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
          totalWagered: sql`${users.totalWagered} + ${betAmount}`,
          totalWon: sql`${users.totalWon} + ${payout}`,
        })
        .where(eq(users.id, user.id));
    } else {
      await db
        .update(users)
        .set({
          gamesLost: (user.gamesLost ?? 0) + 1,
          totalWagered: sql`${users.totalWagered} + ${betAmount}`,
        })
        .where(eq(users.id, user.id));
    }

    await applyLeaderboardCounters({
      clerkId: userId,
      game: "keno",
      betAmount,
      payout,
    });

    // Fire system notification for large keno bets (≥ 1000 tokens)
    if (betAmount >= 1000) {
      sendSystemNotificationEmail({
        eventType: "bet_placed",
        description: `User ${userId} played a large keno game with ${betAmount} tokens (hit ${matchCount}/${picks}, payout ${payout}).`,
        metadata: { userId, betAmount, picks, matchCount, payout },
      }).catch((err) => console.warn("[system_notify] Failed to send keno:", err));
    }

    return new Response(JSON.stringify({ winningNumbers, matches, payout }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error in Keno POST:", error);

    sendSystemNotificationEmail({
      eventType: "error_event",
      description: `Keno error: ${(error).message || "Unknown error"}`,
      metadata: { error: (error).stack?.slice(0, 500) || String(error) },
    }).catch((ew) => console.warn("[system_notify] Failed to send keno error:", ew));

    return new Response(JSON.stringify({ error: "Internal Server Error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
