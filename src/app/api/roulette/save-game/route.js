import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { rouletteGames, users } from "../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { applyLeaderboardCounters } from "../../../../lib/leaderboardCounters";
import { sendSystemNotificationEmail } from "../../../../lib/emails/system";

const rouletteNumbers = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24,
  16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
];
const redNumbers = [
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
];

function calculatePayout(bets, spinResult) {
  let winAmount = 0;
  for (const [bet, amount] of Object.entries(bets)) {
    const betAmount = Number(amount);
    if (!Number.isFinite(betAmount) || betAmount <= 0) continue;
    const betKey = Number.isNaN(Number(bet)) ? bet : Number(bet);

    if (typeof betKey === "number" && betKey === spinResult)
      winAmount += betAmount * 35;
    if (betKey === "red" && redNumbers.includes(spinResult))
      winAmount += betAmount * 2;
    if (
      betKey === "black" &&
      spinResult !== 0 &&
      !redNumbers.includes(spinResult)
    )
      winAmount += betAmount * 2;
    if (betKey === "green" && spinResult === 0) winAmount += betAmount * 35;
    if (betKey === "even" && spinResult % 2 === 0 && spinResult !== 0)
      winAmount += betAmount * 2;
    if (betKey === "odd" && spinResult % 2 === 1) winAmount += betAmount * 2;
    if (betKey === "1-12" && spinResult >= 1 && spinResult <= 12)
      winAmount += betAmount * 3;
    if (betKey === "13-24" && spinResult >= 13 && spinResult <= 24)
      winAmount += betAmount * 3;
    if (betKey === "25-36" && spinResult >= 25 && spinResult <= 36)
      winAmount += betAmount * 3;
    if (betKey === "1-18" && spinResult >= 1 && spinResult <= 18)
      winAmount += betAmount * 2;
    if (betKey === "19-36" && spinResult >= 19 && spinResult <= 36)
      winAmount += betAmount * 2;
  }
  return Number(winAmount.toFixed(2));
}

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const { bets } = await req.json();
    if (!bets || typeof bets !== "object") {
      return NextResponse.json(
        { success: false, error: "Invalid bets" },
        { status: 400 },
      );
    }

    // Get user data
    const userData = await db
      .select()
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);
    if (!userData.length) {
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 404 },
      );
    }

    const user = userData[0];
    const totalBetAmount = Object.values(bets).reduce((sum, amount) => {
      const numeric = Number(amount);
      if (!Number.isFinite(numeric) || numeric <= 0) return sum;
      return sum + numeric;
    }, 0);
    if (totalBetAmount <= 0) {
      return NextResponse.json(
        { success: false, error: "Invalid bet amount" },
        { status: 400 },
      );
    }

    const spinResultIndex = Math.floor(Math.random() * rouletteNumbers.length);
    const spinResult = rouletteNumbers[spinResultIndex];
    const payout = calculatePayout(bets, spinResult);
    const result = payout > 0 ? "won" : "lost";

    const [updatedUser] = await db
      .update(users)
      .set({ balance: sql`${users.balance} - ${totalBetAmount} + ${payout}` })
      .where(
        sql`${users.clerkId} = ${userId} AND ${users.balance} >= ${totalBetAmount}`,
      )
      .returning({ balance: users.balance });

    if (!updatedUser) {
      return NextResponse.json(
        { success: false, error: "Insufficient balance" },
        { status: 400 },
      );
    }

    // Record the game
    await db.insert(rouletteGames).values({
      userId: user.id,
      betAmount: totalBetAmount.toFixed(2),
      result,
      payout: payout.toFixed(2),
    });

    // Track leaderboard stats (also records big wins when payout >= 1M)
    applyLeaderboardCounters({
      clerkId: userId,
      game: "Roulette",
      betAmount: totalBetAmount,
      payout,
    }).catch(() => {});

    // Fire system notification for large roulette bets (≥ 1000 tokens)
    if (totalBetAmount >= 1000) {
      sendSystemNotificationEmail({
        eventType: "bet_placed",
        description: `User ${userId} played a large roulette round with ${totalBetAmount} total bet (spin: ${spinResult}, payout: ${payout}).`,
        metadata: { userId, totalBetAmount, spinResult, payout, result },
      }).catch((err) => console.warn("[system_notify] Failed to send roulette:", err));
    }

    return NextResponse.json({
      success: true,
      data: {
        spinResult,
        spinResultIndex,
        win: payout > 0,
        amount: payout,
        newBalance: Number(updatedUser.balance),
      },
    });
  } catch (error) {
    console.error("Roulette save-game error:", error);

    sendSystemNotificationEmail({
      eventType: "error_event",
      description: `Roulette error for user ${userId}: ${(error).message || "Unknown error"}`,
      metadata: { userId, error: (error).stack?.slice(0, 500) || String(error) },
    }).catch((ew) => console.warn("[system_notify] Failed to send roulette error:", ew));

    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
