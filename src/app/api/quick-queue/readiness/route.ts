import { and, desc, eq } from "drizzle-orm";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { db } from "../../../../db";
import { quickQueueReadiness } from "../../../../db/schema";
import { cancelQuickQueueReadiness, setQuickQueueReadiness } from "../../../../lib/quickQueueReadinessStore";

export const dynamic = "force-dynamic";

function disabled() {
  return NextResponse.json({ success: false, error: "Quick Queue is disabled" }, { status: 404 });
}

async function getUserId() {
  return (await auth()).userId;
}

export async function GET() {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (process.env.QUICK_QUEUE_ENABLED !== "1") return disabled();

  const [readiness] = await db
    .select()
    .from(quickQueueReadiness)
    .where(and(eq(quickQueueReadiness.userId, userId), eq(quickQueueReadiness.status, "ready")))
    .orderBy(desc(quickQueueReadiness.updatedAt))
    .limit(1);

  if (readiness?.expiresAt && readiness.expiresAt <= new Date()) {
    await db
      .update(quickQueueReadiness)
      .set({ status: "expired", updatedAt: new Date() })
      .where(eq(quickQueueReadiness.id, readiness.id));
    return NextResponse.json({ success: true, ready: false, readiness: null });
  }

  return NextResponse.json({ success: true, ready: Boolean(readiness), readiness: readiness ?? null });
}

export async function POST(req: NextRequest) {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (process.env.QUICK_QUEUE_ENABLED !== "1") return disabled();

  try {
    const body = await req.json().catch(() => ({}));
    const result = await setQuickQueueReadiness({ ...body, userId });
    return NextResponse.json({ success: true, ready: true, ...result });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Invalid readiness request" }, { status: 400 });
  }
}

export async function DELETE() {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (process.env.QUICK_QUEUE_ENABLED !== "1") return disabled();

  const result = await cancelQuickQueueReadiness(userId);
  return NextResponse.json({ success: true, ready: false, ...result });
}
