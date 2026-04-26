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
      betAmount: { type: "number", required: true, min: 0, max: 1000000 },
      isWin: { type: "number", required: false, min: 0, max: 1, default: 0 },
      isAllIn: { type: "boolean", required: false, default: false },
      isJackpot: { type: "boolean", required: false, default: false },
      balanceAfter: { type: "number", required: false, min: 0, max: 1000000000, default: 0 },
    });

    if (!parsed.ok) return parsed.response;

    const betAmount = parsed.data.betAmount;
    const isWin = Boolean(parsed.data.isWin);
    const isAllIn = Boolean(parsed.data.isAllIn);
    const isJackpot = Boolean(parsed.data.isJackpot);
    const balanceAfter = Number(parsed.data.balanceAfter || 0);

    const updated = await sql.begin(async (tx) => {
      return await tx`
        INSERT INTO user_stats (
          user_id, total_bets, wins, losses, total_wagered, total_won, win_rate
        )
        VALUES (
          ${userId},
          1,
          ${isWin ? 1 : 0},
          ${isWin ? 0 : 1},
          ${betAmount},
          ${isWin ? betAmount : 0},
          ${isWin ? 100 : 0}
        )
        ON CONFLICT (user_id)
        DO UPDATE SET
          total_bets = user_stats.total_bets + 1,
          wins = user_stats.wins + ${isWin ? 1 : 0},
          losses = user_stats.losses + ${isWin ? 0 : 1},
          total_wagered = user_stats.total_wagered + ${betAmount},
          total_won = user_stats.total_won + ${isWin ? betAmount : 0},
          win_rate = ROUND(
            (user_stats.wins + ${isWin ? 1 : 0})::numeric / 
            (user_stats.total_bets + 1) * 100, 
            2
          )
        RETURNING *
      `;
    });

    const unlockedSpecialTitles = await checkUnlocks(userId, "game_result", {
      won: isWin,
      isAllIn,
      isJackpot,
      balanceAfter,
    });

    return new Response(JSON.stringify({
      success: true,
      stats: updated[0],
      unlockedSpecialTitles,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("❌ Failed to update user stats:", error);

    return new Response(JSON.stringify({
      success: false,
      error: "Erreur lors de la mise à jour des statistiques",
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
