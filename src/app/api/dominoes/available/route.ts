// src/app/api/dominoes/available/route.ts
//
// GET — open Dominoes lobbies for the lobby screen, plus the caller's own
// waiting lobby (so the lobby can offer "resume"). Read-only and cheap.
//
// The payload is deliberately tiny: a waiting row has no deal yet (the shuffle
// happens when the second seat lands), and there is nothing about a lobby that a
// list needs beyond its id, its host and its age.
//
// Age-verified gate, same as matchmaking: only players who may actually join a
// lobby can see the list.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../lib/logError";
import {
  listMyWaitingMatch,
  listOpenMatches,
} from "../../../../lib/dominoes/serverStore";

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
      errorType: "dominoes_available_error",
      errorMessage:
        error instanceof Error ? error.message : "Dominoes lobby listing failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/dominoes/available",
      game: "Dominoes",
      metadata: { operation: "list_open_matches" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
