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
import {
  markPlayerReady,
  precisionMatchStore,
} from "../../../../lib/precision/serverStore";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    // ── IDOR hardening: identity comes from the Clerk session, never
    // from the request body. A malicious client can no longer mark
    // the OPPONENT ready (body.userId was previously trusted).
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
    // Only participants may ready up — a clean 403 beats a silent no-op.
    const match = precisionMatchStore.get(matchId);
    if (!match) {
      return NextResponse.json(
        { success: false, error: "Match not found." },
        { status: 404 },
      );
    }
    if (!match.players.some((p) => p.userId === userId)) {
      return NextResponse.json(
        { success: false, error: "Caller is not a participant in this match." },
        { status: 403 },
      );
    }
    const result = markPlayerReady(matchId, userId);
    if (!result.match) {
      return NextResponse.json(
        { success: false, error: "Match not found." },
        { status: 404 },
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
    return NextResponse.json(
      { success: false, error: (err as Error)?.message ?? "Unknown error" },
      { status: 500 },
    );
  }
}
