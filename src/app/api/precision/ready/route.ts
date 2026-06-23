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
import { markPlayerReady } from "../../../../lib/precision/serverStore";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const matchId = String(body?.matchId ?? "");
    const userId = String(body?.userId ?? "");
    if (!matchId) {
      return NextResponse.json(
        { success: false, error: "Missing matchId." },
        { status: 400 },
      );
    }
    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Missing userId." },
        { status: 400 },
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
