import bcrypt from "bcrypt";
import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";
import { parseAndValidateJson } from "../../../../lib/security/validation";
import { auditLog } from "../../../../lib/security/auditLog";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request) {
  const { userId } = await auth();

  if (!userId) {
    auditLog("profile_update_unauthorized", { path: "/api/profile/update" });
    return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const parsed = await parseAndValidateJson(request, {
      name: { type: "string", required: true, minLength: 2, maxLength: 80 },
      email: { type: "string", required: true, minLength: 5, maxLength: 254, pattern: EMAIL_REGEX },
      password: { type: "string", required: false, minLength: 6, maxLength: 128, default: null },
    });

    if (!parsed.ok) return parsed.response;

    const { name: cleanName, email: cleanEmail, password } = parsed.data;
    const passwordHash = password ? await bcrypt.hash(password, 12) : null;

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
            WHEN ${Boolean(passwordHash)} THEN ${passwordHash}
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

    auditLog("profile_updated", { userId, emailChangedTo: cleanEmail, passwordUpdated: Boolean(passwordHash) });

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
