import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

const MINIMUM_BIG_WIN_AMOUNT = 1000000; // 1 million tokens

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { userId, username, game, betAmount, winAmount, multiplier } = body;

    // Validate required fields
    if (!userId || !username || !game || betAmount === undefined || winAmount === undefined || multiplier === undefined) {
      return NextResponse.json(
        { error: "Missing required fields: userId, username, game, betAmount, winAmount, multiplier" },
        { status: 400 }
      );
    }

    // Only record wins that meet the minimum threshold
    if (winAmount < MINIMUM_BIG_WIN_AMOUNT) {
      return NextResponse.json(
        { error: `Win amount must be at least ${MINIMUM_BIG_WIN_AMOUNT} tokens`, recorded: false },
        { status: 400 }
      );
    }

    const sql = neon(process.env.DATABASE_URL!);

    const result = await sql`
      INSERT INTO big_wins (user_id, username, game, bet_amount, win_amount, multiplier)
      VALUES (${userId}, ${username}, ${game}, ${betAmount}, ${winAmount}, ${multiplier})
      RETURNING *
    `;

    return NextResponse.json({
      success: true,
      recorded: true,
      win: result[0]
    });
  } catch (error) {
    console.error("Error recording big win:", error);
    return NextResponse.json(
      { error: "Failed to record big win" },
      { status: 500 }
    );
  }
}