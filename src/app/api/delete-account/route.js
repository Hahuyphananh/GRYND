import bcrypt from "bcrypt";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { sql } from "../../../db/sql";
import { deleteUserLocalData } from "../../../lib/security/deleteUserData";
import { logError } from "../../../lib/logError";

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

    // Erase the Clerk auth account FIRST. This is the point of no
    // return: once it's gone the user can no longer sign in or access
    // the platform, and the local rows below become unreachable
    // leftovers. Deleting it before the DB also means a transient
    // Clerk API failure aborts cleanly (local rows untouched, user
    // can retry) instead of leaving an orphaned auth account behind
    // after the local row is already gone.
    const client = await clerkClient();
    let clerkDeleted = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await client.users.deleteUser(userId);
        clerkDeleted = true;
        break;
      } catch (err) {
        // A 404 on retry means an earlier attempt actually succeeded
        // server-side (response was lost) — treat it as deleted.
        const status = err?.status ?? err?.response?.status;
        if (status === 404) {
          clerkDeleted = true;
          break;
        }
        console.warn(
          `[DELETE_ACCOUNT] Clerk deleteUser attempt ${attempt} failed`,
          err,
        );
        if (attempt < 3) await new Promise((r) => setTimeout(r, 300));
      }
    }

    if (!clerkDeleted) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Failed to delete account",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    try {
      // Shared purge (same as the user.deleted webhook) — removes the
      // users row (cascading the integer-FK tables) plus the
      // Clerk-id-keyed rows that don't cascade (chat, email events,
      // presence, automation state, login rewards).
      await deleteUserLocalData(userId);
    } catch (dbError) {
      await logError({
        errorType: "account_cleanup_error",
        errorMessage: dbError instanceof Error ? dbError.message : "Local account cleanup failed",
        stackTrace: dbError instanceof Error ? dbError.stack : undefined,
        endpoint: "/api/delete-account",
        metadata: { operation: "delete_local_user_data", userId },
      });
      // Clerk account is already gone; if this fires the local rows
      // are orphaned and must be purged manually.
      console.error(
        "[DELETE_ACCOUNT] Clerk user deleted but local rows remain; purge manually. clerk_id =",
        userId,
        "local id =",
        localUser.id,
        dbError,
      );
      return new Response(
        JSON.stringify({
          success: false,
          error: "Account deleted, but local data cleanup failed",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[DELETE_ACCOUNT_ERROR]", error);
    await logError({
      errorType: "account_deletion_error",
      errorMessage: error instanceof Error ? error.message : "Account deletion failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/delete-account",
      metadata: { operation: "delete_account", userId },
    });
    return new Response(
      JSON.stringify({ success: false, error: "Failed to delete account" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
