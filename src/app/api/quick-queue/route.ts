import { NextRequest, NextResponse } from "next/server";
import {
  PVP_GUEST_RATE_LIMITS,
  requirePvpPlayer,
} from "../../../lib/auth/guestPvp";
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
  // Account or verified guest — the identity ALWAYS comes from the session.
  const player = await requirePvpPlayer({
    rateLimit: { name: "queue-read", config: PVP_GUEST_RATE_LIMITS.read },
  });
  if (player.response) return player.response;
  if (!enabled()) return disabled();
  const requests = await listQuickQueueRequests(player.playerId as string);
  return NextResponse.json({ success: true, requests });
}

export async function POST(req: NextRequest) {
  const player = await requirePvpPlayer({
    create: true,
    rateLimit: { name: "queue-write", config: PVP_GUEST_RATE_LIMITS.write },
  });
  if (player.response) return player.response;
  if (!enabled()) return disabled();

  try {
    const body = await req.json().catch(() => ({}));
    // `userId` is written LAST so a body field can never override the session
    // identity — the same discipline the previous Clerk version had.
    const request = await createQuickQueueRequest({
      ...body,
      userId: player.playerId as string,
    });
    return NextResponse.json({ success: true, request }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Invalid request" }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const player = await requirePvpPlayer({
    rateLimit: { name: "queue-write", config: PVP_GUEST_RATE_LIMITS.write },
  });
  if (player.response) return player.response;
  if (!enabled()) return disabled();
  const requestId = req.nextUrl.searchParams.get("requestId") ?? "";
  if (!requestId) return NextResponse.json({ success: false, error: "requestId is required" }, { status: 400 });
  // Cancellation is scoped to the caller's own request id in the store, so one
  // identity can never cancel another's queue entry.
  const request = await cancelQuickQueueRequest(player.playerId as string, requestId);
  if (!request) return NextResponse.json({ success: false, error: "Queue request not found or already cancelled" }, { status: 404 });
  return NextResponse.json({ success: true, request });
}
