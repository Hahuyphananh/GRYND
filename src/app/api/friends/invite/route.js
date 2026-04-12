import { auth } from "@clerk/nextjs/server";
import { neon } from "@neondatabase/serverless";
import { parseAndValidateJson } from "../../../../lib/security/validation";

const sql = neon(process.env.DATABASE_URL);

export async function POST(request) {
  try {
    const { userId } = await auth();

    if (!userId) {
      return new Response(
        JSON.stringify({ success: false, error: "Unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    const parsed = await parseAndValidateJson(request, {
      friendId: { type: "number", required: true },
    });

    if (!parsed.ok) return parsed.response;

    const friendId = Number(parsed.data.friendId);

    // 🔍 Get current user (Neon returns array directly)
    const meRes = await sql`
      SELECT id
      FROM users
      WHERE clerk_id = ${userId}
      LIMIT 1
    `;

    if (!meRes.length) {
      return new Response(
        JSON.stringify({ success: false, error: "User not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    const meId = Number(meRes[0].id);

    // 🚫 Prevent self-friend
    if (meId === friendId) {
      return new Response(
        JSON.stringify({ success: false, error: "You cannot add yourself" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // 🔍 Check target user exists
    const friendRes = await sql`
      SELECT id, name
      FROM users
      WHERE id = ${friendId}
      LIMIT 1
    `;

    if (!friendRes.length) {
      return new Response(
        JSON.stringify({ success: false, error: "Target user not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // 🤝 Insert friendship (bidirectional)
    await sql`
      INSERT INTO friend_relations (user_id, friend_id)
      VALUES
        (${meId}, ${friendId}),
        (${friendId}, ${meId})
      ON CONFLICT (user_id, friend_id) DO NOTHING
    `;

    return new Response(
      JSON.stringify({
        success: true,
        message: `Added ${friendRes[0].name} to your friends.`,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("[FRIENDS_INVITE_ERROR]", error);

    return new Response(
      JSON.stringify({
        success: false,
        error: "Could not add friend right now.",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}