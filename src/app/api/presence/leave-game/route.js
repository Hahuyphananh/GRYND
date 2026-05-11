import { auth } from "@clerk/nextjs/server";
import { getNeonSql } from "../../../../db/neon";

export async function POST() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return new Response(
        JSON.stringify({ success: false, error: "Unauthorized" }),
        { status: 401 },
      );
    }

    const rows = await sql`
      INSERT INTO user_presence (clerk_id, last_seen, status, current_game_id, updated_at)
      VALUES (${userId}, NOW(), 'online', NULL, NOW())
      ON CONFLICT (clerk_id)
      DO UPDATE SET
        last_seen = NOW(),
        status = 'online',
        current_game_id = NULL,
        updated_at = NOW()
      RETURNING clerk_id, status, current_game_id, last_seen, updated_at
    `;

    return new Response(
      JSON.stringify({ success: true, data: rows[0] || null }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("[PRESENCE_LEAVE_GAME_ERROR]", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: "Failed to leave game presence",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
