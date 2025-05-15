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
    const { amount } = await request.json();

    if (typeof amount !== "number" || isNaN(amount)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Le montant est requis et doit être un nombre",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const { rows: userRows } = await sql`
      SELECT balance 
      FROM user_tokens 
      WHERE user_id = ${userId}
    `;

    if (userRows.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Compte de tokens non trouvé",
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const { rows: updateRows } = await sql`
      UPDATE user_tokens 
      SET balance = balance + ${amount}
      WHERE user_id = ${userId}
      RETURNING balance
    `;

    const newBalance = updateRows[0].balance;

    await sql`
      INSERT INTO transactions (
        user_id,
        type,
        amount,
        balance_after,
        status
      ) VALUES (
        ${userId},
        ${amount > 0 ? "win" : "loss"},
        ${Math.abs(amount)},
        ${newBalance},
        'completed'
      )
    `;

    return new Response(
      JSON.stringify({
        success: true,
        data: { balance: newBalance },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("❌ Error updating token balance:", error);

    return new Response(
      JSON.stringify({
        success: false,
        error: "Erreur lors de la mise à jour du solde",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
