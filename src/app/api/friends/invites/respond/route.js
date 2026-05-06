import { auth } from "@clerk/nextjs/server";
import { getNeonSql } from "../../../../../db/neon";
import { parseAndValidateJson } from "../../../../../lib/security/validation";

export async function POST(request) {
  const sql = getNeonSql();
  try {
    const { userId } = await auth();

    if (!userId) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const parsed = await parseAndValidateJson(request, {
      inviteId: { type: "number", required: true },
      action: { type: "string", required: true },
    });

    if (!parsed.ok) return parsed.response;

    const inviteId = Number(parsed.data.inviteId);
    const action = String(parsed.data.action || "").toLowerCase();

    if (action !== "accept" && action !== "decline") {
      return new Response(JSON.stringify({ success: false, error: "Invalid action" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const meRes = await sql`
      SELECT id
      FROM users
      WHERE clerk_id = ${userId}
      LIMIT 1
    `;

    if (!meRes.length) {
      return new Response(JSON.stringify({ success: false, error: "User not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const meId = Number(meRes[0].id);

    const inviteRows = await sql`
      SELECT id, sender_id, receiver_id, status
      FROM friend_invites
      WHERE id = ${inviteId}
      LIMIT 1
    `;

    if (!inviteRows.length) {
      return new Response(JSON.stringify({ success: false, error: "Invite not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const invite = inviteRows[0];

    if (Number(invite.receiver_id) !== meId) {
      return new Response(JSON.stringify({ success: false, error: "Forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (invite.status !== "pending") {
      return new Response(JSON.stringify({ success: false, error: "Invite already handled" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const senderId = Number(invite.sender_id);

    if (action === "accept") {
      await sql`
        INSERT INTO friend_relations (user_id, friend_id)
        VALUES
          (${meId}, ${senderId}),
          (${senderId}, ${meId})
        ON CONFLICT (user_id, friend_id) DO NOTHING
      `;
    }

    await sql`
      UPDATE friend_invites
      SET status = ${action === "accept" ? "accepted" : "declined"},
          updated_at = NOW()
      WHERE id = ${inviteId}
    `;

    return new Response(
      JSON.stringify({
        success: true,
        message: action === "accept" ? "Friend invite accepted." : "Friend invite declined.",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("[FRIEND_INVITE_RESPOND_ERROR]", error);

    return new Response(JSON.stringify({ success: false, error: "Failed to respond to invite" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
