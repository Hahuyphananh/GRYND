import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";

export async function POST(request) {
  const { userId } = await auth();

  if (!userId) {
    return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const { name, email, password } = await request.json();

    const cleanName = String(name || "").trim();
    const cleanEmail = String(email || "").trim();

    if (!cleanName || !cleanEmail) {
      return new Response(JSON.stringify({ success: false, error: "Name and email are required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (password && String(password).length < 6) {
      return new Response(JSON.stringify({ success: false, error: "Password must be at least 6 characters" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const existingEmail = await sql`
      SELECT id FROM users WHERE email = ${cleanEmail} AND clerk_id <> ${userId} LIMIT 1
    `;

    if (existingEmail.rows.length) {
      return new Response(JSON.stringify({ success: false, error: "Email already in use" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }

    const updated = await sql`
      UPDATE users
      SET name = ${cleanName},
          email = ${cleanEmail},
          password = CASE
            WHEN ${password ? true : false} THEN ${password}
            ELSE password
          END
      WHERE clerk_id = ${userId}
      RETURNING name, email
    `;

    if (!updated.rows.length) {
      return new Response(JSON.stringify({ success: false, error: "User not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        profile: updated.rows[0],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("[PROFILE_UPDATE_ERROR]", error);
    return new Response(JSON.stringify({ success: false, error: "Failed to update profile" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
