import { auth } from "@clerk/nextjs/server";
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

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

    const meId = Number(current.rows[0].id);

    const friends = await sql`
      SELECT u.id, u.name, u.profile_picture
      FROM friend_relations fr
      JOIN users u ON u.id = fr.friend_id
      WHERE fr.user_id = ${meId}
      ORDER BY u.name ASC, u.id ASC
    `;

    return new Response(JSON.stringify({ success: true, data: friends.rows, friends: friends.rows }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[FRIENDS_LIST_ERROR]", error);
    return new Response(JSON.stringify({ success: true, data: [], friends: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}
