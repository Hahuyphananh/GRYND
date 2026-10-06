import { NextResponse } from "next/server";
import { requirePracticePlayer } from "../../../../lib/auth/guestSession";
import { logError } from "../../../../lib/logError";
import {
  advanceMatchOnPoll,
  getTowerArenaMatchProjection,
} from "../../../../lib/tower-arena/serverStore";

export async function GET(req: Request) {
  try {
    // A guest polls their own practice match here; the store's seat check
    // (getTowerArenaMatchProjection) is what limits it to that match.
    const gate = await requirePracticePlayer();
    if (gate.response) return gate.response;
    const userId = gate.playerId;
    if (!userId) return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
    const matchId = new URL(req.url).searchParams.get("matchId");
    if (!matchId) return NextResponse.json({ ok: false, message: "matchId is required" }, { status: 400 });

    // Auto-advance reserve-window / timeout progress (poll-driven).
    await advanceMatchOnPoll(String(matchId), userId);

    const res: any = await getTowerArenaMatchProjection({ userId, matchId: String(matchId) });
    if (res.error) {
      return NextResponse.json({ ok: false, message: res.error }, { status: res.status || 403 });
    }

    return NextResponse.json({ ok: true, match: res.match, players: res.players, me: res.me });
  } catch (error) {
    await logError({
      errorType: "tower_arena_get_match_error",
      errorMessage: error instanceof Error ? error.message : "Tower Arena get-match failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/tower-arena/get-match",
      game: "Tower Arena",
      metadata: { operation: "get_match" },
    });
    return NextResponse.json({ ok: false, message: "Unable to load match" }, { status: 500 });
  }
}