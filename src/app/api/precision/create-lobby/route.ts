// POST /api/precision/create-lobby
//
// Lifts the scaffold stub to the project's actual matchmaking behaviour:
//   * `gameMode === "pvp"` — auto-pair with another player at the SAME
//     wager, otherwise enqueue a waiting lobby.
//   * `gameMode === "ai"`  — create a single-player match against the
//     "Precision AI" stub opponent.
// In both cases the response carries a unified `gameId` so the client has
// a single field to navigate to.

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
    const gameMode = body?.gameMode === "ai" ? "ai" : "pvp";
    const hostUserId = String(body?.hostUserId ?? "host");
    const hostName = String(body?.hostName ?? "Player 1");

    const result = tryAutoMatch({ wager, hostUserId, hostName, gameMode });

    if (result.status === "waiting") {
      return NextResponse.json({
        success: true,
        status: "waiting",
        gameId: result.gameId,
        lobbyId: result.gameId,
        matchId: null,
      });
    }

    // Matched paths (PvP pair or AI) — same shape, opponent metadata
    // differs.
    return NextResponse.json({
      success: true,
      status: gameMode === "ai" ? "ai" : "matched",
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
