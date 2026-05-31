// src/app/api/admin/audit-logs/route.ts
// GET  ?limit=50  → fetch recent admin audit log entries
// Must be an admin to use this endpoint.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { desc } from "drizzle-orm";
import { db } from "../../../../db";
import { adminAuditLogs } from "../../../../db/schema";
import { isAdmin } from "../../../../lib/auth/isAdmin";

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!(await isAdmin(userId))) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  const limit = Math.min(
    parseInt(req.nextUrl.searchParams.get("limit") || "50", 10),
    200,
  );

  try {
    const rows = await db
      .select({
        id: adminAuditLogs.id,
        event: adminAuditLogs.event,
        clerkId: adminAuditLogs.clerkId,
        targetClerkId: adminAuditLogs.targetClerkId,
        details: adminAuditLogs.details,
        createdAt: adminAuditLogs.createdAt,
      })
      .from(adminAuditLogs)
      .orderBy(desc(adminAuditLogs.createdAt))
      .limit(limit);

    return NextResponse.json({ success: true, logs: rows });
  } catch (err: any) {
    console.error("[admin/audit-logs] Fetch failed:", err);
    return NextResponse.json(
      { success: false, error: "Failed to fetch audit logs" },
      { status: 500 },
    );
  }
}
