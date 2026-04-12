import { auth } from "@clerk/nextjs/server";
import { neon } from "@neondatabase/serverless";
import { parseAndValidateJson } from "../../../../lib/security/validation";
import removeAccents from "remove-accents";

const sql = neon(process.env.DATABASE_URL);

export async function POST(request) {
  try {
    const { userId } = await auth();

    if (!userId) {
      return Response.json({
        success: false,
        users: [],
        debug: {
          step: "auth",
          error: "Unauthorized",
        },
      }, { status: 401 });
    }

    const parsed = await parseAndValidateJson(request, {
      name: { type: "string", required: true, minLength: 1, maxLength: 80 },
    });

    if (!parsed.ok) {
      return parsed.response;
    }

    // 🧠 DEBUG 1
    const rawInput = parsed.data.name;

const normalized = removeAccents(
  String(rawInput)
    .toLowerCase()
    .replace(/\s+/g, '') // 🔥 important
    .trim()
);

    let currentUserId = null;

   const current = await sql`
  SELECT id FROM users WHERE clerk_id = ${userId} LIMIT 1
`;

if (current.length > 0) {
  currentUserId = current[0].id;
}

    // 🧠 DEBUG 3
    const queryString = normalized;

const found = await sql`
  SELECT id, name, profile_picture
  FROM users
  WHERE REPLACE(LOWER(search_name), ' ', '') LIKE '%' || ${queryString} || '%'
  ${currentUserId ? sql`AND id != ${currentUserId}` : sql``}
  ORDER BY name ASC
  LIMIT 10
`;

const users = found ?? [];

    // 🚀 EVERYTHING DEBUGGED HERE
    return Response.json({
      success: true,
      users,
      debug: {
        rawInput,
        normalized,
        queryString,
        currentUserId,
        resultCount: users.length,
        results: users, // optional (VERY useful for debugging)
      },
    });

  } catch (error) {
    return Response.json({
      success: false,
      users: [],
      debug: {
        error: error?.message || "Unknown error",
      },
    }, { status: 500 });
  }
}