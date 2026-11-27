import { auth } from "@clerk/nextjs/server";
import { getNeonSql } from "../../../../db/neon";
import { parseAndValidateJson } from "../../../../lib/security/validation";
import { auditLog } from "../../../../lib/security/auditLog";
import { searchNameFor } from "../../../../lib/searchName";
import { findProfanity } from "../../../../lib/moderation/profanity";

// NOTE: profile pictures are no longer accepted by this endpoint. Grynd
// avatars are OFFICIAL icons only, equipped via /api/user/icon/select.
export async function POST(request) {
  const sql = getNeonSql();
  const { userId } = await auth();

  if (!userId) {
    auditLog("profile_update_unauthorized", { path: "/api/profile/update" });
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized" }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  try {
    const parsed = await parseAndValidateJson(request, {
      name: { type: "string", required: false, maxLength: 80, default: null },
      email: { type: "string", required: false, maxLength: 254, default: null },
      password: {
        type: "string",
        required: false,
        maxLength: 128,
        default: null,
      },
    });

    if (!parsed.ok) return parsed.response;

    const currentRows = await sql`
        SELECT name, email
        FROM users
        WHERE clerk_id = ${userId}
        LIMIT 1
      `;
    const [currentUser] = currentRows;

    if (!currentUser) {
      return new Response(
        JSON.stringify({ success: false, error: "User not found" }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const hasName = parsed.data.name !== null && parsed.data.name !== "";
    const hasEmail = parsed.data.email !== null && parsed.data.email !== "";
    const hasPassword =
      parsed.data.password !== null && parsed.data.password !== "";

    // EMAIL AND PASSWORD ARE NOT WRITABLE HERE.
    //
    // Clerk owns both. Accepting them turned this endpoint into a second,
    // unverified copy of an identity field: an address typed into the form was
    // stored with no proof the caller controls it (a phishing / account-
    // recovery lever), and a "password" was bcrypt-hashed into a column that
    // nothing authenticates against, because sign-in is Clerk's. The two copies
    // could also disagree forever.
    //
    // Email changes happen at the sign-in provider; the `user.updated` Clerk
    // webhook mirrors the primary VERIFIED address back into `users.email`.
    if (hasEmail || hasPassword) {
      auditLog("profile_update_credentials_rejected", {
        userId,
        attemptedEmail: hasEmail,
        attemptedPassword: hasPassword,
      });
      return new Response(
        JSON.stringify({
          success: false,
          error:
            "Email and password are managed by your sign-in account, not here. Change your email there and it is saved once verified.",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (!hasName) {
      return new Response(
        JSON.stringify({ success: false, error: "No profile fields provided" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (
      parsed.data.name !== null &&
      parsed.data.name !== "" &&
      parsed.data.name.length < 2
    ) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "name must be at least 2 characters",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // The display name is public (leaderboard, reviews, profiles), so a rename
    // is the second place a profane name could enter the system. Reject it with
    // a generic message — never echo the matched term back, and don't reveal
    // which substring tripped the filter.
    if (hasName && findProfanity(parsed.data.name) !== null) {
      auditLog("profile_update_rejected_name", { userId });
      return new Response(
        JSON.stringify({
          success: false,
          error: "That display name isn't allowed. Please choose a different one.",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const cleanName = parsed.data.name;

    // `search_name` is the folded match key /api/friends/search reads, derived
    // from the username on every write — `cleanName` is the new name, or the
    // unchanged current one when this request carried no name. Without this a
    // player who renamed could only be found by their OLD username: the column
    // still held the previous name, because nothing else writes it.
    // `name` is the ONLY writable column. Email and password belong to Clerk
    // (see the rejection above), so this statement cannot touch them.
    const updated = await sql`
      UPDATE users
      SET name = ${cleanName},
          search_name = ${searchNameFor(cleanName)}
      WHERE clerk_id = ${userId}
      RETURNING name, email
    `;

    if (!updated.length) {
      return new Response(
        JSON.stringify({ success: false, error: "User not found" }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Never log the display name's value or the email address — audit logs
    // (console + any sink) must not become a second copy of PII.
    auditLog("profile_updated", { userId, nameChanged: true });

    return new Response(
      JSON.stringify({
        success: true,
        profile: updated[0],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("[PROFILE_UPDATE_ERROR]", error);
    return new Response(
      JSON.stringify({ success: false, error: "Failed to update profile" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
