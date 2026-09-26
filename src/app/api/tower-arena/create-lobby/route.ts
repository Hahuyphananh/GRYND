import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../lib/logError";
import { createTowerArenaLobby } from "../../../../lib/tower-arena/serverStore";
import { normalizeStake } from "../../../../lib/games/stakes";

export async function POST(req: Request) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;
    const userId = gate.userId;
    const { wager = 10, maxPlayers = 2 } = await req.json().catch(() => ({}));
    // STAKES ARE RETIRED (src/lib/games/stakes.js): a lobby is free to open.
    // The requested wager is normalized to 0, so the host escrow is a no-op
    // and the match settles with no prize pool.
    const res: any = await createTowerArenaLobby({ userId, wager: normalizeStake(wager), maxPlayers: Number(maxPlayers) });
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