// src/app/api/barricade/available/route.ts
//
// GET — open Barricade lobbies for the lobby screen, plus the caller's own
// waiting lobby (so the lobby can offer "resume"). Read-only and cheap: the
// lobby list is polled with a socket-aware backstop, so there is no socket
// fan-out here.
//
// Age-verified gate, same as matchmaking: only players who may actually join a
// lobby can see the list.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../lib/logError";
import { listMyWaitingMatch, listOpenMatches } from "../../../../lib/barricade/serverStore";

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
        // Host id is shown as a short label in the lobby row — the same
        // convention every other lobby uses.
        player1Id: row.player1Id,
        status: row.status,
        createdAt: row.createdAt,
      })),
      myOpenMatchId: mine?.id ?? null,
    });
  } catch (error) {
    await logError({
      errorType: "barricade_available_error",
      errorMessage:
        error instanceof Error ? error.message : "Barricade lobby listing failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/barricade/available",
      game: "Barricade",
      metadata: { operation: "list_open_matches" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
