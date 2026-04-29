import { auth } from "@clerk/nextjs/server";
import { getNeonSql } from "../../../../db/neon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function extractRows<T = Record<string, any>>(result: any): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && Array.isArray(result.rows)) return result.rows as T[];
  return [];
}

export async function GET(req: Request) {
  try {
    const sql = getNeonSql();
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

    const userRows = extractRows<{ id: number }>(userResult);

    if (userRows.length === 0) {
      return Response.json(
        { success: false, error: "User not found" },
        { status: 404 }
      );
    }

    const dbUser = userRows[0];

    const { searchParams } = new URL(req.url);
    const status = String(searchParams.get("status") || "all").toLowerCase();
    const rawLimit = Number(searchParams.get("limit") || 100);
    const limit = Math.max(1, Math.min(rawLimit, 100));

    let betsResult;
    if (status === "pending") {
      betsResult = await sql`
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
      WHERE user_id = ${dbUser.id} AND result = 'pending'
      ORDER BY placed_at DESC, id DESC
      LIMIT ${limit}
    `;
    } else if (status === "history") {
      betsResult = await sql`
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
      WHERE user_id = ${dbUser.id} AND result <> 'pending'
      ORDER BY placed_at DESC, id DESC
      LIMIT ${limit}
    `;
    } else {
      betsResult = await sql`
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
      LIMIT ${limit}
    `;
    }

    const betRows = extractRows<Record<string, any>>(betsResult);

    const normalized = betRows.map((row) => {
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
