import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { logError } from "../../../../lib/logError";
import { joinTowerArenaLobby } from "../../../../lib/tower-arena/serverStore";

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
    const { lobbyId } = await req.json().catch(() => ({}));
    if (!lobbyId) return NextResponse.json({ ok: false, message: "lobbyId is required" }, { status: 400 });
    const res: any = await joinTowerArenaLobby({ userId, lobbyId: String(lobbyId) });
    return NextResponse.json(
      { ok: !res.error, match: res.match ?? null, started: Boolean(res.started), error: res.error },
      { status: res.status || 200 },
    );
  } catch (error) {
    await logError({
      errorType: "tower_arena_lobby_join_error",
      errorMessage: error instanceof Error ? error.message : "Tower Arena lobby join failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/tower-arena/join-lobby",
      game: "Tower Arena",
      metadata: { operation: "join_lobby" },
    });
    return NextResponse.json({ ok: false, message: "Unable to join lobby" }, { status: 500 });
  }
}