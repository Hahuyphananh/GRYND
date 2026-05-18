import { NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

const MINIMUM_BIG_WIN_AMOUNT = 1000000; // 1 million tokens

export async function GET() {
  try {
    const sql = neon(process.env.DATABASE_URL!);

    const wins = await sql`
      SELECT 
        id,
        user_id as "userId",
        username,
        game,
        bet_amount as "betAmount",
        win_amount as "winAmount",
        multiplier,
        created_at as "createdAt"
      FROM big_wins
      WHERE win_amount >= ${MINIMUM_BIG_WIN_AMOUNT}
      ORDER BY created_at DESC
      LIMIT 50
    `;

    return NextResponse.json({ wins });
  } catch (error) {
    console.error("Error fetching big wins:", error);
    return NextResponse.json(
      { error: "Failed to fetch big wins" },
      { status: 500 }
    );
  }
}