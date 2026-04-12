import { auth } from "@clerk/nextjs/server";
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

export async function GET() {
  try {
    const { userId } = await auth();

    if (!userId) {
      return new Response(
        JSON.stringify({ success: false, error: "Unauthorized" }),
        { status: 401 }
      );
    }

    const meRes = await sql`
      SELECT id FROM users WHERE clerk_id = ${userId} LIMIT 1
    `;

    if (!meRes.rows.length) {
      return new Response(
        JSON.stringify({ success: false, error: "User not found" }),
        { status: 404 }
      );
    }

    const meId = Number(meRes.rows[0].id);

    // ✅ ONLY active presence (INNER JOIN logic)
    const rows = await sql`
      SELECT 
        p.game_key,
        p.game_id,
        p.last_seen_at,
        u.id AS friend_id,
        u.name,
        u.profile_picture
      FROM friend_relations fr
      JOIN user_game_presence p
        ON p.user_id = fr.friend_id
      JOIN users u
        ON u.id = fr.friend_id
      WHERE fr.user_id = ${meId}
        AND p.last_seen_at >= NOW() - INTERVAL '20 minutes'
      ORDER BY p.last_seen_at DESC
    `;

    const byGame = {};
    const byFriend = {};

    for (const row of rows.rows) {
      if (!byGame[row.game_key]) {
        byGame[row.game_key] = [];
      }

      const friendPayload = {
        id: row.friend_id,
        name: row.name,
        profilePicture: row.profile_picture, // ✅ fixed naming
        gameId: row.game_id,
        lastSeenAt: row.last_seen_at,
      };

      byGame[row.game_key].push(friendPayload);

      byFriend[row.friend_id] = {
        ...friendPayload,
        gameKey: row.game_key,
      };
    }

    return new Response(
      JSON.stringify({
        success: true,
        data: rows.rows,
        byGame,
        byFriend,
      }),
      { status: 200 }
    );
  } catch (error) {
    console.error("[FRIENDS_GAME_PRESENCE_ERROR]", error);

    return new Response(
      JSON.stringify({
        success: false,
        error: "Failed to load game presence",
        data: [],
        byGame: {},
        byFriend: {},
      }),
      { status: 500 }
    );
  }
}