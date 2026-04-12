import { auth } from "@clerk/nextjs/server";
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

export async function GET() {
  try {
    const { userId } = await auth();

    if (!userId) {
      return new Response(
        JSON.stringify({ success: false, error: "Unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    // 👤 Get current user (Neon returns array)
    const current = await sql`
      SELECT id
      FROM users
      WHERE clerk_id = ${userId}
      LIMIT 1
    `;

    if (!current.length) {
      return new Response(
        JSON.stringify({ success: false, error: "User not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    const meId = Number(current[0].id);

    // 👥 Get friends
    const friends = await sql`
      SELECT u.id, u.name, u.profile_picture
      FROM friend_relations fr
      JOIN users u ON u.id = fr.friend_id
      WHERE fr.user_id = ${meId}
      ORDER BY u.name ASC, u.id ASC
    `;

    return new Response(
      JSON.stringify({
        success: true,
        friends, // keep consistent
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );

  } catch (error) {
    console.error("[FRIENDS_LIST_ERROR]", error);

    return new Response(
      JSON.stringify({
        success: false,
        error: "Failed to load friends",
        friends: [],
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}