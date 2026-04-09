import { NextResponse } from "next/server";
import { getAuth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { users, rpsGames } from "../../../../db/schema"; // ✅ import rpsGames
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
    const { userId } = getAuth(req);
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const { betAmount, choice, winStreak = 0 } = body;

    if (!choice || betAmount <= 0)
      return NextResponse.json({ error: "Invalid bet" }, { status: 400 });

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
      payout = betAmount * FIXED_MULTIPLIER;
      balanceDelta = payout;
    } else if (result === "lose") {
      balanceDelta = -betAmount;
    }

    // ✅ Update balance atomically
    const [updated] = await db
      .update(users)
      .set({ balance: sql`${users.balance} + ${balanceDelta}` })
      .where(eq(users.id, user.id))
      .returning({ balance: users.balance });

    // ✅ Insert into rps_games table
    await db.insert(rpsGames).values({
      userId: userId,
      betAmount,
      choice,
      aiChoice,
      result,
      payout,
    });

    return NextResponse.json({
      aiChoice,
      result,
      newBalance: Number(updated?.balance ?? user.balance),
      payout: payout.toFixed(2),
      winStreak: newStreak,
      multiplier: FIXED_MULTIPLIER.toFixed(2),
      message:
        result === "win"
          ? "🎉 You won!"
          : result === "lose"
          ? "😢 You lost."
          : "🤝 It's a tie.",
    });
  } catch (err) {
    console.error("RPS API Error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
