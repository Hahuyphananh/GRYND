// POST /api/mines-pvp/disconnect-forfeit
//
// Internal endpoint called by the realtime-server when a Mines participant's
// socket has stayed disconnected past the grace window (tab closed, long
// network drop). Mirrors `/api/keno-pvp/disconnect-forfeit`.
//
// Adapted for SIMULTANEOUS play (see `forfeitMatchOnDisconnect`):
//   • a temporary disconnect never awards a win — only the realtime grace
//     window triggers this, and a reconnect inside it cancels the timer;
//   • the forfeit never modifies a score or a board;
//   • a player who already CLEARED their board is NOT forfeited — the
//     opponent simply plays on to the match timer;
//   • a waiting lobby with no opponent is cancelled/refunded;
//   • an already-finished match is left untouched (idempotent).
//
// The Clerk session token the player authenticated their socket with is
// re-verified here, so only the token owner's own match can be forfeited — the
// endpoint can't be used to grief another player.

import { NextResponse } from "next/server";
import { verifyToken } from "@clerk/backend";
import { forfeitMatchOnDisconnect } from "../../../../lib/mines-pvp/serverStore";
import { broadcastMatchUpdate } from "../../../../lib/mines-pvp/rooms";

export const dynamic = "force-dynamic";

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const matchId = Number(body?.matchId);
    const token = typeof body?.token === "string" ? body.token : "";

    if (!Number.isFinite(matchId) || !token) {
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

    const result = await forfeitMatchOnDisconnect({
      loserClerkId: clerkUserId,
      matchId,
    });

    if (result.error) {
      if (result.status === 403 || result.status === 404) {
        // Definitive — no retry will help; stop the realtime retry loop.
        return NextResponse.json({
          success: true,
          data: { forfeited: false, reason: result.error },
        });
      }
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    broadcastMatchUpdate(matchId, {
      status: result.match?.status ?? null,
      winnerId: result.match?.winnerId ?? null,
      winReason: result.match?.winReason ?? null,
      forfeited: result.forfeited === true,
      cancelled: result.cancelled === true,
      disconnected: true,
    });

    return NextResponse.json({
      success: true,
      data: {
        forfeited: result.forfeited === true,
        cancelled: result.cancelled === true,
        ignored: result.ignored === true,
      },
    });
  } catch (err) {
    console.error("[mines-pvp:disconnect-forfeit]", err);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
