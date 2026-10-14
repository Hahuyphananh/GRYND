import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import {
  claimPoolLobbyForPair,
  findPoolMatchForLobby,
  POOL_UUID_RE,
} from "../../../../lib/pool/lobbyJoin";

export async function POST(req: Request) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const userId = gate.userId;
    if (!userId) {
      return NextResponse.json(
        { ok: false, message: "Unauthorized" },
        { status: 401 },
      );
    }

    const { lobbyId } = await req.json().catch(() => ({}));
    if (!lobbyId || !POOL_UUID_RE.test(String(lobbyId))) {
      return NextResponse.json(
        { ok: false, message: "Invalid lobby" },
        { status: 400 },
      );
    }

    // The claim + match insert live in src/lib/pool/lobbyJoin so the private-room
    // path creates a Pool match the exact same way (see that module's header).
    const claimed = await claimPoolLobbyForPair({
      lobbyId: String(lobbyId),
      opponentUserId: userId,
    });

    if (claimed.ok) {
      return NextResponse.json({
        ok: true,
        matchId: claimed.matchId,
        firstTurnSeat: claimed.firstTurnSeat,
      });
    }

    // A lobby that is no longer waiting may already be a match: a second click
    // (or a refresh) rejoins it instead of erroring.
    const existing = await findPoolMatchForLobby(String(lobbyId));
    if (existing) {
      return NextResponse.json({
        ok: true,
        matchId: existing.matchId,
        firstTurnSeat: existing.firstTurnSeat,
      });
    }

    return NextResponse.json(
      { ok: false, message: "Lobby unavailable" },
      { status: 400 },
    );
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, message: error?.message || "Unable to join lobby" },
      { status: 500 },
    );
  }
}
