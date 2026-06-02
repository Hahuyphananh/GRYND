import { auth } from "@clerk/nextjs/server";
import { getNeonSql } from "../../../db/neon";
import { applyLeaderboardCounters } from "../../../lib/leaderboardCounters";
import { sendSystemNotificationEmail } from "../../../lib/emails/system";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req) {
  const { userId } = await auth();

  try {
    const sql = getNeonSql();

    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Safe body parsing for Vercel
    let body;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // Extract values
    const eventId = String(body.eventId || "").trim();
    const choice = String(body.choice || "").trim();
    const marketType = body.marketType ? String(body.marketType) : null;

    const betAmount = Number(body.betAmount);
    const odds = Number(body.odds);
    const lineValue =
      body.lineValue !== undefined && body.lineValue !== null
        ? Number(body.lineValue)
        : null;

    // Basic validation
    if (!eventId || eventId.length < 2) {
      return Response.json({ error: "Invalid eventId" }, { status: 400 });
    }

    if (!choice) {
      return Response.json({ error: "Invalid choice" }, { status: 400 });
    }

    if (!Number.isFinite(betAmount) || betAmount < 1) {
      return Response.json({ error: "Invalid bet amount" }, { status: 400 });
    }

    if (!Number.isFinite(odds) || odds < 1.01) {
      return Response.json({ error: "Invalid odds" }, { status: 400 });
    }

    const placeBetWithMarketCols = async () => {
      return sql`
        WITH debited AS (
          UPDATE users
          SET balance = balance - ${betAmount}
          WHERE clerk_id = ${userId}
            AND balance >= ${betAmount}
          RETURNING id, balance
        ),
        placed AS (
          INSERT INTO sports_bets (
            user_id,
            event_external_id,
            bet_amount,
            choice,
            odds,
            market_type,
            line_value,
            payout,
            result
          )
          SELECT
            debited.id,
            ${eventId},
            ${betAmount},
            ${choice},
            ${odds},
            ${marketType},
            ${lineValue},
            0,
            'pending'
          FROM debited
          RETURNING id
        )
        SELECT debited.balance AS new_balance, placed.id AS bet_id
        FROM debited
        LEFT JOIN placed ON true
      `;
    };

    const placeBetLegacy = async () => {
      return sql`
        WITH debited AS (
          UPDATE users
          SET balance = balance - ${betAmount}
          WHERE clerk_id = ${userId}
            AND balance >= ${betAmount}
          RETURNING id, balance
        ),
        placed AS (
          INSERT INTO sports_bets (
            user_id,
            event_external_id,
            bet_amount,
            choice,
            odds,
            payout,
            result
          )
          SELECT
            debited.id,
            ${eventId},
            ${betAmount},
            ${choice},
            ${odds},
            0,
            'pending'
          FROM debited
          RETURNING id
        )
        SELECT debited.balance AS new_balance, placed.id AS bet_id
        FROM debited
        LEFT JOIN placed ON true
      `;
    };

    const placeBetMinimal = async () => {
      return sql`
        WITH debited AS (
          UPDATE users
          SET balance = balance - ${betAmount}
          WHERE clerk_id = ${userId}
            AND balance >= ${betAmount}
          RETURNING id, balance
        ),
        placed AS (
          INSERT INTO sports_bets (
            user_id,
            event_id,
            bet_amount,
            choice,
            odds,
            payout,
            result
          )
          SELECT
            debited.id,
            ${eventId},
            ${betAmount},
            ${choice},
            ${odds},
            0,
            'pending'
          FROM debited
          RETURNING id
        )
        SELECT debited.balance AS new_balance, placed.id AS bet_id
        FROM debited
        LEFT JOIN placed ON true
      `;
    };

    let placeResult;
    try {
      placeResult = await placeBetWithMarketCols();
    } catch (dbErr) {
      if (dbErr?.code === "42703") {
        // Production schema may not have market_type / line_value columns yet.
        console.warn("[PLACE_BET_SCHEMA_FALLBACK]", dbErr?.message || dbErr);
        try {
          placeResult = await placeBetLegacy();
        } catch (dbErr2) {
          if (dbErr2?.code === "42703") {
            // event_external_id column also missing — use original event_id
            console.warn("[PLACE_BET_SCHEMA_FALLBACK2]", dbErr2?.message || dbErr2);
            placeResult = await placeBetMinimal();
          } else {
            throw dbErr2;
          }
        }
      } else {
        throw dbErr;
      }
    }

    if (!placeResult.rows?.length) {
      const exists =
        await sql`SELECT 1 FROM users WHERE clerk_id = ${userId} LIMIT 1`;
      if (!exists.rows?.length) {
        return Response.json({ error: "User not found" }, { status: 404 });
      }
      return Response.json({ error: "Insufficient balance" }, { status: 400 });
    }

    const newBalance = Number(placeResult.rows[0].new_balance);
    await applyLeaderboardCounters({
      clerkId: userId,
      game: "sports",
      betAmount,
      payout: 0,
    });

    // Fire system notification for large sports bets (≥ 1000 tokens)
    if (betAmount >= 1000) {
      sendSystemNotificationEmail({
        eventType: "bet_placed",
        description: `User ${userId} placed a large sports bet of ${betAmount} tokens on event ${eventId} (choice: ${choice}).`,
        metadata: { userId, betAmount, eventId, choice, odds },
      }).catch((err) => console.warn("[system_notify] Failed to send:", err));
    }

    return Response.json({
      success: true,
      newBalance,
    });
  } catch (error) {
    console.error("PLACE BET ERROR:", error);

    // Send system notification on internal errors
    sendSystemNotificationEmail({
      eventType: "error_event",
      description: `Sports-bet error for user ${userId}: ${(error).message || "Unknown error"}`,
      metadata: { userId, error: (error).stack?.slice(0, 500) || String(error) },
    }).catch((err) => console.warn("[system_notify] Failed to send error alert:", err));

    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
