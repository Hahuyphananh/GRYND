import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { plinkoGames } from "../../../../db/schema";
import { applyLeaderboardCounters } from "../../../../lib/leaderboardCounters";

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId)
      return NextResponse.json(
        { success: false, error: "Not authenticated" },
        { status: 401 },
      );

    const body = await req.json();
    const { totalBet, multipliers, totalPayout } = body;

    if (!totalBet || !multipliers?.length) {
      return NextResponse.json(
        { success: false, error: "Invalid data" },
        { status: 400 },
      );
    }

    // 🧮 Determine result correctly
    const numericBet = Number(totalBet);
    const numericPayout = Number(totalPayout);

    let result = "lost";
    if (numericPayout > numericBet) result = "won";
    else if (numericPayout === numericBet) result = "draw"; // optional

    // 💾 Save one combined game
    await db.insert(plinkoGames).values({
      userId: userId,
      betAmount: numericBet,
      resultMultiplier: multipliers.join(","), // e.g. "2,0.5,5"
      payout: numericPayout,
      result,
      status: "completed",
    });

    await applyLeaderboardCounters({
      clerkId: userId,
      game: "plinko",
      betAmount: numericBet,
      payout: numericPayout,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error saving Plinko games:", error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 },
    );
  }
}
