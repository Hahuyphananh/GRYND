// src/app/api/admin/ban-user/route.ts
// PATCH → ban or unban a user by clerkId

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { users } from "../../../../db/schema";
import { isAdmin } from "../../../../lib/auth/isAdmin";
import { adminAuditLog } from "../../../../lib/security/adminAuditLog";

export async function PATCH(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!(await isAdmin(userId))) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ success: false, error: "Invalid request body" }, { status: 400 });
  }

  const { clerkId: targetClerkId, ban } = body as { clerkId: string; ban: boolean };

  if (!targetClerkId || typeof ban !== "boolean") {
    return NextResponse.json(
      { success: false, error: "Missing required fields: clerkId, ban" },
      { status: 400 },
    );
  }

  // Prevent banning yourself
  if (targetClerkId === userId) {
    return NextResponse.json(
      { success: false, error: "You cannot ban yourself" },
      { status: 400 },
    );
  }

  try {
    // Fetch the user first to get their name for audit logging
    const row = await db
      .select({ name: users.name, isBanned: users.isBanned })
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

    await db
      .update(users)
      .set({ isBanned: ban })
      .where(eq(users.clerkId, targetClerkId));

    // Audit log
    adminAuditLog(ban ? "user_banned" : "user_unbanned", {
      clerkId: userId,
      targetClerkId,
      details: {
        targetName: row.name,
        previous: row.isBanned,
        new: ban,
      },
    }).catch(() => {});

    return NextResponse.json({
      success: true,
      clerkId: targetClerkId,
      name: row.name,
      isBanned: ban,
      message: ban ? "User has been banned" : "User has been unbanned",
    });
  } catch (err: any) {
    console.error("[admin/ban-user] Failed:", err);
    return NextResponse.json(
      { success: false, error: "Failed to update user ban status" },
      { status: 500 },
    );
  }
}
