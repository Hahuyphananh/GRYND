import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";
import { parseAndValidateJson } from "../../../../lib/security/validation";

export async function POST(request) {
  try {
    const { userId } = await auth();

console.log("CLERK USER ID:", userId);

const debugUsers = await sql`
  SELECT clerk_id FROM users LIMIT 5
`;

console.log("DB CLERK IDS:", debugUsers.rows);

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

   let currentUserId = null;

const current = await sql`
  SELECT id FROM users 
  WHERE TRIM(clerk_id) = TRIM(${userId})
  LIMIT 1
`;

if (current.rows.length) {
  currentUserId = Number(current.rows[0].id);
} else {
  console.warn("⚠️ Clerk user not found in DB, continuing search anyway");
}

    // 🔥 Normalize input (collapse spaces)
    const searchName = parsed.data.name
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();

    console.log("SEARCH NORMALIZED:", `"${searchName}"`);

 const found = await sql`
  SELECT id, name, profile_picture
  FROM users
  WHERE REPLACE(LOWER(name), ' ', '') 
        LIKE '%' || ${searchName.replace(/\s+/g, "")} || '%'
  ${currentUserId ? sql`AND id != ${currentUserId}` : sql``}
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
    users: found.rows,
    debug: {
      clerkUserId: userId,
      dbClerkIds: debugUsers.rows,
    },
  }),
  {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }
);
  }
}