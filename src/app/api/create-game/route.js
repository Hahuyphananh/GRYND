import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";
import { parseAndValidateJson } from "../../../lib/security/validation";

export async function POST(request) {
  const { userId } = await auth();

  if (!userId) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const parsed = await parseAndValidateJson(request, {
    tableAmount: {
      type: "number",
      required: true,
      integer: true,
      min: 1,
      max: 100000,
    },
  });
  if (!parsed.ok) return parsed.response;
  const { tableAmount } = parsed.data;

  try {
    const { rows: opponents } = await sql`
      SELECT * FROM chess_queue
      WHERE bet_amount = ${tableAmount}
      AND user_id != ${userId}
      ORDER BY created_at ASC
      LIMIT 1
    `;

    if (opponents.length > 0) {
      const opponent = opponents[0];

      await sql`
        DELETE FROM chess_queue
        WHERE id = ${opponent.id}
      `;

      const { rows: newGame } = await sql`
        INSERT INTO chess_games (
          player_white_id,
          player_black_id,
          bet_amount
        )
        VALUES (
          ${opponent.user_id}, ${userId}, ${tableAmount}
        )
        RETURNING id
      `;

      return new Response(
        JSON.stringify({
          gameId: newGame[0].id,
          color: "black",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    await sql`
      INSERT INTO chess_queue (user_id, bet_amount)
      VALUES (${userId}, ${tableAmount})
    `;

    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(" Chess matchmaking error:", err);

    return new Response(JSON.stringify({ error: "Server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
