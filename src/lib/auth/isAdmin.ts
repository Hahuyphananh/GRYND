// src/lib/auth/isAdmin.ts
// Shared server-side admin check that reads from the users table.
// Replaces the CHAT_ADMIN_CLERK_IDS env var approach with DB-backed roles.

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { users } from "../../db/schema";

/**
 * Check whether a Clerk user has admin privileges.
 * Queries the `users` table by clerkId and returns `is_admin`.
 * Falls back to CHAT_ADMIN_CLERK_IDS env var for backwards compatibility
 * (in case the is_admin column hasn't been populated yet on someone's DB).
 */
export async function isAdmin(clerkId: string): Promise<boolean> {
  // 1. DB check — primary source of truth
  try {
    const row = await db
      .select({ isAdmin: users.isAdmin })
      .from(users)
      .where(eq(users.clerkId, clerkId))
      .limit(1)
      .then((rows) => rows[0]);

    if (row?.isAdmin === true) return true;
  } catch (err) {
    // DB might not have the column yet (migration not run) —
    // fall through to env var fallback without crashing.
    console.warn("[isAdmin] DB lookup failed, falling back to env var:", (err as Error).message);
  }

  // 2. Env var fallback — backwards compatibility
  const envAdmins = (process.env.CHAT_ADMIN_CLERK_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  return envAdmins.includes(clerkId);
}
