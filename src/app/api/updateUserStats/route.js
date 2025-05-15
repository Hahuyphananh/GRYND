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
    await sql`
      WITH bet_stats AS (
        SELECT 
          user_id,
          COUNT(*) as total_bets,
          SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN status = 'lost' THEN 1 ELSE 0 END) as losses,
          SUM(amount) as total_wagered,
          SUM(CASE WHEN status = 'won' THEN potential_win ELSE 0 END) as total_won
        FROM bets
        WHERE user_id = ${userId}
        GROUP BY user_id
      )
      INSERT INTO user_stats (
        user_id, total_bets, wins, losses, 
        total_wagered, total_won, win_rate
      )
      SELECT 
        user_id, total_bets, wins, losses,
        total_wagered, total_won,
        CASE WHEN total_bets > 0 THEN (wins::NUMERIC / total_bets * 100) ELSE 0 END
      FROM bet_stats
      ON CONFLICT (user_id) DO UPDATE SET
        total_bets = EXCLUDED.total_bets,
        wins = EXCLUDED.wins,
        losses = EXCLUDED.losses,
        total_wagered = EXCLUDED.total_wagered,
        total_won = EXCLUDED.total_won,
        win_rate = EXCLUDED.win_rate
    `;

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("❌ Failed to update user stats:", err);
    return new Response(JSON.stringify({
      success: false,
      error: "Erreur lors de la mise à jour des statistiques utilisateur",
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
