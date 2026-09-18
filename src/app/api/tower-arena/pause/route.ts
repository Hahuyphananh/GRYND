import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../lib/logError";
import { toggleMatchPause } from "../../../../lib/tower-arena/serverStore";

// POST /api/tower-arena/pause
// Toggle the free-play (human-vs-AI) pause: body { matchId, paused: boolean }.
// Only active participants of an AI match may pause; while paused the turn
// engine is frozen and the window refreshes on resume.
export async function POST(req: Request) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;
    const userId = gate.userId;
    const { matchId, paused } = await req.json().catch(() => ({}));
    if (!matchId || typeof paused !== "boolean") {
      return NextResponse.json({ ok: false, message: "matchId and paused (boolean) are required" }, { status: 400 });
    }
    const res: any = await toggleMatchPause({
      userId,
      matchId: String(matchId),
      paused,
    });
    return NextResponse.json(
      { ok: !res.error, paused: res.paused ?? null, error: res.error },
      { status: res.status || (res.error ? 400 : 200) },
    );
  } catch (error) {
    await logError({
      errorType: "tower_arena_pause_error",
      errorMessage: error instanceof Error ? error.message : "Tower Arena pause toggle failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/tower-arena/pause",
      game: "Tower Arena",
      metadata: { operation: "toggle_pause" },
    });
    return NextResponse.json({ ok: false, message: "Unable to toggle pause" }, { status: 500 });
  }
}