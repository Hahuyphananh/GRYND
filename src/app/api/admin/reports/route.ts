import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "../../../../db";
import { playerReports, users } from "../../../../db/schema";
import { isAdmin } from "../../../../lib/auth/isAdmin";

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!(await isAdmin(userId))) return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });

  const status = req.nextUrl.searchParams.get("status");
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") || "50", 10), 100);

  try {
    const rows = status && status !== "all"
      ? await db.select().from(playerReports).where(eq(playerReports.status, status as any)).orderBy(desc(playerReports.createdAt)).limit(limit)
      : await db.select().from(playerReports).orderBy(desc(playerReports.createdAt)).limit(limit);
    const clerkIds = Array.from(new Set(rows.flatMap((report) => [report.reporterClerkId, report.reportedClerkId])));
    const userRows = clerkIds.length
      ? await db.select({ clerkId: users.clerkId, name: users.name, email: users.email, profilePicture: users.profilePicture, isBanned: users.isBanned }).from(users).where(inArray(users.clerkId, clerkIds))
      : [];
    const usersByClerkId = new Map(userRows.map((u) => [u.clerkId, u]));
    return NextResponse.json({
      success: true,
      reports: rows.map((report) => ({
        ...report,
        reporter: usersByClerkId.get(report.reporterClerkId) || null,
        reported: usersByClerkId.get(report.reportedClerkId) || null,
      })),
    });
  } catch (err) {
    console.error("[admin/reports] Fetch failed:", err);
    return NextResponse.json({ success: false, error: "Failed to fetch reports" }, { status: 500 });
  }
}
