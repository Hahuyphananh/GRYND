// src/app/api/battleship/disconnect-forfeit/route.ts
//
// POST /api/battleship/disconnect-forfeit
//
// Internal endpoint called by the realtime server once a Battleship participant
// has been away past the 30-second grace window. It mirrors
// /api/barricade/disconnect-forfeit:
//
//   • live match   → the seat still present is awarded the win (`abandoned`)
//   • open lobby   → cancelled, so an abandoned lobby never lingers
//   • terminal     → reported no-op, so the realtime retry loop stops
//
// The Clerk session token the socket authenticated with is re-verified here and
// the match id comes from the body, NEVER a user id — so this endpoint can only
// settle the token owner's own match and can never be used to forfeit someone
// else's game. The match state itself is untouched: the round, both fleets and
// the resolved attack log stay exactly as they were, which is what lets a
// reconnect inside the window find the same board.

import { NextResponse } from "next/server";
import { verifyToken } from "@clerk/backend";

import { logError } from "../../../../lib/logError";
import {
  forfeitMatchOnDisconnect,
  isMatchId,
} from "../../../../lib/battleship/serverStore";
import { publishForfeit } from "../../../../lib/battleship/publish";

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
    if (!isMatchId(matchId)) {
      return NextResponse.json(
        { success: false, error: "Invalid matchId" },
        { status: 400 },
      );
    }

    const secretKey = process.env.CLERK_SECRET_KEY;
    if (!secretKey) {
      return NextResponse.json(
        { success: false, error: "Server authentication is not configured" },
        { status: 500 },
      );
    }

    let clerkUserId = "";
    try {
      const verified = await verifyToken(token, { secretKey });
      clerkUserId = verified.sub ?? "";
    } catch {
      return NextResponse.json({ success: false, error: "Invalid token" }, { status: 401 });
    }
    if (!clerkUserId) {
      return NextResponse.json({ success: false, error: "Invalid token" }, { status: 401 });
    }

    const result = await forfeitMatchOnDisconnect({ userId: clerkUserId, matchId });
    if ("error" in result) {
      if (result.status === 403 || result.status === 404) {
        // Definitive: no retry will help, so stop the realtime retry loop.
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

    // The winner is the seat the STORE recorded (never a value from the body).
    const winnerSeat =
      result.match.result === "player1" || result.match.result === "player2"
        ? result.match.result
        : null;
    publishForfeit({
      matchId,
      seat: result.cancelled ? null : winnerSeat,
      reason: "abandoned",
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
    await logError({
      errorType: "battleship_disconnect_forfeit_error",
      errorMessage:
        error instanceof Error ? error.message : "Battleship disconnect forfeit failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/battleship/disconnect-forfeit",
      game: "Battleship",
      metadata: { operation: "disconnect_forfeit" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
