// POST /api/precision/disconnect-forfeit
//
// Internal endpoint called by the realtime server when a precision
// participant's socket has stayed disconnected past the grace window
// (tab closed, long network drop). Forfeits the match to the opponent:
// phase → "finished", winnerSeat = opponent (identical to a natural
// match finish, so the opponent's polling client shows the win popup).
// No balances move — Precision's PvP wagering is not implemented yet.
//
// The Clerk session token the player authenticated their socket with
// is re-verified here, so only the token owner's own match can be
// forfeited — the endpoint can't be used to grief another player.
// Idempotent: already-finished matches return success without changes.

import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@clerk/backend";
import { forfeitMatch } from "../../../../lib/precision/serverStore";
import { logError } from "../../../../lib/logError";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const matchId = String(body?.matchId ?? "");
    const token = typeof body?.token === "string" ? body.token : "";

    if (!matchId || !token) {
      return NextResponse.json(
        { success: false, error: "Missing matchId or token" },
        { status: 400 },
      );
    }

    // ── Verify the socket's Clerk session token ─────────────────────────
    const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
    if (!CLERK_SECRET_KEY) {
      return NextResponse.json(
        { success: false, error: "Server authentication is not configured" },
        { status: 500 },
      );
    }
    let clerkUserId: string;
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

    const result = forfeitMatch(matchId, clerkUserId);
    if (!result.ok) {
      // Match not found / caller not a participant — nothing further to
      // do; return success so the realtime server stops retrying.
      return NextResponse.json({
        success: true,
        data: { forfeited: false, reason: result.reason },
      });
    }

    return NextResponse.json({
      success: true,
      data: { forfeited: true },
    });
  } catch (err) {
    console.error("[precision:disconnect-forfeit]", err);
    await logError({
      errorType: "precision_disconnect_forfeit_error",
      errorMessage: err instanceof Error ? err.message : "Precision disconnect forfeit failed",
      stackTrace: err instanceof Error ? err.stack : undefined,
      endpoint: "/api/precision/disconnect-forfeit",
      game: "Precision",
      metadata: { operation: "forfeit_match" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
