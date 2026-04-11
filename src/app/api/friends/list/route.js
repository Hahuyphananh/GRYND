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

  const friends = await sql`
    SELECT u.id, u.name, u.profile_picture
    FROM friend_relations fr
    JOIN users u ON u.id = fr.friend_id
    WHERE fr.user_id = ${meId}
    ORDER BY u.name ASC, u.id ASC
  `;

  return new Response(JSON.stringify({ success: true, friends: friends.rows }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
