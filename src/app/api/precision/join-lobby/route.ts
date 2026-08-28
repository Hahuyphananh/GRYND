// POST /api/precision/join-lobby
//
// Scaffold stub: looks up the lobby in `precisionLobbyStore` and, if there
// is room for a second player, creates a `PrecisionMatch` in
// `precisionMatchStore` keyed by `matchId = lobby.id`. Returns the
// matchId so the client can route to /casino/precision/game/[matchId].

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  precisionLobbyStore,
  precisionMatchStore,
} from "../../../../lib/precision/serverStore";
import { makeInitialMatch } from "../../../../lib/precision/matchmaking";
import type { PrecisionPlayer } from "../../../../lib/precision/types";
import { mirrorPrecisionQueued } from "../../../../lib/precision/canonicalLifecycle";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    // ── IDOR hardening: the joining player's identity comes from the
    // Clerk session, never from the body — a client could previously
    // join a lobby as ANY user by sending a spoofed body.userId.
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }
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

    lobby.opponentUserId = userId;
    lobby.status = "active";

    const matchId = lobby.id;
    const players: PrecisionPlayer[] = [
      {
        seat: 1,
        userId: lobby.hostUserId,
        name: lobby.hostName ?? "Player 1",
        isReady: false,
        isConnected: true,
      },
      {
        seat: 2,
        userId: lobby.opponentUserId,
        name: "Player 2",
        isReady: false,
        isConnected: true,
      },
    ];

    // Create the match in `ready_up` (NOT `active`), exactly like the
    // auto-match path in `tryAutoMatch`. Both players must click Ready,
    // which triggers `armMatchRound` — the flow that rolls the per-round
    // target, stamps the roundId/roundNonce replay envelope, runs the
    // 5s countdown, and stamps roundGoInstant. Creating the match in
    // `active` directly left targetMs null ("—" forever), roundId/nonce
    // null (every STOP rejected with "Missing roundId"), and started the
    // timer with no warning — breaking the round for both players.
    const match = makeInitialMatch(matchId, lobby.wager, players, "ready_up", 1);
    precisionMatchStore.set(matchId, match);
    mirrorPrecisionQueued({
      matchId,
      playerCount: players.length,
      queuedAt: new Date(lobby.createdAt),
    });

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
