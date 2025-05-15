import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function POST(request) {
  const { userId } = auth();

  if (!userId) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { tableAmount } = await request.json();

  if (!tableAmount || typeof tableAmount !== "number" || tableAmount <= 0) {
    return new Response(JSON.stringify({ error: "Invalid table amount" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    // Check for an opponent in the queue
    const { rows: opponents } = await sql`
      SELECT * FROM chess_queue
      WHERE bet_amount = ${tableAmount}
      AND user_id != ${userId}
      ORDER BY created_at ASC
      LIMIT 1
    `;

    if (opponents.length > 0) {
      const opponent = opponents[0];

      // Remove the opponent from queue
      await sql`
        DELETE FROM chess_queue
        WHERE id = ${opponent.id}
      `;

      // Insert new chess game
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
        }
      );
    }

    // No opponent found — enter matchmaking queue
    await sql`
      INSERT INTO chess_queue (user_id, bet_amount)
      VALUES (${userId}, ${tableAmount})
    `;

    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("❌ Chess matchmaking error:", err);

    return new Response(JSON.stringify({ error: "Server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
