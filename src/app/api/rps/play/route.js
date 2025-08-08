import { NextResponse } from "next/server";
import { getAuth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { users } from "../../../../db/schema";
import { eq } from "drizzle-orm";

// Tiered multipliers for win streaks
const streakMultipliers = [1.96, 3, 4.5, 7, 11, 15];

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

// Calculate multiplier based on streak
function calculateMultiplier(streak) {
  if (streak <= 0) return 1;
  return streakMultipliers[Math.min(streak - 1, streakMultipliers.length - 1)];
}

export async function POST(req) {
  try {
    const { userId } = getAuth(req);
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const { betAmount, choice, winStreak } = body;

    if (!choice || betAmount <= 0)
      return NextResponse.json({ error: "Invalid bet" }, { status: 400 });

    // Get the user from DB
    const user = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
    });

    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
    if (Number(user.balance) < betAmount)
      return NextResponse.json({ error: "Not enough tokens" }, { status: 400 });

    // AI plays
    const aiChoice = getAIChoice();
    const result = getResult(choice, aiChoice);

    let newBalance = Number(user.balance);
    let payout = 0;
    let newStreak = result === "win" ? winStreak + 1 : 0;

    if (result === "win") {
      const multiplier = calculateMultiplier(newStreak);
      payout = betAmount * multiplier;
      newBalance += payout;
    } else if (result === "lose") {
      newBalance -= betAmount;
    }
    // tie -> no token change

    // Update user balance
    await db
      .update(users)
      .set({ balance: newBalance.toString() })
      .where(eq(users.id, user.id));

    return NextResponse.json({
      aiChoice,
      result,
      newBalance,
      payout: payout.toFixed(2),
      winStreak: newStreak,
      multiplier: calculateMultiplier(newStreak).toFixed(2),
    });
  } catch (err) {
    console.error("RPS API Error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
