import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";
import { parseAndValidateJson } from "../../../../lib/security/validation";

export async function POST(request) {
  try {
  const { userId } = await auth();
  if (!userId) return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 401 });

  const parsed = await parseAndValidateJson(request, {
    gameKey: { type: "string", required: true, minLength: 2, maxLength: 80 },
    gameId: { type: "number", required: false, default: null },
  });

  if (!parsed.ok) return parsed.response;

  const me = await sql`SELECT id FROM users WHERE clerk_id = ${userId} LIMIT 1`;
  if (!me.rows.length) return new Response(JSON.stringify({ success: false, error: "User not found" }), { status: 404 });

  const meId = me.rows[0].id;
  const gameKey = parsed.data.gameKey.trim().toLowerCase();
  const gameId = Number.isFinite(parsed.data.gameId) ? Number(parsed.data.gameId) : null;

  try {
    await sql`
      INSERT INTO user_game_presence (user_id, game_key, game_id, last_seen_at)
      VALUES (${meId}, ${gameKey}, ${gameId}, NOW())
      ON CONFLICT (user_id, game_key)
      DO UPDATE SET last_seen_at = NOW(), game_id = EXCLUDED.game_id
    `;
  } catch (error) {
    const message = String(error?.message || error || "");
    if (!message.toLowerCase().includes("game_id")) throw error;

    await sql`
      INSERT INTO user_game_presence (user_id, game_key, last_seen_at)
      VALUES (${meId}, ${gameKey}, NOW())
      ON CONFLICT (user_id, game_key)
      DO UPDATE SET last_seen_at = NOW()
    `;
  }

  await sql`
    DELETE FROM user_game_presence
    WHERE last_seen_at < NOW() - INTERVAL '20 minutes'
  `;

  return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (error) {
    console.error("[PRESENCE_GAME_ERROR]", error);
    return new Response(JSON.stringify({ success: false, error: "Failed to update presence" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
