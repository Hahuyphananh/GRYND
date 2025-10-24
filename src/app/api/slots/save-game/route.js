import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { slotGames } from "../../../../db/schema";

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId)
      return NextResponse.json(
        { success: false, error: "Not authenticated" },
        { status: 401 }
      );

    const body = await req.json();
    const { betAmount, payout, reels } = body;

    if (betAmount == null || payout == null || !reels?.length) {
      return NextResponse.json(
        { success: false, error: "Invalid data" },
        { status: 400 }
      );
    }

    const numericBet = Number(betAmount);
    const numericPayout = Number(payout);

    let result = "lost";
    if (numericPayout > numericBet) result = "won";
    else if (numericPayout === numericBet) result = "draw";

    await db.insert(slotGames).values({
      userId,
      betAmount: numericBet,
      payout: numericPayout,
      reels: reels.join(","), // store the symbol layout as text
      result,
      status: "completed",
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error saving slot game:", error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
