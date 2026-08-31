import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { logError } from "../../../../lib/logError";
import { createAiTowerArenaMatch } from "../../../../lib/tower-arena/serverStore";

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
    const { maxPlayers = 2 } = await req.json().catch(() => ({}));
    // AI matches are free play — no tokens move.
    const res: any = await createAiTowerArenaMatch({ userId, maxPlayers: Number(maxPlayers) });
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