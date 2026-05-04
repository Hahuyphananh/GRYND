import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";
import { parseAndValidateJson } from "../../../../lib/security/validation";
import { checkUnlocks } from "../../../../lib/specialTitles";

export async function POST(request) {
  const { userId } = await auth();

  if (!userId) {
    return new Response(JSON.stringify({ error: "Utilisateur non authentifié" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const parsed = await parseAndValidateJson(request, {
      game: { type: "string", required: false, default: "casino" },
      betAmount: { type: "number", required: true, min: 0, max: 1000000 },
      payout: { type: "number", required: false, min: 0, max: 1000000000, default: 0 },
      isAllIn: { type: "boolean", required: false, default: false },
      isJackpot: { type: "boolean", required: false, default: false },
      isPvpWin: { type: "boolean", required: false, default: false },
      balanceAfter: { type: "number", required: false, min: 0, max: 1000000000, default: 0 },
    });

    if (!parsed.ok) return parsed.response;

    const betAmount = Math.floor(parsed.data.betAmount);
    const payout = Math.floor(parsed.data.payout || 0);
    const multiplier = betAmount > 0 ? payout / betAmount : 0;
    const isWin = payout > betAmount;

    const [updated] = await sql`
      UPDATE users
      SET total_wagered = total_wagered + ${betAmount},
          weekly_wagered = weekly_wagered + ${betAmount},
          total_won = total_won + ${payout},
          weekly_won = weekly_won + ${payout},
          weekly_profit = weekly_profit + ${payout - betAmount},
          biggest_win = GREATEST(biggest_win, ${payout}),
          best_multiplier = GREATEST(best_multiplier, ${multiplier}),
          current_streak = CASE WHEN ${isWin} THEN current_streak + 1 ELSE 0 END,
          best_streak = GREATEST(best_streak, CASE WHEN ${isWin} THEN current_streak + 1 ELSE best_streak END),
          weekly_wins = weekly_wins + CASE WHEN ${isWin} THEN 1 ELSE 0 END,
          pvp_wins = pvp_wins + CASE WHEN ${Boolean(parsed.data.isPvpWin)} THEN 1 ELSE 0 END
      WHERE clerk_id = ${userId}
      RETURNING *
    `;

    if (multiplier >= 10) {
      await sql`
        INSERT INTO big_wins (id, user_id, username, game, bet_amount, win_amount, multiplier)
        SELECT gen_random_uuid(), clerk_id, name, ${parsed.data.game}, ${betAmount}, ${payout}, ${multiplier}
        FROM users
        WHERE clerk_id = ${userId}
      `;
    }

    const unlockedSpecialTitles = await checkUnlocks(userId, "game_result", {
      won: isWin,
      isAllIn: Boolean(parsed.data.isAllIn),
      isJackpot: Boolean(parsed.data.isJackpot),
      balanceAfter: Number(parsed.data.balanceAfter || 0),
    });

    return Response.json({ success: true, stats: updated, unlockedSpecialTitles });
  } catch (error) {
    console.error("❌ Failed to update user stats:", error);
    return new Response(JSON.stringify({ success: false, error: "Erreur lors de la mise à jour des statistiques" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
