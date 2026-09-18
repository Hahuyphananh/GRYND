import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../lib/logError";
import { toggleTowerArenaReady } from "../../../../lib/tower-arena/serverStore";

export async function POST(req: Request) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;
    const userId = gate.userId;
    const { matchId } = await req.json().catch(() => ({}));
    if (!matchId) return NextResponse.json({ ok: false, message: "matchId is required" }, { status: 400 });
    const res: any = await toggleTowerArenaReady({ userId, matchId: String(matchId) });
    return NextResponse.json(
      {
        ok: !res.error,
        ready: Boolean(res.ready),
        countdownStarted: Boolean(res.countdownStarted),
        countdownCancelled: Boolean(res.countdownCancelled),
        error: res.error,
      },
      { status: res.status || (res.error ? 400 : 200) },
    );
  } catch (error) {
    await logError({
      errorType: "tower_arena_ready_error",
      errorMessage: error instanceof Error ? error.message : "Tower Arena ready toggle failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/tower-arena/ready",
      game: "Tower Arena",
      metadata: { operation: "toggle_ready" },
    });
    return NextResponse.json({ ok: false, message: "Unable to toggle ready" }, { status: 500 });
  }
}
