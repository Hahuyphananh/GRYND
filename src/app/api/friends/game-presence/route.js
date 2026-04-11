import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";

export async function GET() {
  try {
    const { userId } = await auth();

    if (!userId) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 401 });
    }

    const current = await sql`SELECT id FROM users WHERE clerk_id = ${userId} LIMIT 1`;
    if (!current.rows.length) {
      return new Response(JSON.stringify({ success: false, error: "User not found" }), { status: 404 });
    }

    const meId = current.rows[0].id;
    let rows;
    try {
      rows = await sql`
        SELECT p.game_key, p.game_id, u.id AS friend_id, u.name, u.profile_picture, p.last_seen_at
        FROM friend_relations fr
        JOIN user_game_presence p ON p.user_id = fr.friend_id
        JOIN users u ON u.id = fr.friend_id
        WHERE fr.user_id = ${meId}
          AND p.last_seen_at >= NOW() - INTERVAL '20 minutes'
        ORDER BY p.last_seen_at DESC
      `;
    } catch (error) {
      const code = String(error?.code || "");
      const message = String(error?.message || error || "").toLowerCase();
      const missingFriendsOrPresenceTable =
        code === "42P01" || message.includes("friend_relations") || message.includes("user_game_presence");
      const missingGameIdColumn = code === "42703" && message.includes("game_id");
      const missingProfilePictureColumn = code === "42703" && message.includes("profile_picture");

      if (missingFriendsOrPresenceTable) {
        return new Response(JSON.stringify({ success: true, byGame: {}, byFriend: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (missingGameIdColumn && missingProfilePictureColumn) {
        rows = await sql`
          SELECT p.game_key, NULL::integer AS game_id, u.id AS friend_id, u.name, NULL::text AS profile_picture, p.last_seen_at
          FROM friend_relations fr
          JOIN user_game_presence p ON p.user_id = fr.friend_id
          JOIN users u ON u.id = fr.friend_id
          WHERE fr.user_id = ${meId}
            AND p.last_seen_at >= NOW() - INTERVAL '20 minutes'
          ORDER BY p.last_seen_at DESC
        `;
      } else if (missingGameIdColumn) {
        rows = await sql`
          SELECT p.game_key, NULL::integer AS game_id, u.id AS friend_id, u.name, u.profile_picture, p.last_seen_at
          FROM friend_relations fr
          JOIN user_game_presence p ON p.user_id = fr.friend_id
          JOIN users u ON u.id = fr.friend_id
          WHERE fr.user_id = ${meId}
            AND p.last_seen_at >= NOW() - INTERVAL '20 minutes'
          ORDER BY p.last_seen_at DESC
        `;
      } else if (missingProfilePictureColumn) {
        rows = await sql`
          SELECT p.game_key, p.game_id, u.id AS friend_id, u.name, NULL::text AS profile_picture, p.last_seen_at
          FROM friend_relations fr
          JOIN user_game_presence p ON p.user_id = fr.friend_id
          JOIN users u ON u.id = fr.friend_id
          WHERE fr.user_id = ${meId}
            AND p.last_seen_at >= NOW() - INTERVAL '20 minutes'
          ORDER BY p.last_seen_at DESC
        `;
      } else {
        throw error;
      }
    }


    const byGame = {};
    const byFriend = {};
    for (const row of rows.rows) {
      const key = row.game_key;
      if (!byGame[key]) byGame[key] = [];
      const friendPayload = {
        id: row.friend_id,
        name: row.name,
        profilePicture: row.profile_picture,
        gameId: row.game_id,
      };
      byGame[key].push(friendPayload);
      byFriend[row.friend_id] = { ...friendPayload, gameKey: row.game_key };
    }

    return new Response(JSON.stringify({ success: true, byGame, byFriend }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[FRIENDS_GAME_PRESENCE_FATAL]", error);
    return new Response(JSON.stringify({ success: false, error: "Failed to load friend presence" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
