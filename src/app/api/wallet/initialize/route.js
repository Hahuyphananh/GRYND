import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";

/**
 * Creates a wallet for the user with a 1000 token initial bonus if none exists.
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function POST(request) {
  const { userId } = auth();

  if (!userId) {
    return new Response(JSON.stringify({ success: false, error: "Utilisateur non authentifié" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const { rows: existing } = await sql`
      SELECT * FROM wallets WHERE user_id = ${userId}
    `;

    if (existing.length > 0) {
      return new Response(JSON.stringify({ success: true, wallet: existing[0] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const [newWallet] = await sql.begin(async (tx) => {
      const { rows: created } = await tx`
        INSERT INTO wallets (user_id, balance)
        VALUES (${userId}, 1000)
        RETURNING *
      `;

      await tx`
        INSERT INTO transactions (user_id, type, amount, status)
        VALUES (${userId}, 'initial_bonus', 1000, 'completed')
      `;

      return created;
    });

    return new Response(JSON.stringify({ success: true, wallet: newWallet }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("❌ Error creating wallet with bonus:", err);
    return new Response(JSON.stringify({
      success: false,
      error: "Erreur serveur lors de la création du portefeuille",
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
