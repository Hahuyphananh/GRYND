// src/app/api/admin/reports/route.ts
// GET → fetch all player reports for the admin dashboard
// PATCH → resolve a report (mark as reviewed/resolved/dismissed)

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { isAdmin } from "../../../../lib/auth/isAdmin";
import { getNeonSql } from "../../../../db/neon";

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!(await isAdmin(userId))) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  const statusFilter = req.nextUrl.searchParams.get("status") || "";
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") || "100", 10), 200);

  try {
    const sql = getNeonSql();

    let reports;
    if (statusFilter === "pending") {
      reports = await sql`
        SELECT pr.*, 
               ru.name AS reporter_name, 
               ru.email AS reporter_email,
               rdu.name AS reported_name,
               rdu.email AS reported_email,
               rdu.is_banned AS reported_is_banned
        FROM player_reports pr
        LEFT JOIN users ru ON ru.clerk_id = pr.reporter_clerk_id
        LEFT JOIN users rdu ON rdu.clerk_id = pr.reported_clerk_id
        WHERE pr.status = 'pending'
        ORDER BY pr.created_at DESC
        LIMIT ${limit}
      `;
    } else {
      reports = await sql`
        SELECT pr.*, 
               ru.name AS reporter_name, 
               ru.email AS reporter_email,
               rdu.name AS reported_name,
               rdu.email AS reported_email,
               rdu.is_banned AS reported_is_banned
        FROM player_reports pr
        LEFT JOIN users ru ON ru.clerk_id = pr.reporter_clerk_id
        LEFT JOIN users rdu ON rdu.clerk_id = pr.reported_clerk_id
        ORDER BY pr.created_at DESC
        LIMIT ${limit}
      `;
    }

    return NextResponse.json({ success: true, reports });
  } catch (err: any) {
    console.error("[admin/reports] Failed:", err);
    return NextResponse.json(
      { success: false, error: "Failed to fetch reports" },
      { status: 500 },
    );
  }
}

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

  const { reportId, status } = body as { reportId: number; status: string };

  if (!reportId || !status) {
    return NextResponse.json(
      { success: false, error: "Missing required fields: reportId, status" },
      { status: 400 },
    );
  }

  const validStatuses = ["reviewed", "resolved", "dismissed"];
  if (!validStatuses.includes(status)) {
    return NextResponse.json(
      { success: false, error: "Invalid status. Must be one of: " + validStatuses.join(", ") },
      { status: 400 },
    );
  }

  try {
    const sql = getNeonSql();

    await sql`
      UPDATE player_reports
      SET status = ${status},
          resolved_at = NOW(),
          resolved_by_clerk_id = ${userId}
      WHERE id = ${reportId}
    `;

    return NextResponse.json({ success: true, message: "Report updated successfully" });
  } catch (err: any) {
    console.error("[admin/reports] PATCH failed:", err);
    return NextResponse.json(
      { success: false, error: "Failed to update report" },
      { status: 500 },
    );
  }
}
