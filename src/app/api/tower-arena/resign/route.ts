import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../lib/logError";
import { removeParticipant } from "../../../../lib/tower-arena/serverStore";

export async function POST(req: Request) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;
    const userId = gate.userId;
    const { matchId } = await req.json().catch(() => ({}));
    if (!matchId) return NextResponse.json({ ok: false, message: "Missing matchId" }, { status: 400 });
    const res: any = await removeParticipant({ userId, matchId: String(matchId) });
    if (res.error) {
      return NextResponse.json({ ok: false, message: res.error }, { status: res.status || 400 });
    }
    return NextResponse.json({
      ok: true,
      matchFinished: Boolean(res.matchFinished || res.cancelled),
      // Mid-match resignation outcome — placement is the resigner's current
      // standing and the payout is already determined by it, so the client
      // can show the win/lose popup immediately.
      placement: res.placement ?? null,
      payout: res.payout ?? 0,
      net: res.net ?? 0,
      isWinner: Boolean(res.isWinner),
    });
  } catch (error) {
    await logError({
      errorType: "tower_arena_resign_error",
      errorMessage: error instanceof Error ? error.message : "Tower Arena resign failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/tower-arena/resign",
      game: "Tower Arena",
      metadata: { operation: "resign_match" },
    });
    return NextResponse.json({ ok: false, message: "Unable to resign" }, { status: 500 });
  }
}