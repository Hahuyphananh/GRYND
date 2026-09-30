// src/app/api/solitaire-duel/disconnect-forfeit/route.ts
//
// POST /api/solitaire-duel/disconnect-forfeit
//
// Internal endpoint called by the realtime server when a Solitaire Duel
// participant's socket has stayed disconnected past the grace window (tab
// closed, long network drop). The authoritative store resolves the row:
//   • live race     → the seat still present is awarded the win, through the
//                     same settlement seam as a played-out victory
//   • open lobby    → cancelled, so an abandoned lobby never lingers
//   • terminal      → no-op, reported (not an error) so the retry loop stops
//
// The Clerk session token the player authenticated their socket with is
// re-verified here, so only a token's own owner can have their match resolved:
// the endpoint cannot be used to grieve another player.
//
// Reconnect safety: idempotent end to end. A player who reconnects inside the
// grace window never reaches this route (the realtime server cancels the timer
// when the socket re-joins the match room), and a late call against an
// already-resolved match writes nothing and settles nothing.

import { NextResponse } from "next/server";
import { verifyToken } from "@clerk/backend";
import { forfeitMatchOnDisconnect, isMatchId } from "../../../../lib/solitaire-duel/serverStore";
import { broadcastMatchUpdate } from "../../../../lib/solitaire-duel/rooms";

export const dynamic = "force-dynamic";

/** Store failures that are final — retrying them can never change the answer. */
const DEFINITIVE_STATUSES = new Set<number>([403, 404]);

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const matchId = typeof body?.matchId === "string" ? body.matchId : "";
    const token = typeof body?.token === "string" ? body.token : "";

    if (!matchId || !token) {
      return NextResponse.json(
        { success: false, error: "Missing matchId or token" },
        { status: 400 },
      );
    }
    if (!isMatchId(matchId)) {
      return NextResponse.json({ success: false, error: "Invalid matchId" }, { status: 400 });
    }

    const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
    if (!CLERK_SECRET_KEY) {
      return NextResponse.json(
        { success: false, error: "Server authentication is not configured" },
        { status: 500 },
      );
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

    const result = await forfeitMatchOnDisconnect({ userId: clerkUserId, matchId });
    if ("error" in result) {
      // The store's failure statuses are literal types (403 / 404), so a direct
      // equality check would narrow the tail branch to `never`; a membership
      // test keeps the branch reachable.
      if (DEFINITIVE_STATUSES.has(Number(result.status))) {
        return NextResponse.json({
          success: true,
          data: { forfeited: false, cancelled: false, reason: result.error },
        });
      }
      return NextResponse.json(
        { success: false, error: result.error },
        { status: Number(result.status) || 400 },
      );
    }

    // Best-effort push so the opponent sees the resolution without waiting for
    // the next poll (silently no-ops in separate-process deploys).
    broadcastMatchUpdate(matchId, {
      status: result.match.status,
      forfeited: result.forfeited === true,
      cancelled: result.cancelled === true,
      reason: "disconnect",
    });

    return NextResponse.json({
      success: true,
      data: {
        forfeited: result.forfeited === true,
        cancelled: result.cancelled === true,
      },
    });
  } catch (error) {
    console.error(
      "[solitaire-duel:disconnect-forfeit]",
      error instanceof Error ? error.stack : error,
    );
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
