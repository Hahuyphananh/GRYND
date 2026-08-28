import { NextRequest, NextResponse } from "next/server";
import { claimQuickQueueAssignment } from "../../../../lib/quickQueueWorker";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (process.env.QUICK_QUEUE_ENABLED !== "1") {
    return NextResponse.json({ success: false, error: "Quick Queue is disabled" }, { status: 404 });
  }
  const secret = process.env.REALTIME_INTERNAL_SECRET;
  if (secret && req.headers.get("x-internal-secret") !== secret) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const assignment = await claimQuickQueueAssignment();
    return NextResponse.json({ success: true, assignment, launched: false });
  } catch (error) {
    console.error("[quick-queue/assign] error:", error);
    return NextResponse.json({ success: false, error: "Assignment failed" }, { status: 500 });
  }
}
