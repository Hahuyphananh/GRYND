// POST /api/precision/join-lobby
//
// Scaffold stub: looks up the lobby in `precisionLobbyStore` and, if there
// is room for a second player, creates a `PrecisionMatch` in
// `precisionMatchStore` keyed by `matchId = lobby.id`. Returns the
// matchId so the client can route to /casino/precision/game/[matchId].

import { NextRequest, NextResponse } from "next/server";
import {
  precisionLobbyStore,
  precisionMatchStore,
} from "../../../../lib/precision/serverStore";
import { makeInitialMatch } from "../../../../lib/precision/matchmaking";
import type { PrecisionPlayer } from "../../../../lib/precision/types";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const lobbyId = String(body?.lobbyId ?? "");
    const lobby = precisionLobbyStore.get(lobbyId);
    if (!lobby) {
      return NextResponse.json(
        { success: false, error: "Lobby not found." },
        { status: 404 },
      );
    }
    if (lobby.status !== "waiting") {
      return NextResponse.json(
        { success: false, error: "Lobby is no longer open." },
        { status: 409 },
      );
    }
    if (lobby.opponentUserId) {
      return NextResponse.json(
        { success: false, error: "Lobby is full." },
        { status: 409 },
      );
    }

    lobby.opponentUserId = body?.userId ?? "opponent";
    lobby.status = "active";

    const matchId = lobby.id;
    const players: PrecisionPlayer[] = [
      {
        seat: 1,
        userId: lobby.hostUserId,
        name: lobby.hostName ?? "Player 1",
        isReady: true,
        isConnected: true,
      },
      {
        seat: 2,
        userId: lobby.opponentUserId,
        name: "Player 2",
        isReady: true,
        isConnected: true,
      },
    ];

    // Use the shared constructor so the server-authoritative fields
    // (score, currentRound, targetMs, winnerSeat, lastRoundWinnerSeat)
    // are always initialised consistently across code paths.
    const match = makeInitialMatch(matchId, lobby.wager, players, "active", 1);
    precisionMatchStore.set(matchId, match);

    return NextResponse.json({
      success: true,
      matchId,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: (err as Error)?.message ?? "Unknown error" },
      { status: 500 },
    );
  }
}
