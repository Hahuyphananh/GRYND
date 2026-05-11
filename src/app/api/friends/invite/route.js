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
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const parsed = await parseAndValidateJson(request, {
      friendId: { type: "number", required: true },
    });

    if (!parsed.ok) return parsed.response;

    const friendId = Number(parsed.data.friendId);

    const meRes = await sql`
      SELECT id
      FROM users
      WHERE clerk_id = ${userId}
      LIMIT 1
    `;

    if (!meRes.length) {
      return new Response(
        JSON.stringify({ success: false, error: "User not found" }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const meId = Number(meRes[0].id);

    if (meId === friendId) {
      return new Response(
        JSON.stringify({ success: false, error: "You cannot add yourself" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const friendRes = await sql`
      SELECT id, name
      FROM users
      WHERE id = ${friendId}
      LIMIT 1
    `;

    if (!friendRes.length) {
      return new Response(
        JSON.stringify({ success: false, error: "Target user not found" }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const existingFriendship = await sql`
      SELECT 1
      FROM friend_relations
      WHERE user_id = ${meId}
        AND friend_id = ${friendId}
      LIMIT 1
    `;

    if (existingFriendship.length) {
      return new Response(
        JSON.stringify({ success: false, error: "You are already friends" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const reverseInvite = await sql`
      SELECT id
      FROM friend_invites
      WHERE sender_id = ${friendId}
        AND receiver_id = ${meId}
        AND status = 'pending'
      LIMIT 1
    `;

    if (reverseInvite.length) {
      return new Response(
        JSON.stringify({
          success: false,
          error:
            "This user already invited you. Accept it from your invites tab.",
        }),
        {
          status: 409,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const existingInvite = await sql`
      SELECT id
      FROM friend_invites
      WHERE sender_id = ${meId}
        AND receiver_id = ${friendId}
        AND status = 'pending'
      LIMIT 1
    `;

    if (!existingInvite.length) {
      await sql`
        INSERT INTO friend_invites (sender_id, receiver_id, status, created_at, updated_at)
        VALUES (${meId}, ${friendId}, 'pending', NOW(), NOW())
      `;
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Invite sent to ${friendRes[0].name}.`,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("[FRIENDS_INVITE_ERROR]", error);

    return new Response(
      JSON.stringify({
        success: false,
        error: "Could not send friend invite right now.",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
