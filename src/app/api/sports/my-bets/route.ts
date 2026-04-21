import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";
import { NextResponse } from "next/server";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const userResult = await sql`
      SELECT id FROM users WHERE clerk_id = ${userId} LIMIT 1
    `;
    const dbUser = userResult.rows[0];

    if (!dbUser) {
      return NextResponse.json({ success: false, error: "User not found" }, { status: 404 });
    }

    const betsResult = await sql`
      SELECT
        id,
        event_external_id,
        event_id,
        bet_amount,
        choice,
        odds,
        market_type,
        line_value,
        payout,
        result,
        placed_at
      FROM sports_bets
      WHERE user_id = ${dbUser.id}
      ORDER BY placed_at DESC, id DESC
      LIMIT 200
    `;

    const normalized = betsResult.rows.map((row) => {
      const result = (row.result || "pending").toLowerCase();
      return {
        id: row.id,
        eventId: row.event_external_id || row.event_id,
        choice: row.choice,
        amount: Number(row.bet_amount || 0),
        odds: Number(row.odds || 0),
        marketType: row.market_type || null,
        lineValue: row.line_value !== null && row.line_value !== undefined ? Number(row.line_value) : null,
        payout: Number(row.payout || 0),
        result,
        placedAt: row.placed_at,
      };
    });

    const currentBets = normalized.filter((bet) => !bet.result || bet.result === "pending");
    const betHistory = normalized.filter((bet) => bet.result && bet.result !== "pending");

    return NextResponse.json({
      success: true,
      currentBets,
      betHistory,
    });
  } catch (error) {
    console.error("[SPORTS_MY_BETS_ERROR]", error);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

