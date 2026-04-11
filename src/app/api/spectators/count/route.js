import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";

export async function GET(request) {
  const { userId } = await auth();
  if (!userId) return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 401 });

  const { searchParams } = new URL(request.url);
  const gameKey = String(searchParams.get("gameKey") || "").toLowerCase();
  const gameId = Number(searchParams.get("gameId"));
  if (!gameKey || !Number.isFinite(gameId)) {
    return new Response(JSON.stringify({ success: false, error: "Missing params" }), { status: 400 });
  }

  const result = await sql`
    SELECT COUNT(DISTINCT spectator_clerk_id) AS count
    FROM spectator_presence
    WHERE target_clerk_id = ${userId}
      AND game_key = ${gameKey}
      AND game_id = ${gameId}
      AND last_seen_at >= NOW() - INTERVAL '20 seconds'
  `;

  return new Response(JSON.stringify({ success: true, count: Number(result.rows[0]?.count || 0) }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
