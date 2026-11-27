// GET /api/admin/analytics?days=7|30|90
//
// Admin-only read of Solitaire event volumes from PostHog's Query API. The
// personal API key stays on the server; the browser only ever receives the
// aggregated counts the dashboard renders.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { isAdmin } from "../../../../lib/auth/isAdmin";
import { loadAnalyticsSnapshot, parseRange } from "../../../../lib/analytics/solitaireDashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!(await isAdmin(userId))) {
    return NextResponse.json(
      { success: false, error: "Forbidden. Admin access required" },
      { status: 403 },
    );
  }

  const range = parseRange(new URL(req.url).searchParams.get("days"));
  const snapshot = await loadAnalyticsSnapshot(range);

  return NextResponse.json(
    { success: true, ...snapshot },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
