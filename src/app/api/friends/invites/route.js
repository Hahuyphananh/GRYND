import { auth } from "@clerk/nextjs/server";
import { getNeonSql } from "../../../../db/neon";

export async function GET() {
  const sql = getNeonSql();
  try {
    const { userId } = await auth();

    if (!userId) {
      return new Response(
        JSON.stringify({ success: false, error: "Unauthorized", invites: [] }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const current = await sql`
      SELECT id
      FROM users
      WHERE clerk_id = ${userId}
      LIMIT 1
    `;

    if (!current.length) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "User not found",
          invites: [],
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const meId = Number(current[0].id);

    const invites = await sql`
      SELECT fi.id, fi.created_at, u.id AS sender_id, u.name AS sender_name, u.selected_icon AS sender_icon_key
      FROM friend_invites fi
      JOIN users u ON u.id = fi.sender_id
      WHERE fi.receiver_id = ${meId}
        AND fi.status = 'pending'
      ORDER BY fi.created_at DESC
    `;

    return new Response(JSON.stringify({ success: true, invites }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[FRIENDS_INVITES_LIST_ERROR]", error);

    return new Response(
      JSON.stringify({
        success: false,
        error: "Failed to load invites",
        invites: [],
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
