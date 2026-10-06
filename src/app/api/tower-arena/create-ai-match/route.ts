import { NextResponse } from "next/server";
import { requirePracticePlayer } from "../../../../lib/auth/guestSession";
import { logError } from "../../../../lib/logError";
import { createAiTowerArenaMatch } from "../../../../lib/tower-arena/serverStore";

export async function POST(req: Request) {
  try {
    // Free practice vs the bots is open to signed-out guests — this is the
    // only Tower Arena route that mints a guest identity. Everything a guest
    // can then reach is seat-checked by the store, and an AI match never
    // settles a rating, trophy or counter. Online play (/create-lobby,
    // /join-lobby) keeps the age gate.
    const gate = await requirePracticePlayer({ create: true });
    if (gate.response) return gate.response;
    const userId = gate.playerId;
    const { difficulty } = await req.json().catch(() => ({}));
    // AI matches are free play — no tokens move, and there is no seat count:
    // a 1v1 practice match is always the human plus one bot. `difficulty` is
    // the lobby picker's tier; the store coerces it (absent/invalid → normal).
    const res: any = await createAiTowerArenaMatch({ userId, difficulty });
    if (res.error) {
      return NextResponse.json({ ok: false, message: res.error }, { status: res.status || 400 });
    }
    return NextResponse.json({ ok: true, matchId: res.match?.id });
  } catch (error) {
    await logError({
      errorType: "tower_arena_create_ai_match_error",
      errorMessage: error instanceof Error ? error.message : "Tower Arena create AI match failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/tower-arena/create-ai-match",
      game: "Tower Arena",
      metadata: { operation: "create_ai_match" },
    });
    return NextResponse.json({ ok: false, message: "Unable to create AI match" }, { status: 500 });
  }
}