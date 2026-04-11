import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";
import { parseAndValidateJson } from "../../../../lib/security/validation";

export async function POST(request) {
  try {
    const { userId } = await auth();

    if (!userId) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }

    const parsed = await parseAndValidateJson(request, {
      name: { type: "string", required: true, minLength: 1, maxLength: 80 },
    });

    if (!parsed.ok) return parsed.response;

    const current = await sql`SELECT id FROM users WHERE clerk_id = ${userId} LIMIT 1`;
    if (!current.rows.length) {
      return new Response(JSON.stringify({ success: false, error: "User not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    }

    const currentUserId = Number(current.rows[0].id);
    const searchName = parsed.data.name.trim();

    const found = await sql`
      SELECT id, name, profile_picture
      FROM users
      WHERE LOWER(name) LIKE LOWER(${`%${searchName}%`})
        AND id != ${currentUserId}
      ORDER BY name ASC, id ASC
      LIMIT 10
    `;

    return new Response(JSON.stringify({ success: true, data: found.rows, users: found.rows }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[FRIENDS_SEARCH_ERROR]", error);
    return new Response(JSON.stringify({ success: true, data: [], users: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}
