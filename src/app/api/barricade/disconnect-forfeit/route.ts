// src/app/api/barricade/disconnect-forfeit/route.ts
//
// POST /api/barricade/disconnect-forfeit
//
// Internal endpoint called by the realtime server once a Barricade
// participant's socket has stayed disconnected past the grace window (tab
// closed, long network drop). The store resolves the match:
//
//   • active match → the opponent is awarded the win (same settlement path as a
//     played-out victory, exactly once, reason `abandoned`)
//   • open lobby   → cancelled, so an abandoned lobby never lingers
//   • terminal     → no-op (idempotent, so the realtime retry loop stops)
//
// The Clerk session token the player authenticated their socket with is
// re-verified here, so this endpoint can only ever resolve the token owner's OWN
// match — it cannot be used to forfeit someone else's game. A reconnect inside
// the grace window cancels the timer before this is ever called.
//
// Mirrors /api/tic-tac-toe/disconnect-forfeit.

import { NextResponse } from "next/server";
import { verifyToken } from "@clerk/backend";
import {
  forfeitMatchOnDisconnect,
  isMatchId,
} from "../../../../lib/barricade/serverStore";
import { broadcastMatchUpdate } from "../../../../lib/barricade/rooms";

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

    // Guard the uuid cast so a malformed id is a 400, not a Postgres 500.
    if (!isMatchId(matchId)) {
      return NextResponse.json(
        { success: false, error: "Invalid matchId" },
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

    broadcastMatchUpdate(matchId, {
      status: result.match.status,
      result: result.match.result ?? null,
      winnerId: result.match.winnerId ?? null,
      resultReason: result.match.resultReason ?? null,
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
      "[barricade:disconnect-forfeit]",
      error instanceof Error ? error.stack : error,
    );
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
