import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../lib/logError";
import { playAiTurn } from "../../../../lib/tower-arena/serverStore";

export async function POST(req: Request) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;
    const userId = gate.userId;
    const { matchId } = await req.json().catch(() => ({}));
    if (!matchId) return NextResponse.json({ ok: false, message: "Missing matchId" }, { status: 400 });
    const res: any = await playAiTurn({ matchId: String(matchId) });
    if (res.error) {
      if (res.status === 403 || res.error === "Not in placement phase") {
        // Not a terminal problem for the requester.
        return NextResponse.json({ ok: false, message: res.error }, { status: res.status || 400 });
      }
      return NextResponse.json({ ok: false, message: res.error }, { status: res.status || 400 });
    }
    return NextResponse.json({ ok: true, collapsed: Boolean(res.collapsed), matchFinished: Boolean(res.matchFinished) });
  } catch (error) {
    await logError({
      errorType: "tower_arena_ai_turn_error",
      errorMessage: error instanceof Error ? error.message : "Tower Arena AI turn failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/tower-arena/ai-turn",
      game: "Tower Arena",
      metadata: { operation: "ai_turn" },
    });
    return NextResponse.json({ ok: false, message: "Unable to run AI turn" }, { status: 500 });
  }
}