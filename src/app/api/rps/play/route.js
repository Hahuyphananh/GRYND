import { NextResponse } from "next/server";
import { applyLeaderboardCounters } from "../../../../lib/leaderboardCounters";
import { sendSystemNotificationEmail } from "../../../../lib/emails/system";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../db/client";  import { users, rpsGames } from "../../../../db/schema"; // import rpsGames
import { eq, sql } from "drizzle-orm";

// Random AI choice
function getAIChoice() {
  const choices = ["rock", "paper", "scissors"];
  return choices[Math.floor(Math.random() * choices.length)];
}

// Determine win/lose/tie
function getResult(player, ai) {
  if (player === ai) return "tie";
  if (
    (player === "rock" && ai === "scissors") ||
    (player === "paper" && ai === "rock") ||
    (player === "scissors" && ai === "paper")
  ) {
    return "win";
  }
  return "lose";
}

// Fixed multiplier
const FIXED_MULTIPLIER = 1.9;

export async function POST(req) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;
    const userId = gate.userId;

    const body = await req.json();
    const { betAmount, choice, winStreak = 0 } = body;

    if (!choice || betAmount <= 0)
      return NextResponse.json({ error: "Invalid bet" }, { status: 400 });
    // Global bet cap (must match GLOBAL_MAX_BET in src/lib/games/economy.ts).
    if (betAmount > 100000)
      return NextResponse.json({ error: "Bet exceeds the maximum of 100,000 tokens" }, { status: 400 });

    // Get user
    const user = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
    });

    if (!user)
      return NextResponse.json({ error: "User not found" }, { status: 404 });

    if (Number(user.balance) < betAmount)
      return NextResponse.json({ error: "Not enough tokens" }, { status: 400 });

    // AI plays
    const aiChoice = getAIChoice();
    const result = getResult(choice, aiChoice);

    let payout = 0;
    let newStreak = result === "win" ? winStreak + 1 : 0;
    let balanceDelta = 0;

    if (result === "win") {
      //  ONLY 90% PROFIT (NOT INCLUDING BET)
      payout = betAmount * 0.9;
      balanceDelta = payout;
    } else if (result === "lose") {
      balanceDelta = -betAmount;
    }
    //  Update balance atomically
    const [updated] = await db
      .update(users)
      .set({ balance: sql`${users.balance} + ${balanceDelta}` })
      .where(eq(users.id, user.id))
      .returning({ balance: users.balance });

    //  Insert into rps_games table
    await db.insert(rpsGames).values({
      userId: userId,
      betAmount,
      choice,
      aiChoice,
      result,
      payout,
    });

    await applyLeaderboardCounters({
      clerkId: userId,
      game: "rps",
      betAmount,
      payout,
    });

    // Fire system notification for large RPS bets (≥ 1000 tokens)
    if (betAmount >= 1000) {
      sendSystemNotificationEmail({
        eventType: "bet_placed",
        description: `User ${userId} played a large RPS game with ${betAmount} tokens (result: ${result}, payout: ${payout}).`,
        metadata: { userId, betAmount, choice, aiChoice, result, payout },
      }).catch((err) => console.warn("[system_notify] Failed to send rps:", err));
    }

    return NextResponse.json({
      aiChoice,
      result,
      newBalance: Number(updated?.balance ?? user.balance),
      payout: payout.toFixed(2),
      winStreak: newStreak,
      multiplier: FIXED_MULTIPLIER.toFixed(2),
      message:
        result === "win"
          ? "You won!"
          : result === "lose"
            ? "You lost."
            : "It's a tie.",
    });
  } catch (err) {
    console.error("RPS API Error:", err);

    sendSystemNotificationEmail({
      eventType: "error_event",
      description: `RPS error for user ${userId}: ${(err).message || "Unknown error"}`,
      metadata: { userId, error: (err).stack?.slice(0, 500) || String(err) },
    }).catch((ew) => console.warn("[system_notify] Failed to send rps error:", ew));

    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
