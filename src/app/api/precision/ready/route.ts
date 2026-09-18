// POST /api/precision/ready
//
// Atomically marks a single player as Ready inside a `ready_up` match.
// When BOTH players have readied, advances the match to `phase: "active"`
// so polling clients see the transition on the next tick. The route is
// idempotent — re-clicking Ready from the same player is a no-op.
//
// Synchronisation via the realtime server still happens client-side:
//   1. The caller emits `room_event` with `precision:playerReady` so the
//      opponent sees the badge light up immediately.
//   2. When the response carries `bothReady: true`, the caller also emits
//      `precision:matchStart` over the same room so the opponent flips
//      to the active placeholder without waiting for the 1.5s poll.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { markPlayerReady } from "../../../../lib/precision/serverStore";
import { logError } from "../../../../lib/logError";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    // ── IDOR hardening: identity comes from the Clerk session, never
    // from the request body. A malicious client can no longer mark
    // the OPPONENT ready (body.userId was previously trusted).
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }
    const body = await req.json().catch(() => ({}));
    const matchId = String(body?.matchId ?? "");
    if (!matchId) {
      return NextResponse.json(
        { success: false, error: "Missing matchId." },
        { status: 400 },
      );
    }
    // The ready flag is flipped inside a `SELECT … FOR UPDATE` transaction,
    // so the "are we both ready?" check cannot race the opponent's click.
    // Being ready also (re)checks participation: a caller who is not seated
    // in the match leaves the row untouched, and we answer 403 below.
    const result = await markPlayerReady(matchId, userId);
    if (!result.match) {
      return NextResponse.json(
        { success: false, error: "Match not found." },
        { status: 404 },
      );
    }
    if (!result.match.players.some((p) => p.userId === userId)) {
      return NextResponse.json(
        { success: false, error: "Caller is not a participant in this match." },
        { status: 403 },
      );
    }
    return NextResponse.json({
      success: true,
      ready: result.playerReady,
      bothReady: result.bothReady,
      alreadyAdvanced: result.alreadyAdvanced,
      phase: result.match.phase,
      match: result.match,
    });
  } catch (err) {
    await logError({
      errorType: "precision_ready_error",
      errorMessage: err instanceof Error ? err.message : "Precision ready-up failed",
      stackTrace: err instanceof Error ? err.stack : undefined,
      endpoint: "/api/precision/ready",
      game: "Precision",
      metadata: { operation: "mark_player_ready" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
