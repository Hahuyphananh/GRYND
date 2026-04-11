import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";
import { parseAndValidateJson } from "../../../../lib/security/validation";

export async function POST(request) {
  const { userId } = await auth();

  if (!userId) {
    return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 401 });
  }

  const parsed = await parseAndValidateJson(request, {
    friendId: { type: "number", required: true },
  });

  if (!parsed.ok) return parsed.response;

  const meRes = await sql`SELECT id FROM users WHERE clerk_id = ${userId} LIMIT 1`;
  if (!meRes.rows.length) {
    return new Response(JSON.stringify({ success: false, error: "User not found" }), { status: 404 });
  }

  const meId = Number(meRes.rows[0].id);
  const friendId = Number(parsed.data.friendId);

  if (meId === friendId) {
    return new Response(JSON.stringify({ success: false, error: "You cannot add yourself" }), { status: 400 });
  }

  const friendRes = await sql`SELECT id, name FROM users WHERE id = ${friendId} LIMIT 1`;
  if (!friendRes.rows.length) {
    return new Response(JSON.stringify({ success: false, error: "Target user not found" }), { status: 404 });
  }

  await sql`INSERT INTO friend_relations (user_id, friend_id) VALUES (${meId}, ${friendId}) ON CONFLICT (user_id, friend_id) DO NOTHING`;
  await sql`INSERT INTO friend_relations (user_id, friend_id) VALUES (${friendId}, ${meId}) ON CONFLICT (user_id, friend_id) DO NOTHING`;

  return new Response(
    JSON.stringify({ success: true, message: `Invite sent to ${friendRes.rows[0].name}. You are now friends.` }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
