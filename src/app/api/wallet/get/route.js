import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function POST(request) {
  const { userId } = auth();

  if (!userId) {
    return new Response(JSON.stringify({ error: "Non authentifié" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const { rows } = await sql`
      SELECT * FROM wallets 
      WHERE user_id = ${userId}
    `;

    return new Response(JSON.stringify({ wallet: rows[0] || null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("❌ Failed to fetch wallet:", error);
    return new Response(JSON.stringify({ error: "Erreur serveur lors de la récupération du portefeuille" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
