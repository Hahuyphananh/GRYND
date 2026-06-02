import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../../../db";
import { playerReports } from "../../../../../../db/schema";
import { isAdmin } from "../../../../../../lib/auth/isAdmin";
import { adminAuditLog } from "../../../../../../lib/security/adminAuditLog";

export async function POST(req: NextRequest, { params }: { params: Promise<{ reportId: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!(await isAdmin(userId))) return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });

  const { reportId } = await params;
  const id = Number(reportId);
  if (!Number.isInteger(id)) return NextResponse.json({ success: false, error: "Invalid report id" }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const adminNote = String(body?.adminNote || "").trim().slice(0, 1000) || null;

  try {
    const [report] = await db.update(playerReports).set({ status: "dismissed", adminClerkId: userId, adminNote, resolvedAt: new Date() }).where(eq(playerReports.id, id)).returning();
    if (!report) return NextResponse.json({ success: false, error: "Report not found" }, { status: 404 });
    adminAuditLog("player_report_dismiss", { clerkId: userId, targetClerkId: report.reportedClerkId, details: { reportId: id, reason: report.reason, gameKey: report.gameKey, gameId: report.gameId } });
    return NextResponse.json({ success: true, report });
  } catch (err) {
    console.error("[admin/reports/dismiss] Failed:", err);
    return NextResponse.json({ success: false, error: "Failed to dismiss report" }, { status: 500 });
  }
}
