import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";
import { parseAndValidateJson } from "../../../lib/security/validation";
import { auditLog } from "../../../lib/security/auditLog";

export async function POST(req) {
  const { userId } = await auth();
  if (!userId) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });
  }

  try {
    const parsed = await parseAndValidateJson(req, {
      eventId: {
        type: "string",
        required: true,
        minLength: 3,
        maxLength: 128,
        pattern: /^[a-z0-9_\-:.]+$/i,
      },
      betAmount: { type: "number", required: true, min: 1, max: 100000 },
      choice: { type: "string", required: true, minLength: 1, maxLength: 64 },
      odds: { type: "number", required: true, min: 1.01, max: 1000 },
      marketType: { type: "string", required: false, maxLength: 64, default: null },
      lineValue: { type: "number", required: false, min: -1000, max: 1000, default: null },
    });

    if (!parsed.ok) return parsed.response;
    const { eventId, betAmount, choice, odds, marketType, lineValue } = parsed.data;

    const userResult = await sql`
      SELECT id, balance FROM users WHERE clerk_id = ${userId}
    `;

    const dbUser = userResult.rows[0];
    if (!dbUser) {
      return new Response(JSON.stringify({ error: "User not found" }), {
        status: 404,
      });
    }

    const userBalance = parseFloat(dbUser.balance ?? 0);
    if (userBalance < betAmount) {
      return new Response(JSON.stringify({ error: "Insufficient balance" }), {
        status: 400,
      });
    }

    try {
      await sql`
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
        VALUES (
          ${dbUser.id},
          ${eventId},
          ${betAmount},
          ${choice},
          ${odds},
          ${marketType},
          ${lineValue},
          0,
          'pending'
        )
      `;
    } catch (migrationErr) {
      console.error("Sports bet insert fallback triggered");

      const legacyEventId = Number(eventId);
      if (!Number.isFinite(legacyEventId)) {
        return new Response(
          JSON.stringify({ error: "Insert failed due to invalid event id format" }),
          { status: 400 }
        );
      }

      await sql`
        INSERT INTO sports_bets (user_id, event_id, bet_amount, choice, odds, payout, result)
        VALUES (${dbUser.id}, ${legacyEventId}, ${betAmount}, ${choice}, ${odds}, 0, 'pending')
      `;
    }

    const newBalance = userBalance - betAmount;
    auditLog("sports_bet_placed", { userId, eventId, betAmount, previousBalance: userBalance, newBalance });
    await sql`
      UPDATE users SET balance = ${newBalance}
      WHERE clerk_id = ${userId}
    `;

    return new Response(JSON.stringify({ success: true, newBalance }), { status: 200 });
  } catch (error) {
    console.error("Error placing sports bet:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
    });
  }
}
