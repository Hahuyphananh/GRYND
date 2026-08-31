import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { logError } from "../../../../lib/logError";
import { createTowerArenaLobby } from "../../../../lib/tower-arena/serverStore";

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
    const { wager = 10, maxPlayers = 2 } = await req.json().catch(() => ({}));
    const res: any = await createTowerArenaLobby({ userId, wager: Number(wager), maxPlayers: Number(maxPlayers) });
    return NextResponse.json({ ok: !res.error, match: res.match ?? null, error: res.error, message: res.error }, { status: res.status || 200 });
  } catch (error) {
    await logError({
      errorType: "tower_arena_lobby_creation_error",
      errorMessage: error instanceof Error ? error.message : "Tower Arena lobby creation failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/tower-arena/create-lobby",
      game: "Tower Arena",
      metadata: { operation: "create_lobby" },
    });
    return NextResponse.json({ ok: false, message: "Unable to create lobby" }, { status: 500 });
  }
}