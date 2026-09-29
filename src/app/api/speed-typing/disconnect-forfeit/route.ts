// src/app/api/speed-typing/disconnect-forfeit/route.ts
//
// POST /api/speed-typing/disconnect-forfeit
//
// Internal endpoint called by the realtime server when a Speed Typing
// participant's socket has stayed disconnected past the grace window (tab
// closed, long network drop). The authoritative store resolves the match:
//   • active race   → the seat still present is awarded the win (the same
//     settlement path as a played-out victory: the shared rating + trophy
//     writers, exactly once)
//   • open lobby    → cancelled, so an abandoned lobby never lingers
//   • terminal      → no-op (idempotent, so the realtime retry loop stops)
//
// The Clerk session token the player authenticated their socket with is
// re-verified here, so only the token owner's own match can be forfeited — the
// endpoint cannot be used to grieve another player. This mirrors
// /api/mini-golf/disconnect-forfeit exactly.
//
// Reconnect safety: the endpoint is idempotent end to end. A player who
// reconnects inside the grace window never reaches it (the realtime server
// cancels the timer on re-join), and a late call against an already-resolved
// match writes nothing and settles nothing.

import { NextResponse } from "next/server";
import { verifyToken } from "@clerk/backend";
import { forfeitMatch, isMatchId } from "../../../../lib/speed-typing/serverStore";
import { broadcastMatchUpdate } from "../../../../lib/speed-typing/realtime";

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

    // Guard the uuid cast so a malformed id is a 400, not a Postgres 500.
    if (!isMatchId(matchId)) {
      return NextResponse.json(
        { success: false, error: "Invalid matchId" },
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

    let clerkUserId = "";
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

    const result = await forfeitMatch({ userId: clerkUserId, matchId });
    if ("error" in result) {
      // The store's failure statuses are literal types (403 / 404), so a direct
      // equality check would narrow the tail branch to `never`; a membership
      // test keeps the branch reachable.
      if (DEFINITIVE_STATUSES.has(Number(result.status))) {
        // Definitive — no retry will help; stop the realtime retry loop.
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
      "[speed-typing:disconnect-forfeit]",
      error instanceof Error ? error.stack : error,
    );
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
