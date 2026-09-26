// src/app/api/mini-golf/disconnect-forfeit/route.ts
//
// POST /api/mini-golf/disconnect-forfeit
//
// Internal endpoint called by the realtime server when a Mini Golf
// participant's socket has stayed disconnected past the grace window (tab
// closed, long network drop). The store resolves the match:
//   • active match  → opponent is awarded the win (same settlement path as a
//     played-out victory: existing rating + trophy infrastructure, exactly
//     once)
//   • open lobby    → cancelled, so an abandoned lobby never lingers
//   • terminal      → no-op (idempotent, so the realtime retry loop stops)
//
// The Clerk session token the player authenticated their socket with is
// re-verified here, so only the token owner's own match can be forfeited — the
// endpoint cannot be used to grieve another player.
//
// Mirrors /api/plinko-pvp/disconnect-forfeit.

import { NextResponse } from "next/server";
import { verifyToken } from "@clerk/backend";
import { forfeitMatchOnDisconnect } from "../../../../lib/mini-golf/serverStore";
import { broadcastMatchUpdate } from "../../../../lib/mini-golf/rooms";

export const dynamic = "force-dynamic";

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

    const result = await forfeitMatchOnDisconnect({
      userId: clerkUserId,
      matchId,
    });
    if ("error" in result) {
      if (result.status === 403 || result.status === 404) {
        // Definitive — no retry will help; stop the realtime retry loop.
        return NextResponse.json({
          success: true,
          data: { forfeited: false, cancelled: false, reason: result.error },
        });
      }
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    // Best-effort push so the opponent sees the resolution without waiting for
    // the next poll (silently no-ops in separate-process deploys).
    broadcastMatchUpdate(matchId, {
      status: result.match.status,
      forfeited: result.forfeited === true,
      cancelled: result.cancelled === true,
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
      "[mini-golf:disconnect-forfeit]",
      error instanceof Error ? error.stack : error,
    );
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
