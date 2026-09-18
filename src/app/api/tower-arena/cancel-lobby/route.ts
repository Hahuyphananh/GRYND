import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../lib/logError";
import { removeParticipant } from "../../../../lib/tower-arena/serverStore";

export async function POST(req: Request) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;
    const userId = gate.userId;
    const { lobbyId } = await req.json().catch(() => ({}));
    if (!lobbyId) return NextResponse.json({ ok: false, message: "Missing lobbyId" }, { status: 400 });
    const res: any = await removeParticipant({ userId, matchId: String(lobbyId) });
    if (res.error) {
      return NextResponse.json({ ok: false, message: res.error }, { status: res.status || 400 });
    }
    return NextResponse.json({ ok: true, cancelled: Boolean(res.cancelled) });
  } catch (error) {
    await logError({
      errorType: "tower_arena_cancel_lobby_error",
      errorMessage: error instanceof Error ? error.message : "Tower Arena cancel lobby failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/tower-arena/cancel-lobby",
      game: "Tower Arena",
      metadata: { operation: "cancel_lobby" },
    });
    return NextResponse.json({ ok: false, message: "Unable to cancel lobby" }, { status: 500 });
  }
}