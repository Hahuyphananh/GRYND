import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { users, adminAuditLogs } from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { isAdmin } from "../../../../lib/auth/isAdmin";

export async function PATCH(req: NextRequest) {
  const { userId: adminId } = await auth();
  if (!adminId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!(await isAdmin(adminId))) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const { clerkId, balance } = body;

  if (!clerkId || typeof balance !== "number" || balance < 0 || !Number.isFinite(balance)) {
    return NextResponse.json(
      { success: false, error: "Invalid request. Provide clerkId and a valid non-negative balance." },
      { status: 400 },
    );
  }

  try {
    const [targetUser] = await db
      .select({ id: users.id, clerkId: users.clerkId, name: users.name })
      .from(users)
      .where(eq(users.clerkId, String(clerkId)))
      .limit(1);

    if (!targetUser) {
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 404 },
      );
    }

    // Update balance
    await db
      .update(users)
      .set({ balance: String(balance) })
      .where(eq(users.clerkId, String(clerkId)));

    // Audit log
    await db.insert(adminAuditLogs).values({
      event: "admin_reset_tokens",
      clerkId: adminId,
      targetClerkId: String(clerkId),
      details: {
        targetName: targetUser.name,
        previousBalance: null,
        newBalance: balance,
        reason: "Admin reset",
      },
    });

    return NextResponse.json({
      success: true,
      data: {
        clerkId: String(clerkId),
        name: targetUser.name,
        newBalance: balance,
      },
    });
  } catch (error: any) {
    console.error("[admin/reset-tokens] Error:", error);
    return NextResponse.json(
      { success: false, error: error?.message || "Server error" },
      { status: 500 },
    );
  }
}
