import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../lib/logError";
import { joinTowerArenaLobby } from "../../../../lib/tower-arena/serverStore";

export async function POST(req: Request) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;
    const userId = gate.userId;
    const { lobbyId, wager } = await req.json().catch(() => ({}));
    if (!lobbyId) return NextResponse.json({ ok: false, message: "lobbyId is required" }, { status: 400 });
    // The stake the joiner agreed to is verified against the lobby row, so a
    // stale or crafted request cannot drop a player into an entry they never
    // chose. Absent = no claim (an older client), and the lobby's own stake
    // still applies.
    const expectedWager =
      wager === undefined || wager === null || wager === "" ? null : Number(wager);
    const res: any = await joinTowerArenaLobby({
      userId,
      lobbyId: String(lobbyId),
      expectedWager,
    });
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