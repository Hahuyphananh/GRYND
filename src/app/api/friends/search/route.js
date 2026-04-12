import { auth } from "@clerk/nextjs/server";
import { neon } from "@neondatabase/serverless";
import { parseAndValidateJson } from "../../../../lib/security/validation";
import removeAccents from "remove-accents";

const sql = neon(process.env.DATABASE_URL);

export async function POST(request) {
  try {
    const { userId } = await auth();

    if (!userId) {
      return Response.json(
        { success: false, error: "Unauthorized", users: [] },
        { status: 401 }
      );
    }

    const parsed = await parseAndValidateJson(request, {
      name: { type: "string", required: true, minLength: 1, maxLength: 80 },
    });

    if (!parsed.ok) return parsed.response;

    console.log("🟥 BACKEND RAW INPUT:", parsed.data.name);

    // ✅ FIXED normalization (NOW INSIDE FUNCTION)
    const searchName = removeAccents(
      String(parsed.data.name)
        .toLowerCase()
        .replace(/\s+/g, "")
        .trim()
    );

console.log("🟥 BACKEND NORMALIZED:", searchName);

    let currentUserId = null;

    const current = await sql`
      SELECT id FROM users WHERE clerk_id = ${userId} LIMIT 1
    `;

    if (current?.rows?.length) {
      currentUserId = current.rows[0].id;
    }

    console.log("🟥 FINAL SQL SEARCH VALUE:", searchName);

    const found = await sql`
      SELECT id, name, profile_picture
      FROM users
      WHERE LOWER(REPLACE(unaccent(name), ' ', ''))
            LIKE '%' || ${searchName} || '%'
      ${currentUserId ? sql`AND id != ${currentUserId}` : sql``}
      ORDER BY name ASC
      LIMIT 10
    `;

    console.log("🟥 DB RESULT:", found.rows);
    
    return Response.json({
      success: true,
      users: found?.rows ?? [],
    });

  } catch (error) {
    console.error("[FRIENDS_SEARCH_ERROR]", error);

    return Response.json({
      success: false,
      users: [],
      error: error?.message || "Unknown error",
    }, { status: 500 });
  }
}