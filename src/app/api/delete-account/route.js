import bcrypt from "bcrypt";
import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";

export async function POST(request) {
  const { userId } = await auth();

  if (!userId) {
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized" }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  try {
    const { password } = await request.json();
    if (!password) {
      return new Response(
        JSON.stringify({ success: false, error: "Password is required" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const userResult = await sql`
      SELECT id, password FROM users WHERE clerk_id = ${userId} LIMIT 1
    `;

    const localUser = userResult.rows[0];
    if (!localUser) {
      return new Response(
        JSON.stringify({ success: false, error: "User not found" }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const storedPassword = String(localUser.password || "");
    const providedPassword = String(password);

    const isBcryptHash =
      storedPassword.startsWith("$2a$") ||
      storedPassword.startsWith("$2b$") ||
      storedPassword.startsWith("$2y$");
    const passwordMatches = isBcryptHash
      ? await bcrypt.compare(providedPassword, storedPassword)
      : storedPassword === providedPassword;

    if (!passwordMatches) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Password confirmation failed",
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    await sql.begin(async (tx) => {
      await tx`DELETE FROM user_login_rewards WHERE user_id = ${localUser.id}`;
      await tx`DELETE FROM users WHERE id = ${localUser.id}`;
    });

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[DELETE_ACCOUNT_ERROR]", error);
    return new Response(
      JSON.stringify({ success: false, error: "Failed to delete account" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
