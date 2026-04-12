import { auth } from "@clerk/nextjs/server";
import { neon } from "@neondatabase/serverless";
import { parseAndValidateJson } from "../../../../lib/security/validation";

const sql = neon(process.env.DATABASE_URL);

export async function POST(request) {
  try {
    const { userId } = await auth();

    if (!userId) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }

    const parsed = await parseAndValidateJson(request, {
      friendId: { type: "number", required: true },
    });

    if (!parsed.ok) return parsed.response;

    const meRes = await sql`SELECT id FROM users WHERE clerk_id = ${userId} LIMIT 1`;
    if (!meRes.rows.length) {
      return new Response(JSON.stringify({ success: false, error: "User not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    }

    const meId = Number(meRes.rows[0].id);
    const friendId = Number(parsed.data.friendId);

    if (meId === friendId) {
      return new Response(JSON.stringify({ success: false, error: "You cannot add yourself" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    const friendRes = await sql`SELECT id, name FROM users WHERE id = ${friendId} LIMIT 1`;
    if (!friendRes.rows.length) {
      return new Response(JSON.stringify({ success: false, error: "Target user not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    }

    await sql`
      INSERT INTO friend_relations (user_id, friend_id)
      VALUES (${meId}, ${friendId}), (${friendId}, ${meId})
      ON CONFLICT (user_id, friend_id) DO NOTHING
    `;

    return new Response(
      JSON.stringify({ success: true, data: [], message: `Added ${friendRes.rows[0].name} to your friends.` }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[FRIENDS_INVITE_ERROR]", error);
    return new Response(JSON.stringify({ success: true, data: [], message: "Could not add friend right now." }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}
