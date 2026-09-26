import { NextResponse } from "next/server";
import { applyLeaderboardCounters } from "../../../../lib/leaderboardCounters";
import { sendSystemNotificationEmail } from "../../../../lib/emails/system";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../db/client";  import { users, rpsGames } from "../../../../db/schema"; // import rpsGames
import { eq } from "drizzle-orm";
import { normalizeStake } from "../../../../lib/games/stakes";

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
    let { betAmount, choice, winStreak = 0 } = body;

    if (!choice)
      return NextResponse.json({ error: "Invalid bet" }, { status: 400 });
    // STAKES ARE RETIRED (src/lib/games/stakes.js): a ranked game is free.
    // The requested bet is normalized to 0, so the balance update below is a
    // no-op and the payout is nothing.
    betAmount = normalizeStake(betAmount);

    // Get user
    const user = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
    });

    if (!user)
      return NextResponse.json({ error: "User not found" }, { status: 404 });

    // AI plays
    const aiChoice = getAIChoice();
    const result = getResult(choice, aiChoice);

    // STAKES ARE RETIRED: no bet, no payout.
    const payout = 0;
    const newStreak = result === "win" ? winStreak + 1 : 0;

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
      newBalance: Number(user.balance),
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
