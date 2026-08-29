import { NextRequest, NextResponse } from "next/server";
import { db } from "../../../../db";
import { quickQueueRequests } from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { publishQuickQueueAssignmentEvents } from "../../../../lib/quickQueueAssignmentEvents";

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
    const baseUrl = String(process.env.REALTIME_INTERNAL_URL || "").replace(/\/$/, "");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (secret) headers["x-internal-secret"] = secret;
    const result = await publishQuickQueueAssignmentEvents(async (event) => {
      if (!baseUrl) return;
      const requests = await db
        .select({ userId: quickQueueRequests.userId })
        .from(quickQueueRequests)
        .where(eq(quickQueueRequests.id, event.requestIds[0]));
      const userIds = new Set(requests.map((row) => row.userId));
      for (const requestId of event.requestIds.slice(1)) {
        const [request] = await db
          .select({ userId: quickQueueRequests.userId })
          .from(quickQueueRequests)
          .where(eq(quickQueueRequests.id, requestId));
        if (request) userIds.add(request.userId);
      }
      for (const userId of userIds) {
        const response = await fetch(`${baseUrl}/emit`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            room: `quick-queue:user:${userId}`,
            event: event.eventType,
            payload: event.payload,
          }),
          signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) throw new Error(`Realtime relay returned ${response.status}`);
      }
    }, {
      onAssignmentAlert: async ({ userId, event }) => {
        await fetch(`${baseUrl}/emit`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            room: `quick-queue:user:${userId}`,
            event: "quick-queue:availability",
            payload: {
              ...event.payload,
              notification: "A compatible game is ready.",
            },
          }),
          signal: AbortSignal.timeout(3000),
        });
      },
    });
    return NextResponse.json({ success: true, result });
  } catch (error) {
    console.error("[quick-queue/publish] error:", error);
    return NextResponse.json({ success: false, error: "Publication failed" }, { status: 500 });
  }
}
