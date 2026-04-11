import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";
import { parseAndValidateJson } from "../../../../lib/security/validation";

export async function POST(request) {
  try {
    const { userId } = await auth();

    if (!userId) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const parsed = await parseAndValidateJson(request, {
      name: { type: "string", required: true, minLength: 1, maxLength: 80 },
    });

    if (!parsed.ok) return parsed.response;

    const current = await sql`
      SELECT id FROM users WHERE clerk_id = ${userId} LIMIT 1
    `;

    if (!current.rows.length) {
      return new Response(JSON.stringify({ success: false, error: "User not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const currentUserId = Number(current.rows[0].id);

    // 🔥 Normalize input (collapse spaces)
    const searchName = parsed.data.name
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();

    console.log("SEARCH NORMALIZED:", `"${searchName}"`);

    const found = await sql`
      SELECT id, name, profile_picture
      FROM users
      WHERE 
        REGEXP_REPLACE(LOWER(name), '\s+', ' ', 'g')
        LIKE '%' || ${searchName} || '%'
        AND id != ${currentUserId}
      ORDER BY name ASC
      LIMIT 10
    `;

    console.log("FOUND USERS:", found.rows);

    return new Response(
      JSON.stringify({
        success: true,
        users: found.rows, // ✅ cleaner response
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("[FRIENDS_SEARCH_ERROR]", error);

    // 🔥 NEVER crash search
    return new Response(
      JSON.stringify({
        success: true,
        users: [],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}