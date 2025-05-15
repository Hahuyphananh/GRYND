import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function POST(request) {
  const { userId } = auth();

  if (!userId) {
    return new Response(JSON.stringify({ error: "Utilisateur non authentifié" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const { betAmount, isWin } = await request.json();

    if (typeof betAmount !== "number" || isNaN(betAmount)) {
      return new Response(JSON.stringify({ error: "Montant de mise invalide" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

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

    return new Response(JSON.stringify({
      success: true,
      stats: updated[0],
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
