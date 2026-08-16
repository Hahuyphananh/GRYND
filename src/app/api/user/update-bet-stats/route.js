import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";
import { parseAndValidateJson } from "../../../../lib/security/validation";
import { checkUnlocks } from "../../../../lib/specialTitles";

export async function POST(request) {
  const { userId } = await auth();

  if (!userId) {
    return new Response(
      JSON.stringify({ error: "Utilisateur non authentifié" }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  try {
    const parsed = await parseAndValidateJson(request, {
      game: { type: "string", required: false, default: "casino" },
      betAmount: { type: "number", required: true, min: 0, max: 1000000 },
      payout: {
        type: "number",
        required: false,
        min: 0,
        max: 1000000000,
        default: 0,
      },
      isAllIn: { type: "boolean", required: false, default: false },
      isJackpot: { type: "boolean", required: false, default: false },
      isPvpWin: { type: "boolean", required: false, default: false },
      balanceAfter: {
        type: "number",
        required: false,
        min: 0,
        max: 1000000000,
        default: 0,
      },
    });

    if (!parsed.ok) return parsed.response;

    const betAmount = Math.floor(parsed.data.betAmount);
    const payout = Math.floor(parsed.data.payout || 0);
    const multiplier = betAmount > 0 ? payout / betAmount : 0;
    const isWin = payout > betAmount;

    const [updated] = await sql`
      WITH updated_user AS (
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
      ),
      upserted_stats AS (
        INSERT INTO user_stats (
          user_id,
          total_bets,
          wins,
          losses,
          win_rate,
          total_wagered,
          total_won,
          biggest_win,
          current_streak,
          best_streak,
          level,
          xp,
          weekly_wagered,
          weekly_won,
          weekly_wins,
          weekly_losses,
          weekly_biggest_win,
          weekly_best_streak,
          weekly_win_rate
        )
        SELECT
          id,
          1,
          CASE WHEN ${isWin} THEN 1 ELSE 0 END,
          CASE WHEN ${isWin} THEN 0 ELSE 1 END,
          CASE WHEN ${isWin} THEN 100 ELSE 0 END,
          ${betAmount},
          ${payout},
          ${payout},
          CASE WHEN ${isWin} THEN 1 ELSE 0 END,
          CASE WHEN ${isWin} THEN 1 ELSE 0 END,
          level,
          xp,
          ${betAmount},
          ${payout},
          CASE WHEN ${isWin} THEN 1 ELSE 0 END,
          CASE WHEN ${isWin} THEN 0 ELSE 1 END,
          ${payout},
          CASE WHEN ${isWin} THEN 1 ELSE 0 END,
          CASE WHEN ${isWin} THEN 100 ELSE 0 END
        FROM updated_user
        ON CONFLICT (user_id) DO UPDATE SET
          total_bets = user_stats.total_bets + 1,
          wins = user_stats.wins + CASE WHEN ${isWin} THEN 1 ELSE 0 END,
          losses = user_stats.losses + CASE WHEN ${isWin} THEN 0 ELSE 1 END,
          win_rate = ROUND(((user_stats.wins + CASE WHEN ${isWin} THEN 1 ELSE 0 END)::numeric / NULLIF(user_stats.total_bets + 1, 0)) * 100, 2),
          total_wagered = user_stats.total_wagered + ${betAmount},
          total_won = user_stats.total_won + ${payout},
          biggest_win = GREATEST(user_stats.biggest_win, ${payout}),
          current_streak = CASE WHEN ${isWin} THEN user_stats.current_streak + 1 ELSE 0 END,
          best_streak = GREATEST(user_stats.best_streak, CASE WHEN ${isWin} THEN user_stats.current_streak + 1 ELSE user_stats.best_streak END),
          level = EXCLUDED.level,
          xp = EXCLUDED.xp,
          weekly_wagered = user_stats.weekly_wagered + ${betAmount},
          weekly_won = user_stats.weekly_won + ${payout},
          weekly_wins = user_stats.weekly_wins + CASE WHEN ${isWin} THEN 1 ELSE 0 END,
          weekly_losses = user_stats.weekly_losses + CASE WHEN ${isWin} THEN 0 ELSE 1 END,
          weekly_biggest_win = GREATEST(user_stats.weekly_biggest_win, ${payout}),
          weekly_best_streak = GREATEST(user_stats.weekly_best_streak, CASE WHEN ${isWin} THEN user_stats.current_streak + 1 ELSE user_stats.weekly_best_streak END),
          weekly_win_rate = ROUND(((user_stats.weekly_wins + CASE WHEN ${isWin} THEN 1 ELSE 0 END)::numeric / NULLIF(user_stats.weekly_wins + user_stats.weekly_losses + 1, 0)) * 100, 2),
          updated_at = NOW()
        RETURNING user_id
      )
      SELECT updated_user.*
      FROM updated_user
      LEFT JOIN upserted_stats ON upserted_stats.user_id = updated_user.id
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

    return Response.json({
      success: true,
      stats: updated,
      unlockedSpecialTitles,
    });
  } catch (error) {
    console.error(" Failed to update user stats:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: "Erreur lors de la mise à jour des statistiques",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
