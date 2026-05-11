import { auth } from "@clerk/nextjs/server";
import { getNeonSql } from "../../../../db/neon";
import { parseAndValidateJson } from "../../../../lib/security/validation";

export async function POST(request) {
  const sql = getNeonSql();
  try {
    const { userId } = await auth();

    if (!userId) {
      return new Response(
        JSON.stringify({ success: false, error: "Unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }

    const parsed = await parseAndValidateJson(request, {
      friendId: { type: "number", required: true },
    });

    if (!parsed.ok) return parsed.response;

    const friendId = Number(parsed.data.friendId);

    // 🔍 Get current user
    const meRes = await sql`
      SELECT id
      FROM users
      WHERE clerk_id = ${userId}
      LIMIT 1
    `;

    if (!meRes.length) {
      return new Response(
        JSON.stringify({ success: false, error: "User not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }

    const meId = Number(meRes[0].id);

    if (meId === friendId) {
      return new Response(
        JSON.stringify({ success: false, error: "Invalid operation" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // 🗑️ Delete BOTH directions
    await sql`
      DELETE FROM friend_relations
      WHERE (user_id = ${meId} AND friend_id = ${friendId})
         OR (user_id = ${friendId} AND friend_id = ${meId})
    `;

    return new Response(
      JSON.stringify({
        success: true,
        message: "Friend removed successfully.",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("[FRIENDS_REMOVE_ERROR]", error);

    return new Response(
      JSON.stringify({
        success: false,
        error: "Could not remove friend right now.",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
