import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";

export async function GET() {
  const { userId } = await auth();

  if (!userId) {
    return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 401 });
  }

  const current = await sql`SELECT id FROM users WHERE clerk_id = ${userId} LIMIT 1`;
  if (!current.rows.length) {
    return new Response(JSON.stringify({ success: false, error: "User not found" }), { status: 404 });
  }

  const meId = current.rows[0].id;

  const rows = await sql`
    SELECT p.game_key, u.id AS friend_id, u.name, u.profile_picture, p.last_seen_at
    FROM friend_relations fr
    JOIN user_game_presence p ON p.user_id = fr.friend_id
    JOIN users u ON u.id = fr.friend_id
    WHERE fr.user_id = ${meId}
      AND p.last_seen_at >= NOW() - INTERVAL '20 minutes'
    ORDER BY p.last_seen_at DESC
  `;

  const byGame = {};
  for (const row of rows.rows) {
    const key = row.game_key;
    if (!byGame[key]) byGame[key] = [];
    byGame[key].push({
      id: row.friend_id,
      name: row.name,
      profilePicture: row.profile_picture,
    });
  }

  return new Response(JSON.stringify({ success: true, byGame }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
