// src/app/api/admin/users/[clerkId]/admin/route.ts
// PATCH  → toggle is_admin for the given clerkId
// Must be an admin to use this endpoint.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../../../db";
import { users } from "../../../../../../db/schema";
import { isAdmin } from "../../../../../../lib/auth/isAdmin";
import { adminAuditLog } from "../../../../../../lib/security/adminAuditLog";

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ clerkId: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!(await isAdmin(userId))) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  const { clerkId: targetClerkId } = await context.params;

  // Parse optional body for explicit set/unset
  let setExplicitly: boolean | null = null;
  try {
    const body = await req.json();
    if (typeof body?.isAdmin === "boolean") {
      setExplicitly = body.isAdmin;
    }
  } catch {
    // No body — toggle
  }

  try {
    // Fetch current state
    const row = await db
      .select({ isAdmin: users.isAdmin, name: users.name })
      .from(users)
      .where(eq(users.clerkId, targetClerkId))
      .limit(1)
      .then((rows) => rows[0]);

    if (!row) {
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 404 },
      );
    }

    const newValue = setExplicitly ?? !row.isAdmin;

    await db
      .update(users)
      .set({ isAdmin: newValue })
      .where(eq(users.clerkId, targetClerkId));

    // Persist to admin_audit_logs table + console
    adminAuditLog("admin_toggle", {
      clerkId: userId,
      targetClerkId,
      details: {
        targetName: row.name,
        previous: row.isAdmin,
        new: newValue,
      },
    }).catch(() => {
      // audit failure should not break the toggle flow
    });

    return NextResponse.json({
      success: true,
      clerkId: targetClerkId,
      name: row.name,
      isAdmin: newValue,
    });
  } catch (err: any) {
    console.error("[admin/users/toggle] Failed:", err);
    return NextResponse.json(
      { success: false, error: "Failed to toggle admin status" },
      { status: 500 },
    );
  }
}
