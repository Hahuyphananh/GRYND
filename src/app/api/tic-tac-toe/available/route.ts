// src/app/api/tic-tac-toe/available/route.ts
//
// GET — open Tic-Tac-Toe lobbies for the lobby screen. Read-only; the lobby
// list is cheap to refetch, so there is no socket fan-out here (matching the
// Mini Golf lobby's polling model).

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../lib/logError";
import { listOpenMatches } from "../../../../lib/tic-tac-toe/serverStore";

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
    const rows = await listOpenMatches({ limit: 30 });
    const data = rows.map((row) => ({
      matchId: row.id,
      player1Id: row.player1Id,
      status: row.status,
      createdAt: row.createdAt,
    }));
    return NextResponse.json({ success: true, data });
  } catch (error) {
    await logError({
      errorType: "tic_tac_toe_available_error",
      errorMessage:
        error instanceof Error
          ? error.message
          : "Tic-Tac-Toe lobby listing failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/tic-tac-toe/available",
      game: "Tic-Tac-Toe",
      metadata: { operation: "list_open_matches" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
