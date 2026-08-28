import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getQuickQueueAssignmentForUser } from "../../../../lib/quickQueueStore";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (process.env.QUICK_QUEUE_ENABLED !== "1") {
    return NextResponse.json({ success: false, error: "Quick Queue is disabled" }, { status: 404 });
  }

  try {
    const assignmentId = req.nextUrl.searchParams.get("assignmentId") ?? undefined;
    const assignment = await getQuickQueueAssignmentForUser(userId, assignmentId);
    return NextResponse.json({
      success: true,
      assignment,
      ready: Boolean(assignment && assignment.status === "ready"),
      launched: false,
    });
  } catch (error) {
    console.error("[quick-queue/status] error:", error);
    return NextResponse.json({ success: false, error: "Unable to load assignment" }, { status: 500 });
  }
}
