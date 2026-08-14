// POST /api/keno-pvp/disconnect-forfeit
//
// Internal endpoint called by the realtime server when a keno-pvp
// participant's socket has stayed disconnected past the grace window
// (tab closed, long network drop). Resolves the match in the
// opponent's favor with the standard 90/10 payout (winner gets their
// stake back + 90% of the forfeiter's stake, house keeps 10%); a
// WAITING match with no opponent is cancelled and the creator's stake
// refunded. Idempotent — terminal matches are left untouched.
//
// Mirrors /api/slots-pvp/disconnect-forfeit exactly. The Clerk
// session token the player authenticated their socket with is
// re-verified here, so only the token owner's own match can be
// forfeited — the endpoint can't be used to grief another player.

import { NextResponse } from "next/server";
import { verifyToken } from "@clerk/backend";
import { forfeitMatch } from "../../../../lib/keno-pvp/serverStore";
import { broadcastMatchUpdate } from "../../../../lib/keno-pvp/rooms";

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

    const result = await forfeitMatch({ loserClerkId: clerkUserId, matchId });
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
  } catch (err) {
    console.error("[keno-pvp:disconnect-forfeit]", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
