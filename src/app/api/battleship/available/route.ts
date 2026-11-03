// src/app/api/battleship/available/route.ts
//
// GET — open Battleship lobbies for the lobby screen, plus the caller's own
// waiting lobby (so the lobby can offer "resume"). Read-only and cheap; the
// lobby list is polled with a socket-aware backstop.
//
// Age-verified gate, same as matchmaking: only players who may actually join a
// lobby can see the list.

import { NextResponse } from "next/server";

import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../lib/logError";
import { listMyWaitingMatch, listOpenMatches } from "../../../../lib/battleship/serverStore";

export async function GET() {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthenticated" },
      { status: 401 },
    );
  }

  try {
    const [rows, mine] = await Promise.all([
      listOpenMatches({ limit: 30 }),
      listMyWaitingMatch({ userId }),
    ]);

    return NextResponse.json({
      success: true,
      data: rows.map((row) => ({
        matchId: row.id,
        player1Id: row.player1Id,
        phase: row.phase,
        createdAt: row.createdAt,
      })),
      myOpenMatchId: mine?.id ?? null,
    });
  } catch (error) {
    await logError({
      errorType: "battleship_available_error",
      errorMessage: error instanceof Error ? error.message : "Battleship lobby listing failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/battleship/available",
      game: "Battleship",
      metadata: { operation: "list_open_matches" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
