import { auth } from "@clerk/nextjs/server";
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

export async function GET() {
  try {
    const { userId } = await auth();

    if (!userId) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 401 });
    }

    // 🔍 Get current user
    const meRes = await sql`
      SELECT id FROM users WHERE clerk_id = ${userId} LIMIT 1
    `;

    if (!meRes.length) {
      return new Response(JSON.stringify({ success: false, error: "User not found" }), { status: 404 });
    }

    const meId = Number(meRes[0].id);

    // ✅ IMPORTANT: keep LEFT JOIN and REMOVE filtering
    const rows = await sql`
      SELECT
        u.id AS friend_id,
        u.name,
        u.profile_picture,
        p.game_key,
        p.game_id,
        p.last_seen_at
      FROM friend_relations fr
      JOIN users u ON u.id = fr.friend_id
      LEFT JOIN LATERAL (
        SELECT game_key, game_id, last_seen_at
        FROM user_game_presence
        WHERE user_id = fr.friend_id
          AND last_seen_at >= NOW() - INTERVAL '20 minutes'
        ORDER BY last_seen_at DESC
        LIMIT 1
      ) p ON TRUE
      WHERE fr.user_id = ${meId}
      ORDER BY
        p.last_seen_at DESC NULLS LAST,
        u.name ASC
    `;

    const byGame = {};
    const byFriend = {};

    for (const row of rows) {
      const friendPayload = {
        id: row.friend_id,
        name: row.name,
        profilePicture: row.profile_picture,
        gameId: row.game_id || null,
      };

      // 🧠 Only add to byGame if actively playing
      if (row.game_key) {
        if (!byGame[row.game_key]) byGame[row.game_key] = [];
        byGame[row.game_key].push(friendPayload);
      }

      // ✅ Always include friend (even offline)
      byFriend[row.friend_id] = {
        ...friendPayload,
        gameKey: row.game_key || null,
        lastSeenAt: row.last_seen_at || null,
      };
    }

    return new Response(
      JSON.stringify({
        success: true,
        data: rows,
        byGame,
        byFriend,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("[FRIENDS_GAME_PRESENCE_ERROR]", error);

    return new Response(
      JSON.stringify({
        success: false,
        error: "Could not fetch presence",
        data: [],
        byGame: {},
        byFriend: {},
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
