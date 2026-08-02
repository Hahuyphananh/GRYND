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

    // Sport key (e.g. "basketball_nba") is stored in selection_metadata so the
    // settle route can fetch scores ONLY for sports the user has pending bets
    // on — instead of scanning every sport (which exhausted the monthly quota).
    const sportKey = body.sportKey ? String(body.sportKey).trim() : null;
    const selectionMetadata = sportKey
      ? JSON.stringify({ sportKey })
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
            selection_metadata,
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
            CASE WHEN ${selectionMetadata} IS NOT NULL THEN ${selectionMetadata}::jsonb ELSE '{}'::jsonb END,
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

    // Explicit user existence + balance check BEFORE the place-bet CTE.
    // Replaces the previous "post-CTE exists query to disambiguate" approach
    // which produced the misleading "User not found" symptom: a separate
    // existence query running after a no-row CTE could return rows=true on a
    // real user (so -> Insufficient balance) but on a transient DB hiccup
    // could return rows=false (so -> User not found while the user's row was
    // actually fine). Doing the check upfront makes the error contract
    // deterministic and matches the user's account state at request time.
    const userLookup = await sql`
      SELECT id, balance::numeric AS balance
      FROM users
      WHERE clerk_id = ${userId}
      LIMIT 1
    `;
    const userRows = Array.isArray(userLookup)
      ? userLookup
      : userLookup.rows ?? [];
    const dbUserRow = userRows[0];

    if (!dbUserRow) {
      console.error(
        `[PLACE_BET] Clerk user ${userId} has no DB row - refusing to place bet`,
      );
      return Response.json(
        {
          error: "Account setup incomplete. Please refresh and try again.",
          code: "USER_NOT_FOUND",
        },
        { status: 404 },
      );
    }

    if (Number(dbUserRow.balance) < betAmount) {
      return Response.json(
        { error: "Insufficient balance", code: "INSUFFICIENT_BALANCE" },
        { status: 400 },
      );
    }

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

    // `neon()` tagged-template queries return rows directly as an array
    // (e.g. [{ new_balance: "990.00", bet_id: 12 }]) — NOT a `{ rows: [...] }`
    // result object like @vercel/postgres. Normalize so the row checks below
    // work for both shapes. Without this, `.rows` was always undefined on the
    // array result, so the route took the "0-row" defensive branch even after
    // a successful CTE (bet placed + balance debited) and returned 500
    // PLACE_FAILED.
    const placeRows = Array.isArray(placeResult)
      ? placeResult
      : placeResult?.rows ?? [];

    if (!placeRows.length) {
      // 0-row CTE. Two possible causes:
      //   (a) Concurrent deduction by another request dropped the balance
      //       below betAmount between our pre-check and the CTE — surface
      //       this as 400 INSUFFICIENT_BALANCE so the UI shows the correct
      //       reason (a 500 here would look like a server fault to the user).
      //   (b) Genuine unexpected CTE failure (rare — DB hiccup, schema drift
      //       we couldn't catch via column-missing fallback, etc.) — keep the
      //       500 PLACE_FAILED fallback.
      // Re-querying here adds one indexed lookup on a slow path only, and
      // recovers the right error code in the common race case.
      try {
        const recheck = await sql`
          SELECT balance::numeric AS balance
          FROM users
          WHERE clerk_id = ${userId}
          LIMIT 1
        `;
        const recheckRows = Array.isArray(recheck) ? recheck : recheck.rows ?? [];
        const currentBalance = Number(recheckRows[0]?.balance ?? -1);

        if (Number.isFinite(currentBalance) && currentBalance < betAmount) {
          console.warn(
            `[PLACE_BET] Race-detected: balance ${dbUserRow.balance} -> ${currentBalance} between pre-check and CTE; reporting INSUFFICIENT_BALANCE`,
          );
          return Response.json(
            { error: "Insufficient balance", code: "INSUFFICIENT_BALANCE" },
            { status: 400 },
          );
        }
      } catch (recheckErr) {
        console.warn("[PLACE_BET] Race-disambiguation recheck failed:", recheckErr);
      }

      console.error(
        `[PLACE_BET] Defensive: CTE returned 0 rows despite user=${dbUserRow.id} balance=${dbUserRow.balance} amount=${betAmount}`,
      );
      return Response.json(
        {
          error: "Could not place bet. Please try again.",
          code: "PLACE_FAILED",
        },
        { status: 500 },
      );
    }

    const newBalance = Number(placeRows[0].new_balance);
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
