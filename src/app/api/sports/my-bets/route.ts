import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { userId } = await auth();

    if (!userId) {
      return Response.json(
        { success: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    // Get internal user
    const userResult = await sql`
      SELECT id
      FROM users
      WHERE clerk_id = ${userId}
      LIMIT 1
    `;

    if (userResult.rows.length === 0) {
      return Response.json(
        { success: false, error: "User not found" },
        { status: 404 }
      );
    }

    const dbUser = userResult.rows[0];

    // Get bets
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
      const result = String(row.result || "pending").toLowerCase();

      return {
        id: row.id,
        eventId: row.event_external_id || row.event_id || null,
        choice: row.choice || "",
        amount: Number(row.bet_amount || 0),
        odds: Number(row.odds || 0),
        marketType: row.market_type || null,
        lineValue:
          row.line_value !== null && row.line_value !== undefined
            ? Number(row.line_value)
            : null,
        payout: Number(row.payout || 0),
        result,
        placedAt: row.placed_at || null,
      };
    });

    const currentBets = normalized.filter(
      (bet) => bet.result === "pending"
    );

    const betHistory = normalized.filter(
      (bet) => bet.result !== "pending"
    );

    return Response.json({
      success: true,
      currentBets,
      betHistory,
    });
  } catch (error) {
    console.error("MY BETS ERROR:", error);

    return Response.json(
      {
        success: false,
        error: "Internal server error",
      },
      { status: 500 }
    );
  }
}