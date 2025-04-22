import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres"; // ou ton propre client SQL

export async function POST() {
  console.log("✅ API /reset-user-tokens appelée");
  const { userId } = auth();
  
  console.log("🧪 userId:", userId);
  console.log("🧪 sessionId:", sessionId);  

  if (!userId) {
    return new Response(JSON.stringify({ error: "Non autorisé" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const existing = await sql`
      SELECT id FROM user_tokens WHERE user_id = ${userId}
    `;

    let result;
    if (existing.rowCount === 0) {
      result = await sql`
        INSERT INTO user_tokens (user_id, balance)
        VALUES (${userId}, 1000.00)
        RETURNING balance
      `;
    } else {
      result = await sql`
        UPDATE user_tokens
        SET balance = 1000.00
        WHERE user_id = ${userId}
        RETURNING balance
      `;
    }

    const balance = result.rows[0].balance;

    return new Response(JSON.stringify({ balance }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Erreur serveur:", error);
    return new Response(JSON.stringify({ error: "Erreur serveur" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
