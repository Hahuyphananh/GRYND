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
    const { rows: games } = await sql`
      SELECT * FROM poker_games
      WHERE user_id = ${userId}
      AND result = 'active'
      ORDER BY created_at DESC
    `;

    return new Response(JSON.stringify({ games }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("❌ Error fetching poker games:", err);
    return new Response(JSON.stringify({ error: "Erreur serveur" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
