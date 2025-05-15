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
    // Check if wallet already exists
    const { rows: existing } = await sql`
      SELECT * FROM wallets WHERE user_id = ${userId}
    `;

    if (existing.length > 0) {
      return new Response(JSON.stringify({ wallet: existing[0] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Create new wallet
    const { rows: created } = await sql`
      INSERT INTO wallets (user_id)
      VALUES (${userId})
      RETURNING *
    `;

    return new Response(JSON.stringify({ wallet: created[0] }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("❌ Failed to create wallet:", error);
    return new Response(JSON.stringify({ error: "Erreur serveur lors de la création du portefeuille" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
