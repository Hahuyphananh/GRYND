// src/app/api/dice-duel/disconnect-forfeit/route.ts
//
// POST — internal endpoint called by the realtime server when a
// Dice Duel participant's socket has stayed disconnected past the
// grace window (tab closed, long network drop). Settles the match
// in the opponent's favor via the shared `resignDiceDuelMatch`
// store function. Idempotent — the store only settles `active`
// matches, so a retried / stale timer can never double-pay. The
// Clerk session token the player authenticated their socket with
// is re-verified here, so only the token owner's own match can be
// forfeited.

import { NextResponse } from "next/server";
import { verifyToken } from "@clerk/backend";
import { resignDiceDuelMatch } from "../../../../lib/dice-duel/serverStore";
import { logError } from "../../../../lib/logError";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const matchId = typeof body?.matchId === "string" ? body.matchId : "";
    const token = typeof body?.token === "string" ? body.token : "";

    if (!matchId || !token) {
      return NextResponse.json(
        { success: false, error: "Missing matchId or token" },
        { status: 400 },
      );
    }

    const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
    if (!CLERK_SECRET_KEY) {
      return NextResponse.json(
        { success: false, error: "Server authentication is not configured" },
        { status: 500 },
      );
    }
    let clerkUserId;
    try {
      const verified = await verifyToken(token, { secretKey: CLERK_SECRET_KEY });
      clerkUserId = verified.sub ?? "";
    } catch {
      return NextResponse.json(
        { success: false, error: "Invalid token" },
        { status: 401 },
      );
    }
    if (!clerkUserId) {
      return NextResponse.json(
        { success: false, error: "Invalid token" },
        { status: 401 },
      );
    }

    const result = await resignDiceDuelMatch({
      userId: clerkUserId,
      matchId,
    });
    if (!result.ok) {
      if (result.status === 403 || result.status === 404) {
        // Definitive — no retry will help; stop the realtime retry loop.
        return NextResponse.json({
          success: true,
          data: { forfeited: false, reason: result.message },
        });
      }
      return NextResponse.json(
        { success: false, error: result.message },
        { status: result.status || 400 },
      );
    }

    return NextResponse.json({
      success: true,
      data: { forfeited: true, matchId },
    });
  } catch (err) {
    await logError({
      errorType: "dice_duel_disconnect_forfeit_error",
      errorMessage: err instanceof Error ? err.message : "Dice Duel disconnect forfeit failed",
      stackTrace: err instanceof Error ? err.stack : undefined,
      endpoint: "/api/dice-duel/disconnect-forfeit",
      game: "Dice Duel",
      metadata: { operation: "disconnect_forfeit" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
