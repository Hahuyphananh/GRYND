// POST /api/precision/create-lobby
//
// PvP-only matchmaking for the Precision reaction-time casino game.
// Auto-pairs two callers at the SAME wager or, if no waiting lobby is
// at that wager, enqueues a single waiting lobby so the caller can
// poll the public lobby list until someone joins.
//
// Solo practice lives client-side at `/casino/precision/test` and
// never touches this route — Precision's PvP wagering is
// intentionally the only entry point here so we don't fake a "vs AI"
// opponent that would be game-theoretically rigged.
//
// The response carries a unified `gameId` so the client has a single
// field to navigate to regardless of whether they were queued or
// matched.

import { NextRequest, NextResponse } from "next/server";
import { MIN_WAGER, MAX_WAGER } from "../../../../lib/precision/constants";
import { tryAutoMatch } from "../../../../lib/precision/matchmaking";

export const dynamic = "force-dynamic";

function clampWager(value: number): number {
  if (Number.isNaN(value)) return MIN_WAGER;
  return Math.max(MIN_WAGER, Math.min(MAX_WAGER, Math.floor(value)));
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const wager = clampWager(Number(body?.wager));
    const hostUserId = String(body?.hostUserId ?? "host");
    const hostName = String(body?.hostName ?? "Player 1");

    // PvP-only — any `gameMode` other than "pvp" is normalised away in
    // case a stale client still sends the legacy `"ai"` literal. Solo
    // practice goes through `/casino/precision/test` instead.
    const result = tryAutoMatch({ wager, hostUserId, hostName });

    if (result.status === "waiting") {
      return NextResponse.json({
        success: true,
        status: "waiting",
        gameId: result.gameId,
        lobbyId: result.gameId,
        matchId: null,
      });
    }

    // Matched PvP pair — the lobby id becomes the match id so both
    // players navigate to the same /casino/precision/game/[id] URL.
    return NextResponse.json({
      success: true,
      status: "matched",
      gameId: result.gameId,
      lobbyId: null,
      matchId: result.gameId,
      opponent: result.opponent,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: (err as Error)?.message ?? "Unknown error" },
      { status: 500 },
    );
  }
}
