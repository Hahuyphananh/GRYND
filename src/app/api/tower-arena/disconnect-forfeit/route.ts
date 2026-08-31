// src/app/api/tower-arena/disconnect-forfeit/route.ts
//
// POST — internal endpoint called by the realtime server when a Tower
// Arena participant's socket has stayed disconnected past the grace
// window. Places the player last (eliminates them); the remaining
// players keep playing, or the match finishes if only one is left.
// Idempotent — the store only works on non-terminal matches, so a retried
// / stale timer can never double-pay. The Clerk session token the socket
// authenticated with is re-verified here.

import { NextResponse } from "next/server";
import { verifyToken } from "@clerk/backend";
import { logError } from "../../../../lib/logError";
import { removeParticipant } from "../../../../lib/tower-arena/serverStore";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const matchId = typeof body?.matchId === "string" ? body.matchId : "";
    const token = typeof body?.token === "string" ? body.token : "";

    if (!matchId || !token) {
      return NextResponse.json({ success: false, error: "Missing matchId or token" }, { status: 400 });
    }

    const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
    if (!CLERK_SECRET_KEY) {
      return NextResponse.json({ success: false, error: "Server authentication is not configured" }, { status: 500 });
    }
    let clerkUserId = "";
    try {
      const verified = await verifyToken(token, { secretKey: CLERK_SECRET_KEY });
      clerkUserId = verified.sub ?? "";
    } catch {
      return NextResponse.json({ success: false, error: "Invalid token" }, { status: 401 });
    }
    if (!clerkUserId) {
      return NextResponse.json({ success: false, error: "Invalid token" }, { status: 401 });
    }

    const result: any = await removeParticipant({ userId: clerkUserId, matchId, reason: "disconnect" });
    if (result.error) {
      if (result.status === 403 || result.status === 404 || result.alreadyTerminal) {
        // Definitive — stop the realtime retry loop.
        return NextResponse.json({ success: true, data: { resigned: false, reason: result.error } });
      }
      return NextResponse.json({ success: false, error: result.error }, { status: result.status || 400 });
    }

    return NextResponse.json({ success: true, data: { resigned: true, matchId } });
  } catch (err) {
    await logError({
      errorType: "tower_arena_disconnect_forfeit_error",
      errorMessage: err instanceof Error ? err.message : "Tower Arena disconnect forfeit failed",
      stackTrace: err instanceof Error ? err.stack : undefined,
      endpoint: "/api/tower-arena/disconnect-forfeit",
      game: "Tower Arena",
      metadata: { operation: "disconnect_forfeit" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}