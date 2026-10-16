import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../lib/logError";
import { createTowerArenaLobby } from "../../../../lib/tower-arena/serverStore";
import { requireStake } from "../../../../lib/games/stakes";

export async function POST(req: Request) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;
    const userId = gate.userId;
    // A seat count is no longer part of the request: Tower Arena is 1v1, so
    // the store always opens a two-seat lobby.
    const body = await req.json().catch(() => ({}));
    // A ranked lobby always plays for coins, so the requested wager is REQUIRED
    // and must be legal: a crafted request can never open a free-to-enter
    // lobby whose winner would be paid nothing. The seats are still escrowed
    // only when the second player joins.
    const wager = requireStake(body?.wager, "tower-arena");
    if (!wager.ok) {
      return NextResponse.json(
        { ok: false, error: wager.error, code: wager.code },
        { status: wager.status },
      );
    }
    const res: any = await createTowerArenaLobby({ userId, wager: wager.stake });
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