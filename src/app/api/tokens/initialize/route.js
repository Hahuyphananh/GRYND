import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function POST(request) {
  const { userId } = auth();

  if (!userId) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "Utilisateur non authentifié",
      }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  try {
    const { rows: existing } = await sql`
      SELECT * FROM user_tokens WHERE user_id = ${userId}
    `;

    if (existing.length > 0) {
      return new Response(JSON.stringify({ success: true, data: existing[0] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { rows: inserted } = await sql`
      INSERT INTO user_tokens (user_id, balance)
      VALUES (${userId}, 1000)
      RETURNING *
    `;

    return new Response(JSON.stringify({ success: true, data: inserted[0] }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("❌ Error initializing user tokens:", err);

    return new Response(
      JSON.stringify({
        success: false,
        error: "Erreur lors de l'initialisation des tokens",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
