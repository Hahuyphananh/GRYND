import { auth } from "@clerk/nextjs/server";
import { getNeonSql } from "../../../../db/neon";
import { parseAndValidateJson } from "../../../../lib/security/validation";

function buildCurrentGameId(gameKey, gameId) {
  if (gameId === null || gameId === undefined) return gameKey;
  return `${gameKey}:${gameId}`;
}

export async function POST(request) {
  const sql = getNeonSql();
  try {
    const { userId } = await auth();
    if (!userId) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 401 });
    }

    const parsed = await parseAndValidateJson(request, {
      gameKey: { type: "string", required: true, minLength: 2, maxLength: 80 },
      gameId: { type: "number", required: false, default: null },
    });

    if (!parsed.ok) return parsed.response;

    const gameKey = parsed.data.gameKey.trim().toLowerCase();
    const gameId = Number.isFinite(parsed.data.gameId) ? Number(parsed.data.gameId) : null;
    const currentGameId = buildCurrentGameId(gameKey, gameId);

    const rows = await sql`
      INSERT INTO user_presence (clerk_id, last_seen, status, current_game_id, updated_at)
      VALUES (${userId}, NOW(), 'in_game', ${currentGameId}, NOW())
      ON CONFLICT (clerk_id)
      DO UPDATE SET
        last_seen = NOW(),
        status = 'in_game',
        current_game_id = EXCLUDED.current_game_id,
        updated_at = NOW()
      RETURNING clerk_id, status, current_game_id, last_seen, updated_at
    `;

    return new Response(JSON.stringify({ success: true, data: rows[0] || null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[PRESENCE_GAME_ERROR]", error);
    return new Response(JSON.stringify({ success: false, error: "Failed to update game presence" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
