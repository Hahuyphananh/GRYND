import bcrypt from "bcrypt";
import { auth } from "@clerk/nextjs/server";
import { getNeonSql } from "../../../../db/neon";
import { parseAndValidateJson } from "../../../../lib/security/validation";
import { auditLog } from "../../../../lib/security/auditLog";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PROFILE_PICTURE_LENGTH = 3_000_000;
export async function POST(request) {
  const sql = getNeonSql();
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
      name: { type: "string", required: false, maxLength: 80, default: null },
      email: { type: "string", required: false, maxLength: 254, default: null },
      password: { type: "string", required: false, maxLength: 128, default: null },
      profilePicture: { type: "string", required: false, maxLength: MAX_PROFILE_PICTURE_LENGTH, default: null },
    });

    if (!parsed.ok) return parsed.response;

    const currentRows = await sql`
        SELECT name, email, profile_picture AS "profilePicture"
        FROM users
        WHERE clerk_id = ${userId}
        LIMIT 1
      `;
    const [currentUser] = currentRows;

    if (!currentUser) {
      return new Response(JSON.stringify({ success: false, error: "User not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const hasName = parsed.data.name !== null && parsed.data.name !== "";
    const hasEmail = parsed.data.email !== null && parsed.data.email !== "";
    const hasPassword = parsed.data.password !== null && parsed.data.password !== "";
    const hasProfilePicture = parsed.data.profilePicture !== null;

    if (!hasName && !hasEmail && !hasPassword && !hasProfilePicture) {
      return new Response(JSON.stringify({ success: false, error: "No profile fields provided" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (parsed.data.name !== null && parsed.data.name !== "" && parsed.data.name.length < 2) {
      return new Response(JSON.stringify({ success: false, error: "name must be at least 2 characters" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (parsed.data.password !== null && parsed.data.password !== "" && parsed.data.password.length < 6) {
      return new Response(JSON.stringify({ success: false, error: "password must be at least 6 characters" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const cleanName = hasName ? parsed.data.name : currentUser.name;
    const cleanEmail = hasEmail ? parsed.data.email : currentUser.email;
    const passwordHash = hasPassword ? await bcrypt.hash(parsed.data.password, 12) : null;
    const profilePicture = hasProfilePicture ? parsed.data.profilePicture : currentUser.profilePicture;

    if (hasEmail && !EMAIL_REGEX.test(cleanEmail)) {
      return new Response(JSON.stringify({ success: false, error: "email has invalid format" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (hasEmail) {
      const existingEmail = await sql`
        SELECT id FROM users WHERE email = ${cleanEmail} AND clerk_id <> ${userId} LIMIT 1
      `;

      if (existingEmail.length) {
        return new Response(JSON.stringify({ success: false, error: "Email already in use" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    const updated = await sql`
      UPDATE users
      SET name = ${cleanName},
          email = ${cleanEmail},
          password = CASE
            WHEN ${Boolean(passwordHash)} THEN ${passwordHash}
            ELSE password
          END,
          profile_picture = ${profilePicture || null}
      WHERE clerk_id = ${userId}
      RETURNING name, email, profile_picture AS "profilePicture"
    `;

    if (!updated.length) {
      return new Response(JSON.stringify({ success: false, error: "User not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    auditLog("profile_updated", {
      userId,
      emailChangedTo: hasEmail ? cleanEmail : undefined,
      passwordUpdated: Boolean(passwordHash),
      profilePictureUpdated: hasProfilePicture,
    });

    return new Response(
      JSON.stringify({
        success: true,
        profile: updated[0],
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
