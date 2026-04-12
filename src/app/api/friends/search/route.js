import { auth } from "@clerk/nextjs/server";
import { neon } from "@neondatabase/serverless";
import { parseAndValidateJson } from "../../../../lib/security/validation";

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

    // normalize search input
    const searchName = String(parsed.data.name)
      .toLowerCase()
      .replace(/\s+/g, "")
      .trim();

    let currentUserId = null;

    const current = await sql`
      SELECT id FROM users WHERE clerk_id = ${userId} LIMIT 1
    `;

    if (current?.rows?.length) {
      currentUserId = current.rows[0].id;
    }

    const found = await sql`
  SELECT id, name, profile_picture
  FROM users
  WHERE LOWER(name) LIKE '%' || ${searchName} || '%'
  ${currentUserId ? sql`AND id != ${currentUserId}` : sql``}
  ORDER BY name ASC
  LIMIT 10
`;
    const users = found?.rows ?? [];

    return Response.json({
      success: true,
      users, // ✅ ALWAYS ARRAY
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