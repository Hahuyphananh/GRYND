import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import {
  cancelQuickQueueRequest,
  createQuickQueueRequest,
  listQuickQueueRequests,
} from "../../../lib/quickQueueStore";

export const dynamic = "force-dynamic";

function enabled() {
  return process.env.QUICK_QUEUE_ENABLED === "1";
}

function disabled() {
  return NextResponse.json({ success: false, error: "Quick Queue is disabled" }, { status: 404 });
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!enabled()) return disabled();
  const requests = await listQuickQueueRequests(userId);
  return NextResponse.json({ success: true, requests });
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!enabled()) return disabled();

  try {
    const body = await req.json().catch(() => ({}));
    const request = await createQuickQueueRequest({ ...body, userId });
    return NextResponse.json({ success: true, request }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Invalid request" }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!enabled()) return disabled();
  const requestId = req.nextUrl.searchParams.get("requestId") ?? "";
  if (!requestId) return NextResponse.json({ success: false, error: "requestId is required" }, { status: 400 });
  const request = await cancelQuickQueueRequest(userId, requestId);
  if (!request) return NextResponse.json({ success: false, error: "Queue request not found or already cancelled" }, { status: 404 });
  return NextResponse.json({ success: true, request });
}
