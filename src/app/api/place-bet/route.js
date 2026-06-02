import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";
import { getUserLevel } from "../../../lib/vipLevels";
import { parseAndValidateJson } from "../../../lib/security/validation";
import { claimIdempotency } from "../../../lib/security/idempotency";
import { getHighestTitle } from "../../../lib/titles";
import { checkUnlocks } from "../../../lib/specialTitles";
import { applyLeaderboardCounters } from "../../../lib/leaderboardCounters";
import { sendSystemNotificationEmail } from "../../../lib/emails/system";

export async function POST(request) {
  const { userId } = await auth();

  if (!userId) {
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized" }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  try {
    const idem = await claimIdempotency(request, "bets:place", 180);
    if (idem.enforced && !idem.allowed) {
      return new Response(
        JSON.stringify({ success: false, error: "Duplicate request" }),
        {
          status: 409,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const parsed = await parseAndValidateJson(request, {
      amount: { type: "number", required: true, min: 0.01, max: 1000000 },
      selectionId: {
        type: "number",
        required: false,
        integer: true,
        min: 1,
        default: null,
      },
      source: {
        type: "string",
        required: false,
        pattern: /^(real|demo)$/i,
        default: "real",
      },
    });

    if (!parsed.ok) return parsed.response;

    const { amount, selectionId, source } = parsed.data;

    const betAmount = Number(amount);
    if (!betAmount || betAmount <= 0) {
      return new Response(
        JSON.stringify({ success: false, error: "Invalid amount" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const userResult = await sql`
      SELECT id, balance, total_wagered, level
      FROM users
      WHERE clerk_id = ${userId}
      LIMIT 1
    `;

    const dbUser = userResult.rows[0];
    const startingBalance = Number(userResult.rows[0]?.balance || 0);
    if (!dbUser) {
      return new Response(
        JSON.stringify({ success: false, error: "User not found" }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (Number(dbUser.balance) < betAmount) {
      return new Response(
        JSON.stringify({ success: false, error: "Insufficient balance" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    let event = null;

    await sql.begin(async (tx) => {
      await tx`
        UPDATE users
        SET balance = balance - ${betAmount}
        WHERE id = ${dbUser.id}
      `;

      if (source === "real") {
        const updatedWagered = Number(dbUser.total_wagered || 0) + betAmount;
        const previousLevel = Number(
          dbUser.level || getUserLevel(Number(dbUser.total_wagered || 0)),
        );
        const nextLevel = getUserLevel(updatedWagered);

        let bonus = 0;
        const newHighestTitle = getHighestTitle(nextLevel)?.title || null;
        const previousHighestTitle =
          getHighestTitle(previousLevel)?.title || null;

        if (nextLevel > previousLevel) {
          bonus = nextLevel * 100;
          event = { type: "LEVEL_UP", level: nextLevel, bonus };
        }

        if (newHighestTitle && newHighestTitle !== previousHighestTitle) {
          event = {
            ...(event || {}),
            type: event?.type || "TITLE_UNLOCK",
            newUnlockedTitle: newHighestTitle,
          };
        }

        await tx`
          UPDATE users
          SET total_wagered = ${updatedWagered},
              level = ${nextLevel},
              balance = balance + ${bonus},
              highest_title = COALESCE(${newHighestTitle}, highest_title)
          WHERE id = ${dbUser.id}
        `;

        await tx`
          INSERT INTO user_stats (user_id, total_wagered, level, weekly_level_gain)
          VALUES (${dbUser.id}, ${updatedWagered}, ${nextLevel}, ${Math.max(0, nextLevel - previousLevel)})
          ON CONFLICT (user_id) DO UPDATE SET
            total_wagered = GREATEST(user_stats.total_wagered, EXCLUDED.total_wagered),
            level = EXCLUDED.level,
            weekly_level_gain = user_stats.weekly_level_gain + EXCLUDED.weekly_level_gain,
            updated_at = NOW()
        `;
      }

      await tx`
        INSERT INTO bets (user_id, selection_id, amount, potential_win, status)
        VALUES (${dbUser.id}, ${selectionId ?? null}, ${betAmount}, 0, 'pending')
      `;
    });

    await applyLeaderboardCounters({
      clerkId: userId,
      game: "sports",
      betAmount,
      payout: 0,
    });

    // Fire system notification for large bets (≥ 1000 tokens)
    if (betAmount >= 1000) {
      sendSystemNotificationEmail({
        eventType: "bet_placed",
        description: `User ${userId} placed a large bet of ${betAmount} tokens (source: ${source}).`,
        metadata: { userId, betAmount, source, selectionId },
      }).catch((err) => console.warn("[system_notify] Failed to send:", err));
    }

    const unlockedSpecialTitles = await checkUnlocks(userId, "bet_placed", {
      isAllIn: startingBalance > 0 && betAmount >= startingBalance,
      balanceAfter: Math.max(0, startingBalance - betAmount),
    });

    return new Response(
      JSON.stringify({ success: true, event, unlockedSpecialTitles }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("[PLACE_BET_ERROR]", error);

    // Send system notification on internal errors
    sendSystemNotificationEmail({
      eventType: "error_event",
      description: `Place-bet error for user ${userId}: ${(error).message || "Unknown error"}`,
      metadata: { userId, error: (error).stack?.slice(0, 500) || String(error) },
    }).catch((err) => console.warn("[system_notify] Failed to send error alert:", err));

    return new Response(
      JSON.stringify({ success: false, error: "Failed to place bet" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
