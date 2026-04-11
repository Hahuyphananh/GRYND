import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";

export async function GET() {
  try {
    const { userId } = await auth();

    if (!userId) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }

    const current = await sql`SELECT id FROM users WHERE clerk_id = ${userId} LIMIT 1`;
    if (!current.rows.length) {
      return new Response(JSON.stringify({ success: false, error: "User not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    }

    const meId = current.rows[0].id;

    let friends;
    try {
      friends = await sql`
        SELECT u.id, u.name, u.profile_picture
        FROM friend_relations fr
        JOIN users u ON u.id = fr.friend_id
        WHERE fr.user_id = ${meId}
        ORDER BY u.name ASC, u.id ASC
      `;
    } catch (error) {
      const code = String(error?.code || "");
      const message = String(error?.message || error || "").toLowerCase();
      const missingFriendsTable = code === "42P01" || message.includes("friend_relations");
      const missingProfilePictureColumn = code === "42703" && message.includes("profile_picture");

      if (missingFriendsTable) {
        return new Response(JSON.stringify({ success: true, friends: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (missingProfilePictureColumn) {
        friends = await sql`
          SELECT u.id, u.name, NULL::text AS profile_picture
          FROM friend_relations fr
          JOIN users u ON u.id = fr.friend_id
          WHERE fr.user_id = ${meId}
          ORDER BY u.name ASC, u.id ASC
        `;
      } else {
        throw error;
      }
    }

    return new Response(JSON.stringify({ success: true, friends: friends.rows }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error('[FRIENDS_LIST_ERROR]', error);
    return new Response(JSON.stringify({ success: false, error: 'Failed to load friends' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
